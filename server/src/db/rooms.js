import { db } from './index.js';

export function findUserByUsername(username) {
  return db.prepare('SELECT id, username, is_guest FROM users WHERE username = ?').get(username);
}

// Deterministic name for a DM room so the existing UNIQUE(rooms.name)
// constraint doubles as "at most one DM room per pair of users".
function dmRoomName(idA, idB) {
  const [a, b] = [idA, idB].sort((x, y) => x - y);
  return `dm:${a}:${b}`;
}

export function isDmMember(roomId, userId) {
  const row = db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
  return !!row;
}

// Returns { room, created }: `created` tells the caller whether this DM
// thread is brand new (vs. resuming one that already existed), so it knows
// whether the other participant needs a real-time heads-up about it.
export function getOrCreateDmRoom(selfId, otherUser) {
  const name = dmRoomName(selfId, otherUser.id);
  const existing = db.prepare('SELECT id, created_at FROM rooms WHERE name = ?').get(name);
  if (existing) return { room: existing, created: false };

  const info = db.prepare('INSERT INTO rooms (name, created_by, is_dm) VALUES (?, ?, 1)').run(name, selfId);
  const addMember = db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)');
  addMember.run(info.lastInsertRowid, selfId);
  addMember.run(info.lastInsertRowid, otherUser.id);

  const room = db.prepare('SELECT id, created_at FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  return { room, created: true };
}

// All DM room ids a user belongs to — used to auto-join their socket to
// every private thread as soon as they connect, so messages arrive live
// even for a DM whose panel isn't currently open.
export function listDmRoomIdsForUser(userId) {
  return db
    .prepare('SELECT room_id FROM room_members WHERE user_id = ?')
    .all(userId)
    .map((r) => r.room_id);
}

// Every DM room the given user belongs to, paired with the *other*
// participant's info (there are always exactly two members per DM room).
export function listDmRoomsForUser(userId) {
  return db
    .prepare(
      `SELECT r.id, r.created_at, u.username AS other_username, u.is_guest AS other_is_guest
       FROM room_members rm
       JOIN rooms r ON r.id = rm.room_id
       JOIN room_members rm2 ON rm2.room_id = r.id AND rm2.user_id != rm.user_id
       JOIN users u ON u.id = rm2.user_id
       WHERE rm.user_id = ? AND r.is_dm = 1
       ORDER BY r.created_at DESC`
    )
    .all(userId);
}
