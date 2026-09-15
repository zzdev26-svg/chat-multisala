import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { pool } from '../db/index.js';
import { asyncHandler, requireAuth } from '../middleware/auth.js';
import { loginLimiter, signupLimiter } from '../middleware/rateLimit.js';
import { signToken } from '../utils/jwt.js';

const router = Router();
const nanoid = customAlphabet('0123456789', 4);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Postgres unique_violation — used to turn a race between two concurrent
// requests (e.g. a double-click) into the same friendly 409 the upfront
// check already returns, instead of a generic 500.
const UNIQUE_VIOLATION = '23505';

async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || null;
}

router.post(
  '/register',
  signupLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'El usuario debe tener entre 3 y 20 caracteres (letras, numeros, guion bajo).',
      });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres.' });
    }
    if (await findUserByUsername(username)) {
      return res.status(409).json({ error: 'Ese usuario ya existe.' });
    }

    // Bootstrap: the very first real (non-guest) account becomes admin, so
    // there's always someone who can create rooms without touching the DB
    // by hand. Everyone after that starts as a regular user.
    const { rows: realUserRows } = await pool.query('SELECT 1 FROM users WHERE is_guest = false');
    const role = realUserRows.length > 0 ? 'user' : 'admin';

    const passwordHash = bcrypt.hashSync(password, 10);
    let id;
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (username, password_hash, is_guest, role) VALUES ($1, $2, false, $3) RETURNING id',
        [username, passwordHash, role]
      );
      id = rows[0].id;
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'Ese usuario ya existe.' });
      }
      throw err;
    }

    const user = {
      id,
      username,
      isGuest: false,
      isAdmin: role === 'admin',
      isPro: false,
      textColor: null,
      bgColor: null,
    };
    const token = signToken(user);
    res.status(201).json({ token, user });
  })
);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Usuario y contrasena son obligatorios.' });
    }

    const row = await findUserByUsername(username);
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
  })
);

router.post(
  '/guest',
  signupLimiter,
  asyncHandler(async (req, res) => {
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
    while ((await findUserByUsername(finalUsername)) && attempts < 5) {
      finalUsername = `${username}_${nanoid()}`.slice(0, 20);
      attempts += 1;
    }
    if (await findUserByUsername(finalUsername)) {
      return res.status(409).json({ error: 'No se pudo generar un nombre de invitado unico, intenta otro.' });
    }

    let id;
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (username, password_hash, is_guest) VALUES ($1, NULL, true) RETURNING id',
        [finalUsername]
      );
      id = rows[0].id;
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        return res.status(409).json({ error: 'No se pudo generar un nombre de invitado unico, intenta otro.' });
      }
      throw err;
    }

    // Guests are always plain users — never eligible for the admin bootstrap.
    const user = {
      id,
      username: finalUsername,
      isGuest: true,
      isAdmin: false,
      isPro: false,
      textColor: null,
      bgColor: null,
    };
    const token = signToken(user);
    res.status(201).json({ token, user });
  })
);

// Personalize the color of your own messages, applied everywhere you chat.
// Pass null for either field to reset it back to the default theme color.
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { textColor, bgColor } = req.body || {};

    if (textColor !== null && !HEX_COLOR_RE.test(textColor || '')) {
      return res.status(400).json({ error: 'Color de texto invalido (formato #rrggbb).' });
    }
    if (bgColor !== null && !HEX_COLOR_RE.test(bgColor || '')) {
      return res.status(400).json({ error: 'Color de fondo invalido (formato #rrggbb).' });
    }

    await pool.query('UPDATE users SET text_color = $1, bg_color = $2 WHERE id = $3', [
      textColor,
      bgColor,
      req.user.id,
    ]);

    const { rows } = await pool.query(
      'SELECT id, username, is_guest, role, plan, text_color, bg_color FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
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
  })
);

// STUB: stands in for a real payment flow. Today it just flips the plan on
// request — wire this to a Stripe/Mercado Pago webhook (or whatever
// processor you pick) before shipping, and remove the ability to call it
// directly from the client. Kept unauthenticated-to-abuse-but-not-to-access
// (still requireAuth) so the rest of the app can be built and demoed today.
router.patch(
  '/plan',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { plan } = req.body || {};
    if (plan !== 'free' && plan !== 'pro') {
      return res.status(400).json({ error: "plan debe ser 'free' o 'pro'." });
    }

    await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, req.user.id]);

    const { rows } = await pool.query(
      'SELECT id, username, is_guest, role, plan, text_color, bg_color FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
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
  })
);

export default router;
