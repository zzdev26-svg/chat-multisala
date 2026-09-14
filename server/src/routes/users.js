import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { notifyUserPromoted } from '../socket.js';

const router = Router();

// Admin-only, one-way (no demote endpoint yet — not asked for). Guests are
// excluded for the same reason they're excluded from the admin bootstrap:
// they're meant to be low-trust, ephemeral identities.
router.patch('/:username/promote', requireAuth, requireAdmin, (req, res) => {
  const { username } = req.params;
  const target = db.prepare('SELECT id, is_guest, role FROM users WHERE username = ?').get(username);

  if (!target) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }
  if (target.is_guest) {
    return res.status(400).json({ error: 'Los invitados no pueden ser administradores.' });
  }
  if (target.role === 'admin') {
    return res.status(409).json({ error: 'Ese usuario ya es administrador.' });
  }

  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(target.id);
  notifyUserPromoted(target.id);
  res.json({ ok: true });
});

export default router;
