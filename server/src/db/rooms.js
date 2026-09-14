import { db } from './index.js';

export function findUserByUsername(username) {
  return db.prepare('SELECT id, username, is_guest FROM users WHERE username = ?').get(username);
}

// Deterministic names for DM/support rooms so the existing UNIQUE(rooms.name)
// constraint doubles as "at most one per pair" — no separate lookup table.
function dmRoomName(idA, idB) {
  const [a, b] = [idA, idB].sort((x, y) => x - y);
  return `dm:${a}:${b}`;
}

function supportRoomName(publicRoomId, userId) {
  return `support:${publicRoomId}:${userId}`;
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

// "Contact support" thread for a public room: one per (public room, user)
// pair, reused on repeat contact. Unlike a normal DM, membership isn't a
// fixed pair in room_members — any *current* admin can access it (see
// canAccessDmRoom), which is what lets a newly-promoted admin see existing
// threads and lets multiple admins share the same inbox.
export function getOrCreateSupportRoom(publicRoom, userId) {
  const name = supportRoomName(publicRoom.id, userId);
  const existing = db.prepare('SELECT id, created_at FROM rooms WHERE name = ?').get(name);
  if (existing) return { room: existing, created: false };

  const info = db
    .prepare(
      'INSERT INTO rooms (name, is_dm, support_for_room_id, support_for_user_id) VALUES (?, 1, ?, ?)'
    )
    .run(name, publicRoom.id, userId);

  const room = db.prepare('SELECT id, created_at FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  return { room, created: true };
}

export function getSupportRoomInfo(roomId) {
  return db
    .prepare('SELECT support_for_room_id, support_for_user_id FROM rooms WHERE id = ?')
    .get(roomId);
}

// Single access check for any is_dm room, normal or support: a support
// thread grants access by *current* role (any admin, checked fresh) instead
// of a fixed room_members row, so promoting someone gives them the inbox
// immediately and demoting (if that's ever added) would take it away.
export function canAccessDmRoom(roomId, userId, userRole) {
  const support = getSupportRoomInfo(roomId);
  if (support?.support_for_room_id != null) {
    return support.support_for_user_id === userId || userRole === 'admin';
  }
  return isDmMember(roomId, userId);
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

// Support threads this user personally started.
export function listSupportRoomIdsForUser(userId) {
  return db
    .prepare('SELECT id FROM rooms WHERE support_for_user_id = ?')
    .all(userId)
    .map((r) => r.id);
}

// Every support thread system-wide — auto-joined for any *current* admin so
// the shared inbox is live regardless of who happens to answer.
export function listAllSupportRoomIds() {
  return db
    .prepare('SELECT id FROM rooms WHERE support_for_room_id IS NOT NULL')
    .all()
    .map((r) => r.id);
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

// Support threads visible to this viewer: their own if they're a regular
// user, or every open thread system-wide if they're currently an admin.
// The display name is computed here (server-side) so the client can treat
// these exactly like a normal DM row with no special-casing.
export function listSupportRoomsForViewer(userId, isAdminViewer) {
  const rows = isAdminViewer
    ? db
        .prepare(
          `SELECT r.id, r.created_at, pr.name AS public_room_name, u.username AS initiator_username, u.is_guest AS initiator_is_guest
           FROM rooms r
           JOIN rooms pr ON pr.id = r.support_for_room_id
           JOIN users u ON u.id = r.support_for_user_id
           WHERE r.support_for_room_id IS NOT NULL
           ORDER BY r.created_at DESC`
        )
        .all()
    : db
        .prepare(
          `SELECT r.id, r.created_at, pr.name AS public_room_name, u.username AS initiator_username, u.is_guest AS initiator_is_guest
           FROM rooms r
           JOIN rooms pr ON pr.id = r.support_for_room_id
           JOIN users u ON u.id = r.support_for_user_id
           WHERE r.support_for_user_id = ?
           ORDER BY r.created_at DESC`
        )
        .all(userId);

  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    // The regular user just sees "the room's" identity; an admin sees which
    // room it's about *and* who's asking, since they share one inbox.
    displayName: isAdminViewer
      ? `🎧 ${row.public_room_name} · ${row.initiator_username}`
      : `🎧 ${row.public_room_name}`,
    otherIsGuest: !!row.initiator_is_guest,
  }));
}
