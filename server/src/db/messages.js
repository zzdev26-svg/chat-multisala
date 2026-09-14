import { db } from './index.js';

const MESSAGE_COLUMNS =
  'id, room_id, user_id, username, content, created_at, edited_at, deleted_at, text_color, bg_color, is_support';

function attachReactions(messages) {
  if (messages.length === 0) return messages;

  const ids = messages.map((m) => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT message_id, emoji, username FROM message_reactions WHERE message_id IN (${placeholders})`)
    .all(...ids);

  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, new Map());
    const emojiMap = byMessage.get(row.message_id);
    if (!emojiMap.has(row.emoji)) emojiMap.set(row.emoji, []);
    emojiMap.get(row.emoji).push(row.username);
  }

  return messages.map((m) => {
    const emojiMap = byMessage.get(m.id);
    const reactions = emojiMap
      ? Array.from(emojiMap.entries()).map(([emoji, users]) => ({ emoji, count: users.length, users }))
      : [];
    return { ...m, reactions };
  });
}

export function getMessagesForRoom(roomId, { before, limit = 50 } = {}) {
  const rows = before
    ? db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE room_id = ? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(roomId, before, limit)
    : db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE room_id = ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(roomId, limit);

  return attachReactions(rows.reverse());
}

export function getMessageById(id) {
  const row = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id);
  if (!row) return null;
  return attachReactions([row])[0];
}

// textColor/bgColor are captured from the sender's profile at send time and
// stored directly on the row — same denormalization already used for
// `username`, so a later color (or username) change doesn't rewrite history.
// isSupport marks a message an admin sent under the room's own name (see
// socket.js message:send) — user_id still points at the real admin, so
// edit/delete ownership is unaffected; it's purely a display distinction.
export function insertMessage(
  roomId,
  userId,
  username,
  content,
  { textColor = null, bgColor = null, isSupport = false } = {}
) {
  const info = db
    .prepare(
      'INSERT INTO messages (room_id, user_id, username, content, text_color, bg_color, is_support) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(roomId, userId, username, content, textColor, bgColor, isSupport ? 1 : 0);
  return getMessageById(info.lastInsertRowid);
}

export function editMessage(messageId, userId, content) {
  const info = db
    .prepare(
      `UPDATE messages SET content = ?, edited_at = datetime('now')
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .run(content, messageId, userId);
  if (info.changes === 0) return null;
  return getMessageById(messageId);
}

export function deleteMessage(messageId, userId) {
  const info = db
    .prepare(
      `UPDATE messages SET content = '', deleted_at = datetime('now')
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .run(messageId, userId);
  if (info.changes === 0) return null;
  return getMessageById(messageId);
}

export function toggleReaction(messageId, userId, username, emoji) {
  const message = db.prepare('SELECT id FROM messages WHERE id = ? AND deleted_at IS NULL').get(messageId);
  if (!message) return null;

  const existing = db
    .prepare('SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(messageId, userId, emoji);

  if (existing) {
    db.prepare('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO message_reactions (message_id, user_id, username, emoji) VALUES (?, ?, ?, ?)').run(
      messageId,
      userId,
      username,
      emoji
    );
  }

  return getMessageById(messageId);
}
