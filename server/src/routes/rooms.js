import { Router } from 'express';
import { db } from '../db/index.js';
import { getMessagesForRoom } from '../db/messages.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const ROOM_NAME_RE = /^[a-zA-Z0-9 _-]{2,30}$/;

router.get('/', requireAuth, (req, res) => {
  const rooms = db.prepare('SELECT id, name, created_at FROM rooms ORDER BY name').all();
  res.json({ rooms });
});

router.post('/', requireAuth, (req, res) => {
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

router.get('/:id/messages', requireAuth, (req, res) => {
  const roomId = Number(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? String(req.query.before) : null;

  const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Sala no encontrada.' });
  }

  const messages = getMessagesForRoom(roomId, { before, limit });
  res.json({ messages });
});

export default router;
