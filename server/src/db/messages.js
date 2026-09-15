import { pool } from './index.js';

const MESSAGE_COLUMNS =
  'id, room_id, user_id, username, content, created_at, edited_at, deleted_at, text_color, bg_color, is_support';

async function attachReactions(messages) {
  if (messages.length === 0) return messages;

  const ids = messages.map((m) => m.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(
    `SELECT message_id, emoji, username FROM message_reactions WHERE message_id IN (${placeholders})`,
    ids
  );

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

export async function getMessagesForRoom(roomId, { before, limit = 50 } = {}) {
  const { rows } = before
    ? await pool.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE room_id = $1 AND created_at < $2
         ORDER BY created_at DESC LIMIT $3`,
        [roomId, before, limit]
      )
    : await pool.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE room_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [roomId, limit]
      );

  return attachReactions(rows.reverse());
}

export async function getMessageById(id) {
  const { rows } = await pool.query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1`, [id]);
  if (rows.length === 0) return null;
  return (await attachReactions(rows))[0];
}

// textColor/bgColor are captured from the sender's profile at send time and
// stored directly on the row — same denormalization already used for
// `username`, so a later color (or username) change doesn't rewrite history.
// isSupport marks a message an admin sent under the room's own name (see
// socket.js message:send) — user_id still points at the real admin, so
// edit/delete ownership is unaffected; it's purely a display distinction.
export async function insertMessage(
  roomId,
  userId,
  username,
  content,
  { textColor = null, bgColor = null, isSupport = false } = {}
) {
  const { rows } = await pool.query(
    `INSERT INTO messages (room_id, user_id, username, content, text_color, bg_color, is_support)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [roomId, userId, username, content, textColor, bgColor, isSupport]
  );
  return getMessageById(rows[0].id);
}

export async function editMessage(messageId, userId, content) {
  const { rowCount } = await pool.query(
    `UPDATE messages SET content = $1, edited_at = now()
     WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [content, messageId, userId]
  );
  if (rowCount === 0) return null;
  return getMessageById(messageId);
}

export async function deleteMessage(messageId, userId) {
  const { rowCount } = await pool.query(
    `UPDATE messages SET content = '', deleted_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [messageId, userId]
  );
  if (rowCount === 0) return null;
  return getMessageById(messageId);
}

export async function toggleReaction(messageId, userId, username, emoji) {
  const { rows: messageRows } = await pool.query(
    'SELECT id FROM messages WHERE id = $1 AND deleted_at IS NULL',
    [messageId]
  );
  if (messageRows.length === 0) return null;

  const { rows: existingRows } = await pool.query(
    'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [messageId, userId, emoji]
  );

  if (existingRows.length > 0) {
    await pool.query('DELETE FROM message_reactions WHERE id = $1', [existingRows[0].id]);
  } else {
    await pool.query(
      'INSERT INTO message_reactions (message_id, user_id, username, emoji) VALUES ($1, $2, $3, $4)',
      [messageId, userId, username, emoji]
    );
  }

  return getMessageById(messageId);
}
