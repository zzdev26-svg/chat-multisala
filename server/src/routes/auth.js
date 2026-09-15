import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, signupLimiter } from '../middleware/rateLimit.js';
import { signToken } from '../utils/jwt.js';

const router = Router();
const nanoid = customAlphabet('0123456789', 4);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

router.post('/register', signupLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'El usuario debe tener entre 3 y 20 caracteres (letras, numeros, guion bajo).',
    });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres.' });
  }
  if (findUserByUsername(username)) {
    return res.status(409).json({ error: 'Ese usuario ya existe.' });
  }

  // Bootstrap: the very first real (non-guest) account becomes admin, so
  // there's always someone who can create rooms without touching the DB
  // by hand. Everyone after that starts as a regular user.
  const hasRealUser = db.prepare('SELECT 1 FROM users WHERE is_guest = 0').get();
  const role = hasRealUser ? 'user' : 'admin';

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_guest, role) VALUES (?, ?, 0, ?)')
    .run(username, passwordHash, role);

  const user = {
    id: info.lastInsertRowid,
    username,
    isGuest: false,
    isAdmin: role === 'admin',
    isPro: false,
    textColor: null,
    bgColor: null,
  };
  const token = signToken(user);
  res.status(201).json({ token, user });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Usuario y contrasena son obligatorios.' });
  }

  const row = findUserByUsername(username);
  if (!row || row.is_guest || !row.password_hash) {
    return res.status(401).json({ error: 'Usuario o contrasena incorrectos.' });
  }

  const valid = bcrypt.compareSync(password, row.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Usuario o contrasena incorrectos.' });
  }

  const user = {
    id: row.id,
    username: row.username,
    isGuest: false,
    isAdmin: row.role === 'admin',
    isPro: row.plan === 'pro',
    textColor: row.text_color,
    bgColor: row.bg_color,
  };
  const token = signToken(user);
  res.json({ token, user });
});

router.post('/guest', signupLimiter, (req, res) => {
  let { username } = req.body || {};

  if (typeof username !== 'string' || !username.trim()) {
    username = `Invitado_${nanoid()}`;
  }
  username = username.trim().slice(0, 20).replace(/\s+/g, '_');

  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'El nombre debe tener entre 3 y 20 caracteres (letras, numeros, guion bajo).',
    });
  }

  // Ensure uniqueness: append a numeric suffix if the name is taken.
  let finalUsername = username;
  let attempts = 0;
  while (findUserByUsername(finalUsername) && attempts < 5) {
    finalUsername = `${username}_${nanoid()}`.slice(0, 20);
    attempts += 1;
  }
  if (findUserByUsername(finalUsername)) {
    return res.status(409).json({ error: 'No se pudo generar un nombre de invitado unico, intenta otro.' });
  }

  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_guest) VALUES (?, NULL, 1)')
    .run(finalUsername);

  // Guests are always plain users — never eligible for the admin bootstrap.
  const user = {
    id: info.lastInsertRowid,
    username: finalUsername,
    isGuest: true,
    isAdmin: false,
    isPro: false,
    textColor: null,
    bgColor: null,
  };
  const token = signToken(user);
  res.status(201).json({ token, user });
});

// Personalize the color of your own messages, applied everywhere you chat.
// Pass null for either field to reset it back to the default theme color.
router.patch('/me', requireAuth, (req, res) => {
  const { textColor, bgColor } = req.body || {};

  if (textColor !== null && !HEX_COLOR_RE.test(textColor || '')) {
    return res.status(400).json({ error: 'Color de texto invalido (formato #rrggbb).' });
  }
  if (bgColor !== null && !HEX_COLOR_RE.test(bgColor || '')) {
    return res.status(400).json({ error: 'Color de fondo invalido (formato #rrggbb).' });
  }

  db.prepare('UPDATE users SET text_color = ?, bg_color = ? WHERE id = ?').run(textColor, bgColor, req.user.id);

  const row = db.prepare('SELECT id, username, is_guest, role, plan, text_color, bg_color FROM users WHERE id = ?').get(req.user.id);
  res.json({
    user: {
      id: row.id,
      username: row.username,
      isGuest: !!row.is_guest,
      isAdmin: row.role === 'admin',
      isPro: row.plan === 'pro',
      textColor: row.text_color,
      bgColor: row.bg_color,
    },
  });
});

// STUB: stands in for a real payment flow. Today it just flips the plan on
// request — wire this to a Stripe/Mercado Pago webhook (or whatever
// processor you pick) before shipping, and remove the ability to call it
// directly from the client. Kept unauthenticated-to-abuse-but-not-to-access
// (still requireAuth) so the rest of the app can be built and demoed today.
router.patch('/plan', requireAuth, (req, res) => {
  const { plan } = req.body || {};
  if (plan !== 'free' && plan !== 'pro') {
    return res.status(400).json({ error: "plan debe ser 'free' o 'pro'." });
  }

  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, req.user.id);

  const row = db.prepare('SELECT id, username, is_guest, role, plan, text_color, bg_color FROM users WHERE id = ?').get(req.user.id);
  res.json({
    user: {
      id: row.id,
      username: row.username,
      isGuest: !!row.is_guest,
      isAdmin: row.role === 'admin',
      isPro: row.plan === 'pro',
      textColor: row.text_color,
      bgColor: row.bg_color,
    },
  });
});

export default router;
