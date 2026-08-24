import { db } from './db/index.js';
import { insertMessage, editMessage, deleteMessage, toggleReaction } from './db/messages.js';
import { verifyToken } from './utils/jwt.js';

const ALLOWED_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '🎉']);

// roomId -> Map<socketId, { id, username, isGuest }>
const roomPresence = new Map();

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

export function registerSocketHandlers(io) {
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

    safeOn(socket, 'room:join', (roomId) => {
      roomId = Number(roomId);
      const room = db.prepare('SELECT id, name FROM rooms WHERE id = ?').get(roomId);
      if (!room) {
        socket.emit('error:message', 'Sala no encontrada.');
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
