import { Router } from 'express';
import { pool } from '../db/index.js';
import { asyncHandler, requireAdmin, requireAuth } from '../middleware/auth.js';
import { notifyUserPromoted } from '../socket.js';

const router = Router();

// Admin-only, one-way (no demote endpoint yet — not asked for). Guests are
// excluded for the same reason they're excluded from the admin bootstrap:
// they're meant to be low-trust, ephemeral identities.
router.patch(
  '/:username/promote',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const { rows } = await pool.query('SELECT id, is_guest, role FROM users WHERE username = $1', [username]);
    const target = rows[0];

    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (target.is_guest) {
      return res.status(400).json({ error: 'Los invitados no pueden ser administradores.' });
    }
    if (target.role === 'admin') {
      return res.status(409).json({ error: 'Ese usuario ya es administrador.' });
    }

    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [target.id]);
    await notifyUserPromoted(target.id);
    res.json({ ok: true });
  })
);

export default router;
