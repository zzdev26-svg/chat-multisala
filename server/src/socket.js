import { db } from './db/index.js';
import { insertMessage, editMessage, deleteMessage, toggleReaction } from './db/messages.js';
import { isDmMember, listDmRoomIdsForUser } from './db/rooms.js';
import { verifyToken } from './utils/jwt.js';

const ALLOWED_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '🎉']);

// roomId -> Map<socketId, { id, username, isGuest }>
const roomPresence = new Map();

// userId -> Set<socketId>, so a REST endpoint (e.g. "start a DM") can reach
// a user's live connections without going through a room.
const userSockets = new Map();

// userId -> { lat, lng }. In-memory only, opt-in, and never persisted to
// disk — cleared the moment a user disables sharing or their last
// connection drops. Nothing here is exposed to clients directly; only the
// coarse bucket computed from it (see distanceBucket) ever leaves the
// server, so two people opted in can't compare notes to triangulate a
// precise location out of it.
const userLocations = new Map();

let io = null;

// Approximate rings rather than a precise figure — a few readings from
// different spots would otherwise let someone triangulate an exact
// location out of "you are 2.35km from me" style numbers.
const DISTANCE_BUCKETS = [
  { max: 1, bucket: 0, label: 'Muy cerca' },
  { max: 5, bucket: 1, label: 'Cerca' },
  { max: 20, bucket: 2, label: 'En la zona' },
  { max: Infinity, bucket: 3, label: 'Lejos' },
];

function distanceBucket(km) {
  return DISTANCE_BUCKETS.find((b) => km < b.max);
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Personalized per viewer: proximity is only ever computed relative to the
// *viewer's own* opted-in location, and only for other users who also
// opted in. Nearest-first when the viewer has a location; otherwise
// unaffected (no one gets sorted or badged).
function getRoomUsers(roomId, viewerUserId) {
  const map = roomPresence.get(roomId);
  if (!map) return [];
  const viewerLoc = viewerUserId != null ? userLocations.get(viewerUserId) : null;

  const seen = new Set();
  const users = [];
  for (const u of map.values()) {
    if (seen.has(u.username)) continue;
    seen.add(u.username);

    let proximity = null;
    if (viewerLoc && u.id !== viewerUserId) {
      const targetLoc = userLocations.get(u.id);
      if (targetLoc) {
        const { bucket, label } = distanceBucket(haversineKm(viewerLoc, targetLoc));
        proximity = { bucket, label };
      }
    }
    users.push({ username: u.username, isGuest: u.isGuest, proximity });
  }

  users.sort((a, b) => (a.proximity?.bucket ?? 99) - (b.proximity?.bucket ?? 99));
  return users;
}

// room:presence can't be a single shared broadcast once it's personalized —
// each socket in the room gets its own view of who's near *them*.
function broadcastPresence(roomId) {
  const socketIds = io?.sockets.adapter.rooms.get(`room:${roomId}`);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('room:presence', { roomId, users: getRoomUsers(roomId, sock.user.id) });
  }
}

function addPresence(roomId, socketId, user) {
  if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Map());
  roomPresence.get(roomId).set(socketId, user);
}

function removePresence(roomId, socketId) {
  const map = roomPresence.get(roomId);
  if (!map) return;
  map.delete(socketId);
  if (map.size === 0) roomPresence.delete(roomId);
}

function isDmRoom(roomId) {
  return !!db.prepare('SELECT is_dm FROM rooms WHERE id = ?').get(roomId)?.is_dm;
}

// Wraps a handler so a thrown/DB error never crashes the whole server —
// it's reported back to that one client instead.
function safeOn(socket, event, handler) {
  socket.on(event, (...args) => {
    try {
      handler(...args);
    } catch (err) {
      console.error(`Error manejando el evento "${event}":`, err);
      socket.emit('error:message', 'Ocurrio un error inesperado. Intenta de nuevo.');
    }
  });
}

