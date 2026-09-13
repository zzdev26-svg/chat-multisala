import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'chat.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    is_guest INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    text_color TEXT,
    bg_color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_dm INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Membership for DM rooms (is_dm = 1): the two participants of a private
  -- 1-to-1 chat. Public rooms don't use this table — anyone can join those.
  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_room_members_user
    ON room_members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at TEXT,
    deleted_at TEXT,
    text_color TEXT,
    bg_color TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_created
    ON messages(room_id, created_at);

  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id, emoji)
  );

  CREATE INDEX IF NOT EXISTS idx_reactions_message
    ON message_reactions(message_id);
`);

// Guard for databases created before edited_at/deleted_at existed.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('messages', 'edited_at', 'TEXT');
ensureColumn('messages', 'deleted_at', 'TEXT');
ensureColumn('rooms', 'is_dm', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
ensureColumn('users', 'text_color', 'TEXT');
ensureColumn('users', 'bg_color', 'TEXT');
ensureColumn('messages', 'text_color', 'TEXT');
ensureColumn('messages', 'bg_color', 'TEXT');

// Seed a couple of default public rooms if none exist yet.
const roomCount = db.prepare('SELECT COUNT(*) AS count FROM rooms').get().count;
if (roomCount === 0) {
  const insertRoom = db.prepare('INSERT INTO rooms (name) VALUES (?)');
  insertRoom.run('General');
  insertRoom.run('Random');
}

// Make sure there's always someone who can create rooms: if no admin exists
// yet (fresh install, or a DB from before roles existed), promote whoever
// registered first. New installs additionally get an admin right away on
// their very first real registration — see routes/auth.js.
const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get();
if (!hasAdmin) {
  const firstRealUser = db
    .prepare('SELECT id FROM users WHERE is_guest = 0 ORDER BY created_at ASC, id ASC LIMIT 1')
    .get();
  if (firstRealUser) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(firstRealUser.id);
  }
}

export default db;
