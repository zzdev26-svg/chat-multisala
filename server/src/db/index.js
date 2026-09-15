import pg from 'pg';
import { DATABASE_URL } from '../config.js';

// Railway's internal connection (private network, host ending in
// .railway.internal) and a local docker-compose Postgres don't need/support
// TLS. Anything else (a public managed Postgres URL) does.
const needsSsl = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      is_guest BOOLEAN NOT NULL DEFAULT false,
      role TEXT NOT NULL DEFAULT 'user',
      plan TEXT NOT NULL DEFAULT 'free',
      text_color TEXT,
      bg_color TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      is_dm BOOLEAN NOT NULL DEFAULT false,
      -- Set on a DM room that's really a "contact support" thread for a
      -- public room: support_for_room_id is that public room, and
      -- support_for_user_id is the (non-admin) user who started it. Access to
      -- these two rooms isn't a fixed room_members row — see canAccessDmRoom.
      support_for_room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      support_for_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Membership for DM rooms (is_dm = true): the two participants of a
    -- private 1-to-1 chat. Public rooms don't use this table — anyone can
    -- join those.
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_room_members_user
      ON room_members(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      text_color TEXT,
      bg_color TEXT,
      is_support BOOLEAN NOT NULL DEFAULT false
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_created
      ON messages(room_id, created_at);

    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(message_id, user_id, emoji)
    );

    CREATE INDEX IF NOT EXISTS idx_reactions_message
      ON message_reactions(message_id);
  `);

  // Seed a couple of default public rooms if none exist yet.
  const { rows: roomCountRows } = await pool.query('SELECT COUNT(*) AS count FROM rooms');
  if (Number(roomCountRows[0].count) === 0) {
    await pool.query('INSERT INTO rooms (name) VALUES ($1), ($2)', ['General', 'Random']);
  }

  // Make sure there's always someone who can create rooms: if no admin
  // exists yet, promote whoever registered first. New installs additionally
  // get an admin right away on their very first real registration — see
  // routes/auth.js.
  const { rows: adminRows } = await pool.query("SELECT 1 FROM users WHERE role = 'admin'");
  if (adminRows.length === 0) {
    const { rows: firstUserRows } = await pool.query(
      'SELECT id FROM users WHERE is_guest = false ORDER BY created_at ASC, id ASC LIMIT 1'
    );
    if (firstUserRows.length > 0) {
      await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [firstUserRows[0].id]);
    }
  }
}

export default pool;
