import { pool } from './db/index.js';
import { insertMessage, editMessage, deleteMessage, toggleReaction } from './db/messages.js';
import {
  canAccessDmRoom,
  listAllSupportRoomIds,
  listDmRoomIdsForUser,
  listSupportRoomIdsForUser,
} from './db/rooms.js';
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
async function getRoomUsers(roomId, viewerUserId) {
  const map = roomPresence.get(roomId) || new Map();
  const viewerLoc = viewerUserId != null ? userLocations.get(viewerUserId) : null;

  const seen = new Set();
  const entries = [];
  for (const u of map.values()) {
    if (seen.has(u.username)) continue;
    seen.add(u.username);
    entries.push(u);
  }

  // Role is queried fresh (not cached on the socket from connect time) so a
  // promotion shows up on the very next presence broadcast, not just after
  // the promoted user reconnects.
  const roleById = new Map();
  if (entries.length > 0) {
    const ids = entries.map((u) => u.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(`SELECT id, role FROM users WHERE id IN (${placeholders})`, ids);
    for (const row of rows) roleById.set(row.id, row.role);
  }

  let users = entries.map((u) => {
    let proximity = null;
    if (viewerLoc && u.id !== viewerUserId) {
      const targetLoc = userLocations.get(u.id);
      if (targetLoc) {
        const { bucket, label } = distanceBucket(haversineKm(viewerLoc, targetLoc));
        proximity = { bucket, label };
      }
    }
    return { username: u.username, isGuest: u.isGuest, isAdmin: roleById.get(u.id) === 'admin', proximity };
  });

  users.sort((a, b) => (a.proximity?.bucket ?? 99) - (b.proximity?.bucket ?? 99));

  // Regular users don't see which admins are actually online — the virtual
  // support contact below is the only "admin-ish" presence they get, kept
  // consistent with how support replies mask the admin's real identity.
  // Admins still see each other (and everyone else) fully, since they need
  // that to kick/promote.
  let viewerRole = null;
  if (viewerUserId != null) {
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [viewerUserId]);
    viewerRole = rows[0]?.role ?? null;
  }
  if (viewerRole !== 'admin') {
    users = users.filter((u) => !u.isAdmin);
  }

  // Every public room shows a virtual "contact support" entry named after
  // the room itself — not a real connection, just a way for anyone to reach
  // whichever admins are around. Always first, never sorted by proximity.
  const { rows: roomRows } = await pool.query('SELECT is_dm, name FROM rooms WHERE id = $1', [roomId]);
  const room = roomRows[0];
  if (room && !room.is_dm) {
    users.unshift({ username: room.name, isGuest: false, isAdmin: false, isSupportContact: true, proximity: null });
  }

  return users;
}

