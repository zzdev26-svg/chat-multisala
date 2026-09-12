import { db } from '../db/index.js';
import { verifyToken } from '../utils/jwt.js';

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
export function requireAdmin(req, res, next) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!row || row.role !== 'admin') {
    return res.status(403).json({ error: 'Necesitas permisos de administrador para esto.' });
  }
  next();
}
