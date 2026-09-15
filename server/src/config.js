import 'dotenv/config';

export const PORT = process.env.PORT || 4000;

if (!process.env.JWT_SECRET) {
  throw new Error(
    'Falta JWT_SECRET. Definila en server/.env (copia server/.env.example y generá un valor largo y aleatorio) antes de arrancar el servidor.'
  );
}
export const JWT_SECRET = process.env.JWT_SECRET;

export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
export const JWT_EXPIRES_IN = '7d';
