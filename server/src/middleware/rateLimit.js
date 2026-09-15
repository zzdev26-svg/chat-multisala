import rateLimit from 'express-rate-limit';

// Brute-force guard for /login: keyed by IP only (no username tracking), so
// it also caps how fast a single attacker can grind through passwords.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesion. Espera unos minutos y volve a intentar.' },
});

// Looser: register/guest don't leak whether a password is right, but still
// need a cap against mass account creation from one IP.
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas cuentas creadas desde esta conexion. Intenta mas tarde.' },
});
