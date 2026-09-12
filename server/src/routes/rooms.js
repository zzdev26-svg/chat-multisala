import { Router } from 'express';
import { db } from '../db/index.js';
import { getMessagesForRoom } from '../db/messages.js';
import { findUserByUsername, getOrCreateDmRoom, isDmMember, listDmRoomsForUser } from '../db/rooms.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { notifyUserOfNewDm } from '../socket.js';

const router = Router();
const ROOM_NAME_RE = /^[a-zA-Z0-9 _-]{2,30}$/;

router.get('/', requireAuth, (req, res) => {
  // DM rooms are private 1-to-1 chats, not public "salas" — keep them out
  // of the general listing (they're fetched separately via GET /rooms/dm).
  const rooms = db.prepare('SELECT id, name, created_at FROM rooms WHERE is_dm = 0 ORDER BY name').all();
  res.json({ rooms });
});

router.post('/', requireAuth, requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !ROOM_NAME_RE.test(name.trim())) {
    return res.status(400).json({ error: 'Nombre de sala invalido (2-30 caracteres).' });
  }

  const trimmed = name.trim();
  const existing = db.prepare('SELECT id FROM rooms WHERE name = ?').get(trimmed);
  if (existing) {
    return res.status(409).json({ error: 'Ya existe una sala con ese nombre.' });
  }

  const info = db
    .prepare('INSERT INTO rooms (name, created_by) VALUES (?, ?)')
    .run(trimmed, req.user.id);

  const room = db.prepare('SELECT id, name, created_at FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ room });
});

// List the DM rooms the caller participates in, each paired with who's on
// the other end (there's no "sala" name to show for these — just a person).
router.get('/dm', requireAuth, (req, res) => {
  const rooms = listDmRoomsForUser(req.user.id).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    otherUsername: row.other_username,
    otherIsGuest: !!row.other_is_guest,
  }));
  res.json({ rooms });
});

// Start (or resume) a private 1-to-1 chat with another user.
router.post('/dm', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Falta el nombre de usuario.' });
  }

  const target = findUserByUsername(username.trim());
  if (!target) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'No podes iniciar un chat privado con vos mismo.' });
  }

  const { room, created } = getOrCreateDmRoom(req.user.id, target);
  if (created) {
    notifyUserOfNewDm(target.id, room, { username: req.user.username, isGuest: req.user.isGuest });
  }

  res.status(201).json({
    room: {
      id: room.id,
      created_at: room.created_at,
      otherUsername: target.username,
      otherIsGuest: !!target.is_guest,
    },
  });
});

router.get('/:id/messages', requireAuth, (req, res) => {
  const roomId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? String(req.query.before) : null;

  const room = db.prepare('SELECT id, is_dm FROM rooms WHERE id = ?').get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Sala no encontrada.' });
  }
  if (room.is_dm && !isDmMember(roomId, req.user.id)) {
    return res.status(403).json({ error: 'No tenes acceso a este chat privado.' });
  }

  const messages = getMessagesForRoom(roomId, { before, limit });
  res.json({ messages });
});

export default router;
