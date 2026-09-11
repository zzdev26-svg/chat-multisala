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

let io = null;

function getRoomUsers(roomId) {
  const map = roomPresence.get(roomId);
  if (!map) return [];
  const seen = new Set();
  const users = [];
  for (const u of map.values()) {
    if (seen.has(u.username)) continue;
    seen.add(u.username);
    users.push({ username: u.username, isGuest: u.isGuest });
  }
  return users;
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
      io.to(`room:${roomId}`).emit('room:presence', {
        roomId,
        users: getRoomUsers(roomId),
      });
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
      io.to(`room:${roomId}`).emit('room:presence', {
        roomId,
        users: getRoomUsers(roomId),
      });
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

      const message = insertMessage(roomId, socket.user.id, socket.user.username, content.trim());
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

    safeOn(socket, 'typing', ({ roomId, isTyping }) => {
      roomId = Number(roomId);
      if (!currentRooms.has(roomId)) return;
      socket.to(`room:${roomId}`).emit('typing', {
        roomId,
        username: socket.user.username,
        isTyping: !!isTyping,
      });
    });

    socket.on('disconnect', () => {
      const sockets = userSockets.get(socket.user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) userSockets.delete(socket.user.id);
      }

      for (const roomId of currentRooms) {
        removePresence(roomId, socket.id);
        io.to(`room:${roomId}`).emit('room:presence', {
          roomId,
          users: getRoomUsers(roomId),
        });
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

  io.to(`room:${room.id}`).emit('room:presence', { roomId: room.id, users: getRoomUsers(room.id) });
}
