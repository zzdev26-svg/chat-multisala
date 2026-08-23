import { db } from './db/index.js';
import { verifyToken } from './utils/jwt.js';

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

export function registerSocketHandlers(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No autenticado'));
    try {
      socket.user = verifyToken(token);
      next();
    } catch {
      next(new Error('Token invalido o expirado'));
    }
  });

  io.on('connection', (socket) => {
    const currentRooms = new Set();

    socket.on('room:join', (roomId) => {
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

    socket.on('room:leave', (roomId) => {
      roomId = Number(roomId);
      socket.leave(`room:${roomId}`);
      currentRooms.delete(roomId);
      removePresence(roomId, socket.id);
      io.to(`room:${roomId}`).emit('room:presence', {
        roomId,
        users: getRoomUsers(roomId),
      });
    });

    socket.on('message:send', ({ roomId, content }) => {
      roomId = Number(roomId);
      if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
        socket.emit('error:message', 'Mensaje invalido.');
        return;
      }
      if (!currentRooms.has(roomId)) {
        socket.emit('error:message', 'No estas conectado a esa sala.');
        return;
      }

      const trimmed = content.trim();
      const info = db
        .prepare('INSERT INTO messages (room_id, user_id, username, content) VALUES (?, ?, ?, ?)')
        .run(roomId, socket.user.id, socket.user.username, trimmed);

      const message = db
        .prepare('SELECT id, user_id, username, content, created_at FROM messages WHERE id = ?')
        .get(info.lastInsertRowid);

      io.to(`room:${roomId}`).emit('message:new', { roomId, message });
    });

    socket.on('typing', ({ roomId, isTyping }) => {
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