export function registerSocketHandlers(server) {
  io = server;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No autenticado'));
    try {
      const payload = verifyToken(token);
      // Re-check against the DB (not just the JWT claims): the user may have
      // been deleted, or the dev DB reset, since the token was issued.
      const user = db.prepare('SELECT id, username, is_guest FROM users WHERE id = ?').get(payload.id);
      if (!user || user.username !== payload.username) {
        return next(new Error('Sesion invalida, volve a iniciar sesion.'));
      }
      socket.user = { id: user.id, username: user.username, isGuest: !!user.is_guest };
      next();
    } catch {
      next(new Error('Token invalido o expirado'));
    }
  });

  io.on('connection', (socket) => {
    const currentRooms = new Set();
    // Exposed on the socket so notifyUserOfNewDm (called from the REST
    // layer, outside this closure) can add a freshly-created DM room to it.
    socket.data.currentRooms = currentRooms;

    if (!userSockets.has(socket.user.id)) userSockets.set(socket.user.id, new Set());
    userSockets.get(socket.user.id).add(socket.id);

    // DMs are always "live" for their two participants — join every DM room
    // this user belongs to right away, independent of which panels their
    // client happens to have open. That's what lets a message (or the
    // unread indicator for it) reach them without opening that chat first.
    for (const roomId of listDmRoomIdsForUser(socket.user.id)) {
      socket.join(`room:${roomId}`);
      currentRooms.add(roomId);
      addPresence(roomId, socket.id, socket.user);
    }

    safeOn(socket, 'room:join', (roomId) => {
      roomId = Number(roomId);
      const room = db.prepare('SELECT id, name, is_dm FROM rooms WHERE id = ?').get(roomId);
      if (!room) {
        socket.emit('error:message', 'Sala no encontrada.');
        return;
      }
      if (room.is_dm && !isDmMember(roomId, socket.user.id)) {
        socket.emit('error:message', 'No tenes acceso a este chat privado.');
        return;
      }

      socket.join(`room:${roomId}`);
      currentRooms.add(roomId);
      addPresence(roomId, socket.id, socket.user);

      socket.emit('room:joined', { roomId, room });
      broadcastPresence(roomId);
    });

    safeOn(socket, 'room:leave', (roomId) => {
      roomId = Number(roomId);
      // DM membership isn't a UI concern: a participant stays "in" a private
      // chat for as long as they're connected, so closing that panel must
      // not stop messages from arriving (that's what makes the unread
      // indicator on an unopened DM possible).
      const room = db.prepare('SELECT is_dm FROM rooms WHERE id = ?').get(roomId);
      if (room?.is_dm) return;

      socket.leave(`room:${roomId}`);
      currentRooms.delete(roomId);
      removePresence(roomId, socket.id);
      broadcastPresence(roomId);
    });

    safeOn(socket, 'message:send', ({ roomId, content }) => {
      roomId = Number(roomId);
      if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
        socket.emit('error:message', 'Mensaje invalido.');
        return;
      }
      if (!currentRooms.has(roomId)) {
        socket.emit('error:message', 'No estas conectado a esa sala.');
        return;
      }

      // Read the sender's current color fresh from the DB (not a cached
      // value on the socket) so a color change applies to the very next
      // message without needing to reconnect.
      const profile = db.prepare('SELECT text_color, bg_color FROM users WHERE id = ?').get(socket.user.id);
      const message = insertMessage(roomId, socket.user.id, socket.user.username, content.trim(), {
        textColor: profile?.text_color ?? null,
        bgColor: profile?.bg_color ?? null,
      });
      io.to(`room:${roomId}`).emit('message:new', { roomId, message });
    });

    safeOn(socket, 'message:edit', ({ roomId, messageId, content }) => {
      roomId = Number(roomId);
      messageId = Number(messageId);
      if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
        socket.emit('error:message', 'Mensaje invalido.');
        return;
      }
      if (!currentRooms.has(roomId)) return;

      const message = editMessage(messageId, socket.user.id, content.trim());
      if (!message) {
        socket.emit('error:message', 'No se pudo editar el mensaje.');
        return;
      }
      io.to(`room:${roomId}`).emit('message:updated', { roomId, message });
    });

    safeOn(socket, 'message:delete', ({ roomId, messageId }) => {
      roomId = Number(roomId);
      messageId = Number(messageId);
      if (!currentRooms.has(roomId)) return;

      const message = deleteMessage(messageId, socket.user.id);
      if (!message) {
        socket.emit('error:message', 'No se pudo eliminar el mensaje.');
        return;
      }
      io.to(`room:${roomId}`).emit('message:updated', { roomId, message });
    });

    safeOn(socket, 'message:reaction', ({ roomId, messageId, emoji }) => {
      roomId = Number(roomId);
      messageId = Number(messageId);
      if (!ALLOWED_EMOJIS.has(emoji) || !currentRooms.has(roomId)) return;

      const message = toggleReaction(messageId, socket.user.id, socket.user.username, emoji);
      if (!message) return;
      io.to(`room:${roomId}`).emit('message:updated', { roomId, message });
    });

    // Admin-only, public rooms only: forces the target out of the room right
    // now (closes their panel, drops their socket from the channel) — no
    // ban, they're free to rejoin immediately, same as a Discord "kick".
    safeOn(socket, 'room:kick', ({ roomId, username }) => {
      roomId = Number(roomId);
      const admin = db.prepare('SELECT role FROM users WHERE id = ?').get(socket.user.id);
      if (admin?.role !== 'admin') {
        socket.emit('error:message', 'Necesitas permisos de administrador para esto.');
        return;
      }

      const room = db.prepare('SELECT is_dm FROM rooms WHERE id = ?').get(roomId);
      if (!room || room.is_dm) return;

      const map = roomPresence.get(roomId);
      const targets = map ? [...map.entries()].filter(([, u]) => u.username === username) : [];
      if (targets.length === 0) {
        socket.emit('error:message', 'Ese usuario no esta en la sala.');
        return;
      }

      for (const [socketId] of targets) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (!targetSocket) continue;
        targetSocket.leave(`room:${roomId}`);
        targetSocket.data.currentRooms?.delete(roomId);
        removePresence(roomId, socketId);
        targetSocket.emit('room:kicked', { roomId, by: socket.user.username });
      }

      broadcastPresence(roomId);
    });

    safeOn(socket, 'typing', ({ roomId, isTyping }) => {
      roomId = Number(roomId);
      if (!currentRooms.has(roomId)) return;
      socket.to(`room:${roomId}`).emit('typing', {
        roomId,
        username: socket.user.username,
        isTyping: !!isTyping,
      });
    });

    // Opt-in "nearby users": share a fresh reading, or turn sharing off.
    // Affects every room this socket is currently in, since proximity to
    // everyone there just became knowable (or stopped being knowable).
    safeOn(socket, 'location:update', ({ lat, lng } = {}) => {
      if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      userLocations.set(socket.user.id, { lat, lng });
      for (const roomId of currentRooms) broadcastPresence(roomId);
    });

    safeOn(socket, 'location:disable', () => {
      userLocations.delete(socket.user.id);
      for (const roomId of currentRooms) broadcastPresence(roomId);
    });

    // WebRTC camera-call signaling (DM rooms only — always exactly 2
    // participants, so relaying to "the room" reaches only the other side).
    // The server never looks inside the SDP/ICE payloads, it just forwards
    // them between the two peers.
    function safeOnCall(event, handler) {
      safeOn(socket, event, (payload) => {
        const roomId = Number(typeof payload === 'object' && payload !== null ? payload.roomId : payload);
        if (!currentRooms.has(roomId) || !isDmRoom(roomId)) return;
        handler(roomId, payload);
      });
    }

    safeOnCall('call:invite', (roomId) => {
      socket.to(`room:${roomId}`).emit('call:invite', { roomId, from: socket.user.username });
    });

    safeOnCall('call:accept', (roomId) => {
      socket.to(`room:${roomId}`).emit('call:accept', { roomId, from: socket.user.username });
    });

    safeOnCall('call:reject', (roomId) => {
      socket.to(`room:${roomId}`).emit('call:reject', { roomId, from: socket.user.username });
    });

    safeOnCall('call:end', (roomId) => {
      socket.to(`room:${roomId}`).emit('call:end', { roomId, from: socket.user.username });
    });

    safeOnCall('call:signal', (roomId, { data }) => {
      socket.to(`room:${roomId}`).emit('call:signal', { roomId, data, from: socket.user.username });
    });

    socket.on('disconnect', () => {
      const sockets = userSockets.get(socket.user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(socket.user.id);
          // Only wipe the shared location once every tab/session for this
          // user is gone — one tab closing shouldn't blind the others.
          userLocations.delete(socket.user.id);
        }
      }

      for (const roomId of currentRooms) {
        removePresence(roomId, socket.id);
        broadcastPresence(roomId);
        // Don't leave the other side hanging mid-call if we vanish.
        if (isDmRoom(roomId)) {
          socket.to(`room:${roomId}`).emit('call:end', { roomId, from: socket.user.username });
        }
      }
    });
  });
}

// Called from the REST layer right after a brand-new DM room is created.
// Pushes it live to the *other* participant if they're currently connected:
// joins their socket(s) to the room and lets their UI add it to the "Mensajes
// directos" list with an unread marker, with no page reload required.
export function notifyUserOfNewDm(targetUserId, room, senderInfo) {
  const socketIds = userSockets.get(targetUserId);
  if (!socketIds || !io) return;

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    socket.join(`room:${room.id}`);
    socket.data.currentRooms?.add(room.id);
    addPresence(room.id, socketId, socket.user);

    socket.emit('dm:new', {
      room: { id: room.id, otherUsername: senderInfo.username, otherIsGuest: !!senderInfo.isGuest },
    });
  }

  broadcastPresence(room.id);
}
