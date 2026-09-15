import { pool } from '../db/index.js';
import { verifyToken } from '../utils/jwt.js';

// Express 4 doesn't forward a rejected promise from an async handler to the
// error middleware in index.js on its own — without this, a DB error inside
// an async route would just hang the request instead of returning the 500
// that's already wired up.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Falta el token de autenticacion' });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }
}

// Chain after requireAuth. Re-checks the role against the DB (not the JWT
// claim) so a role change takes effect immediately instead of waiting out
// the token's 7-day expiry.
export const requireAdmin = asyncHandler(async (req, res, next) => {
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
  const row = rows[0];
  if (!row || row.role !== 'admin') {
    return res.status(403).json({ error: 'Necesitas permisos de administrador para esto.' });
  }
  next();
});
