import { Router } from 'express';
import { pool } from '../db/index.js';
import { getMessagesForRoom } from '../db/messages.js';
import {
  canAccessDmRoom,
  findUserByUsername,
  getOrCreateDmRoom,
  getOrCreateSupportRoom,
  listDmRoomsForUser,
  listSupportRoomsForViewer,
} from '../db/rooms.js';
import { asyncHandler, requireAdmin, requireAuth } from '../middleware/auth.js';
import { notifyAdminsOfNewSupportThread, notifyUserOfNewDm } from '../socket.js';

const router = Router();
const ROOM_NAME_RE = /^[a-zA-Z0-9 _-]{2,30}$/;

// Postgres unique_violation — see routes/auth.js for why this matters now
// that requests run concurrently against a connection pool.
const UNIQUE_VIOLATION = '23505';

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    // DM rooms are private 1-to-1 chats, not public "salas" — keep them out
    // of the general listing (they're fetched separately via GET /rooms/dm).
    const { rows } = await pool.query('SELECT id, name, created_at FROM rooms WHERE is_dm = false ORDER BY name');
    res.json({ rooms: rows });
  })
);

router.post(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !ROOM_NAME_RE.test(name.trim())) {
      return res.status(400).json({ error: 'Nombre de sala invalido (2-30 caracteres).' });
    }

    const trimmed = name.trim();
    const { rows: existingRows } = await pool.query('SELECT id FROM rooms WHERE name = $1', [trimmed]);
    if (existingRows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una sala con ese nombre.' });
    }
    // Every public room gets a virtual "contact support" entry in its member
    // list, named after the room (see socket.js getRoomUsers) — a real user
    // sharing that exact name would collide with it in the presence list.
    if (await findUserByUsername(trimmed)) {
      return res.status(409).json({ error: 'Ese nombre ya lo usa un usuario, elegi otro para la sala.' });
    }

    let room;
    try {
      const { rows } = await pool.query(
        'INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at',
        [trimmed, req.user.id]
      );
      room = rows[0];
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'Ya existe una sala con ese nombre.' });
      }
      throw err;
    }

    res.status(201).json({ room });
  })
);

// List every DM-shaped room the caller can see: real 1-to-1 chats, plus
// "contact support" threads (their own if they're a regular user, every
// open one if they're currently an admin — a shared inbox).
router.get(
  '/dm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: roleRows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    const isAdminViewer = roleRows[0]?.role === 'admin';

    const normalDms = (await listDmRoomsForUser(req.user.id)).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      otherUsername: row.other_username,
      otherIsGuest: !!row.other_is_guest,
    }));

    const supportThreads = (await listSupportRoomsForViewer(req.user.id, isAdminViewer)).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      otherUsername: row.displayName,
      otherIsGuest: row.otherIsGuest,
    }));

    res.json({ rooms: [...normalDms, ...supportThreads] });
  })
);

// Start (or resume) a private 1-to-1 chat with another user.
router.post(
  '/dm',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { username } = req.body || {};
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Falta el nombre de usuario.' });
    }

    const target = await findUserByUsername(username.trim());
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'No podes iniciar un chat privado con vos mismo.' });
    }

    const { room, created } = await getOrCreateDmRoom(req.user.id, target);
    if (created) {
      await notifyUserOfNewDm(target.id, room, { username: req.user.username, isGuest: req.user.isGuest });
    }

    res.status(201).json({
      room: {
        id: room.id,
        created_at: room.created_at,
        otherUsername: target.username,
        otherIsGuest: !!target.is_guest,
      },
    });
  })
);

// "Contact support": start (or resume) the shared thread for a public room.
// Whoever's currently an admin gets it live — see notifyAdminsOfNewSupportThread.
router.post(
  '/support',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { roomId } = req.body || {};
    const { rows: publicRoomRows } = await pool.query('SELECT id, name, is_dm FROM rooms WHERE id = $1', [
      Number(roomId),
    ]);
    const publicRoom = publicRoomRows[0];
    if (!publicRoom || publicRoom.is_dm) {
      return res.status(404).json({ error: 'Sala no encontrada.' });
    }

    const { room, created } = await getOrCreateSupportRoom(publicRoom, req.user.id);
    if (created) {
      await notifyAdminsOfNewSupportThread(room, publicRoom, { username: req.user.username, isGuest: req.user.isGuest });
    }

    res.status(201).json({
      room: {
        id: room.id,
        created_at: room.created_at,
        otherUsername: `🎧 ${publicRoom.name}`,
        otherIsGuest: false,
      },
    });
  })
);

router.get(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const roomId = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before ? String(req.query.before) : null;

    const { rows: roomRows } = await pool.query('SELECT id, is_dm FROM rooms WHERE id = $1', [roomId]);
    const room = roomRows[0];
    if (!room) {
      return res.status(404).json({ error: 'Sala no encontrada.' });
    }
    if (room.is_dm) {
      const { rows: roleRows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
      if (!(await canAccessDmRoom(roomId, req.user.id, roleRows[0]?.role))) {
        return res.status(403).json({ error: 'No tenes acceso a este chat privado.' });
      }
    }

    const messages = await getMessagesForRoom(roomId, { before, limit });
    res.json({ messages });
  })
);

export default router;