// room:presence can't be a single shared broadcast once it's personalized —
// each socket in the room gets its own view of who's near *them*.
async function broadcastPresence(roomId) {
  const socketIds = io?.sockets.adapter.rooms.get(`room:${roomId}`);
  if (!socketIds) return;
  for (const socketId of socketIds) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('room:presence', { roomId, users: await getRoomUsers(roomId, sock.user.id) });
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

async function isDmRoom(roomId) {
  const { rows } = await pool.query('SELECT is_dm FROM rooms WHERE id = $1', [roomId]);
  return !!rows[0]?.is_dm;
}

// Wraps a handler so a thrown/DB error never crashes the whole server —
// it's reported back to that one client instead. Awaits the handler so a
// rejected promise (every handler is async now that DB calls go through
// pg) is caught too, not just a synchronous throw.
function safeOn(socket, event, handler) {
  socket.on(event, async (...args) => {
    try {
      await handler(...args);
    } catch (err) {
      console.error(`Error manejando el evento "${event}":`, err);
      socket.emit('error:message', 'Ocurrio un error inesperado. Intenta de nuevo.');
    }
  });
}

export function registerSocketHandlers(server) {
  io = server;

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No autenticado'));
    try {
      const payload = verifyToken(token);
      // Re-check against the DB (not just the JWT claims): the user may have
      // been deleted, or the dev DB reset, since the token was issued.
      const { rows } = await pool.query('SELECT id, username, is_guest FROM users WHERE id = $1', [payload.id]);
      const user = rows[0];
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
    // Support threads work the same way: their own if they're a regular
    // user, or *every* open thread system-wide if they're currently an
    // admin — that's what makes it a shared inbox.
    //
    // Run as a detached async task instead of blocking on it here — the
    // event listeners below need to be attached synchronously so a message
    // sent right after connecting isn't dropped while this is still awaiting.
    (async () => {
      const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [socket.user.id]);
      const isAdmin = rows[0]?.role === 'admin';
      const liveRoomIds = [
        ...(await listDmRoomIdsForUser(socket.user.id)),
        ...(isAdmin ? await listAllSupportRoomIds() : await listSupportRoomIdsForUser(socket.user.id)),
      ];
      for (const roomId of liveRoomIds) {
        socket.join(`room:${roomId}`);
        currentRooms.add(roomId);
        addPresence(roomId, socket.id, socket.user);
      }
    })().catch((err) => {
      console.error('Error uniendo el socket a sus salas DM/soporte al conectar:', err);
    });

    safeOn(socket, 'room:join', async (roomId) => {
      roomId = Number(roomId);
      const { rows: roomRows } = await pool.query('SELECT id, name, is_dm FROM rooms WHERE id = $1', [roomId]);
      const room = roomRows[0];
      if (!room) {
        socket.emit('error:message', 'Sala no encontrada.');
        return;
      }
      if (room.is_dm) {
        const { rows: roleRows } = await pool.query('SELECT role FROM users WHERE id = $1', [socket.user.id]);
        if (!(await canAccessDmRoom(roomId, socket.user.id, roleRows[0]?.role))) {
          socket.emit('error:message', 'No tenes acceso a este chat privado.');
          return;
        }
      }

      socket.join(`room:${roomId}`);
      currentRooms.add(roomId);
      addPresence(roomId, socket.id, socket.user);

      socket.emit('room:joined', { roomId, room });
      await broadcastPresence(roomId);
    });

    safeOn(socket, 'room:leave', async (roomId) => {
      roomId = Number(roomId);
      // DM membership isn't a UI concern: a participant stays "in" a private
      // chat for as long as they're connected, so closing that panel must
      // not stop messages from arriving (that's what makes the unread
      // indicator on an unopened DM possible).
      const { rows } = await pool.query('SELECT is_dm FROM rooms WHERE id = $1', [roomId]);
      if (rows[0]?.is_dm) return;

      socket.leave(`room:${roomId}`);
      currentRooms.delete(roomId);
      removePresence(roomId, socket.id);
      await broadcastPresence(roomId);
    });

    safeOn(socket, 'message:send', async ({ roomId, content }) => {
      roomId = Number(roomId);
      if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
        socket.emit('error:message', 'Mensaje invalido.');
        return;
      }
      if (!currentRooms.has(roomId)) {
        socket.emit('error:message', 'No estas conectado a esa sala.');
        return;
      }

      // Inside a "contact support" thread, any *current* admin's reply
      // automatically shows under the public room's own name instead of
      // theirs — no per-message opt-in, fully server-derived (never trust a
      // client-sent flag for this). user_id still points at the real admin,
      // so edit/delete ownership of that message is unaffected.
      let username = socket.user.username;
      let isSupport = false;
      const { rows: roomRows } = await pool.query('SELECT support_for_room_id FROM rooms WHERE id = $1', [roomId]);
      const room = roomRows[0];
      if (room?.support_for_room_id != null) {
        const { rows: senderRows } = await pool.query('SELECT role FROM users WHERE id = $1', [socket.user.id]);
        if (senderRows[0]?.role === 'admin') {
          const { rows: publicRoomRows } = await pool.query('SELECT name FROM rooms WHERE id = $1', [
            room.support_for_room_id,
          ]);
          if (publicRoomRows[0]) {
            username = publicRoomRows[0].name;
            isSupport = true;
          }
        }
      }

      // Read the sender's current color fresh from the DB (not a cached
      // value on the socket) so a color change applies to the very next
      // message without needing to reconnect.
      const { rows: profileRows } = await pool.query('SELECT text_color, bg_color FROM users WHERE id = $1', [
        socket.user.id,
      ]);
      const profile = profileRows[0];
      const message = await insertMessage(roomId, socket.user.id, username, content.trim(), {
        textColor: profile?.text_color ?? null,
        bgColor: profile?.bg_color ?? null,
        isSupport,
      });
      io.to(`room:${roomId}`).emit('message:new', { roomId, message });
    });

    safeOn(socket, 'message:edit', async ({ roomId, messageId, content }) => {
      roomId = Number(roomId);
      messageId = Number(messageId);
      if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
        socket.emit('error:message', 'Mensaje invalido.');
        return;
      }
      if (!currentRooms.has(roomId)) return;

      const message = await editMessage(messageId, socket.user.id, content.trim());
      if (!message) {
        socket.emit('error:message', 'No se pudo editar el mensaje.');
        return;
      }
      io.to(`room:${roomId}`).emit('message:updated', { roomId, message });
    });

    safeOn(socket, 'message:delete', async ({ roomId, messageId }) => {
      roomId = Number(roomId);
      messageId = Number(messageId);
      if (!currentRooms.has(roomId)) return;

      const message = await deleteMessage(messageId, socket.user.id);
      if (!message) {
        socket.emit('error:message', 'No se pudo eliminar el mensaje.');
        return;
      }
      io.to(`room:${roomId}`).emit('message:updated', { roomId, message });
    });

    safeOn(socket, 'message:reaction', async ({ roomId, messageId, emoji }) => {
      roomId = Number(roomId);
      messageId = Number(messageId);
      if (!ALLOWED_EMOJIS.has(emoji) || !currentRooms.has(roomId)) return;

      const message = await toggleReaction(messageId, socket.user.id, socket.user.username, emoji);
      if (!message) return;
      io.to(`room:${roomId}`).emit('message:updated', { roomId, message });
    });

    // Admin-only, public rooms only: forces the target out of the room right
    // now (closes their panel, drops their socket from the channel) — no
    // ban, they're free to rejoin immediately, same as a Discord "kick".
    safeOn(socket, 'room:kick', async ({ roomId, username }) => {
      roomId = Number(roomId);
      const { rows: adminRows } = await pool.query('SELECT role FROM users WHERE id = $1', [socket.user.id]);
      if (adminRows[0]?.role !== 'admin') {
        socket.emit('error:message', 'Necesitas permisos de administrador para esto.');
        return;
      }

      const { rows: roomRows } = await pool.query('SELECT is_dm FROM rooms WHERE id = $1', [roomId]);
      const room = roomRows[0];
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

      await broadcastPresence(roomId);
    });

    safeOn(socket, 'typing', async ({ roomId, isTyping }) => {
      roomId = Number(roomId);
      if (!currentRooms.has(roomId)) return;

      // Same anonymity as message:send: an admin typing in a support thread
      // shouldn't leak their real username through the typing indicator
      // while their actual messages show up as the room.
      let username = socket.user.username;
      const { rows: roomRows } = await pool.query('SELECT support_for_room_id FROM rooms WHERE id = $1', [roomId]);
      const room = roomRows[0];
      if (room?.support_for_room_id != null) {
        const { rows: senderRows } = await pool.query('SELECT role FROM users WHERE id = $1', [socket.user.id]);
        if (senderRows[0]?.role === 'admin') {
          const { rows: publicRoomRows } = await pool.query('SELECT name FROM rooms WHERE id = $1', [
            room.support_for_room_id,
          ]);
          if (publicRoomRows[0]) username = publicRoomRows[0].name;
        }
      }

      socket.to(`room:${roomId}`).emit('typing', { roomId, username, isTyping: !!isTyping });
    });

    // Opt-in "nearby users": share a fresh reading, or turn sharing off.
    // Affects every room this socket is currently in, since proximity to
    // everyone there just became knowable (or stopped being knowable).
    safeOn(socket, 'location:update', async ({ lat, lng } = {}) => {
      if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) return;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      userLocations.set(socket.user.id, { lat, lng });
      for (const roomId of currentRooms) await broadcastPresence(roomId);
    });

    safeOn(socket, 'location:disable', async () => {
      userLocations.delete(socket.user.id);
      for (const roomId of currentRooms) await broadcastPresence(roomId);
    });

    // WebRTC camera-call signaling (DM rooms only — always exactly 2
    // participants, so relaying to "the room" reaches only the other side).
    // The server never looks inside the SDP/ICE payloads, it just forwards
    // them between the two peers.
    function safeOnCall(event, handler) {
      safeOn(socket, event, async (payload) => {
        const roomId = Number(typeof payload === 'object' && payload !== null ? payload.roomId : payload);
        if (!currentRooms.has(roomId) || !(await isDmRoom(roomId))) return;
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

    socket.on('disconnect', async () => {
      try {
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
          await broadcastPresence(roomId);
          // Don't leave the other side hanging mid-call if we vanish.
          if (await isDmRoom(roomId)) {
            socket.to(`room:${roomId}`).emit('call:end', { roomId, from: socket.user.username });
          }
        }
      } catch (err) {
        console.error('Error manejando la desconexion:', err);
      }
    });
  });
}

