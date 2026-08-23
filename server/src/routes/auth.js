import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { customAlphabet } from 'nanoid';
import { db } from '../db/index.js';
import { signToken } from '../utils/jwt.js';

const router = Router();
const nanoid = customAlphabet('0123456789', 4);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

router.post('/register', (req, res) => {
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

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_guest) VALUES (?, ?, 0)')
    .run(username, passwordHash);

  const user = { id: info.lastInsertRowid, username, isGuest: false };
  const token = signToken(user);
  res.status(201).json({ token, user });
});

router.post('/login', (req, res) => {
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

  const user = { id: row.id, username: row.username, isGuest: false };
  const token = signToken(user);
  res.json({ token, user });
});

router.post('/guest', (req, res) => {
  let { username } = req.body || {};

  if (typeof username !== 'string' || !username.trim()) {
    username = `Invitado-${nanoid()}`;
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
    finalUsername = `${username}-${nanoid()}`.slice(0, 20);
    attempts += 1;
  }
  if (findUserByUsername(finalUsername)) {
    return res.status(409).json({ error: 'No se pudo generar un nombre de invitado unico, intenta otro.' });
  }

  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_guest) VALUES (?, NULL, 1)')
    .run(finalUsername);

  const user = { id: info.lastInsertRowid, username: finalUsername, isGuest: true };
  const token = signToken(user);
  res.status(201).json({ token, user });
});

export default router;