// Called from the REST layer right after a brand-new DM room is created.
// Pushes it live to the *other* participant if they're currently connected:
// joins their socket(s) to the room and lets their UI add it to the "Mensajes
// directos" list with an unread marker, with no page reload required.
export async function notifyUserOfNewDm(targetUserId, room, senderInfo) {
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

  await broadcastPresence(room.id);
}

// Called from the REST layer right after a user is promoted to admin. Tells
// their own live client(s) immediately (so admin-only UI shows up without a
// re-login) and refreshes presence in every room they're currently in, so
// other members' room panels stop offering to promote someone who already is.
export async function notifyUserPromoted(userId) {
  const socketIds = userSockets.get(userId);
  if (!socketIds || !io) return;

  // A brand-new admin should see the whole shared support inbox immediately,
  // not just the threads they'd personally started as a regular user.
  const supportRoomIds = await listAllSupportRoomIds();

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    for (const roomId of supportRoomIds) {
      socket.join(`room:${roomId}`);
      socket.data.currentRooms?.add(roomId);
      addPresence(roomId, socketId, socket.user);

      // Without this, the new admin's socket has the room server-side but
      // their sidebar has no idea it exists until they reload the page.
      const { rows } = await pool.query(
        `SELECT pr.name AS public_room_name, u.username AS initiator_username, u.is_guest AS initiator_is_guest
         FROM rooms r
         JOIN rooms pr ON pr.id = r.support_for_room_id
         JOIN users u ON u.id = r.support_for_user_id
         WHERE r.id = $1`,
        [roomId]
      );
      const info = rows[0];
      if (info) {
        socket.emit('dm:new', {
          room: {
            id: roomId,
            otherUsername: `🎧 ${info.public_room_name} · ${info.initiator_username}`,
            otherIsGuest: !!info.initiator_is_guest,
          },
        });
      }
    }

    socket.emit('role:updated', { isAdmin: true });
    for (const roomId of socket.data.currentRooms || []) await broadcastPresence(roomId);
  }
}

// Called from the REST layer right after a "contact support" thread is
// created for the first time. Pushes it live to every *currently connected*
// admin — joins their socket(s) to it and lets their sidebar pick it up —
// same idea as notifyUserOfNewDm, just fanned out to a role instead of one
// fixed recipient.
export async function notifyAdminsOfNewSupportThread(supportRoom, publicRoom, initiatorInfo) {
  if (!io) return;

  for (const [userId, socketIds] of userSockets.entries()) {
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isAdmin = rows[0]?.role === 'admin';
    if (!isAdmin) continue;

    for (const socketId of socketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;

      socket.join(`room:${supportRoom.id}`);
      socket.data.currentRooms?.add(supportRoom.id);
      addPresence(supportRoom.id, socketId, socket.user);

      socket.emit('dm:new', {
        room: {
          id: supportRoom.id,
          otherUsername: `🎧 ${publicRoom.name} · ${initiatorInfo.username}`,
          otherIsGuest: !!initiatorInfo.isGuest,
        },
      });
    }
  }

  await broadcastPresence(supportRoom.id);
}
