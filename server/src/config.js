import 'dotenv/config';

export const PORT = process.env.PORT || 4000;

if (!process.env.JWT_SECRET) {
  throw new Error(
    'Falta JWT_SECRET. Definila en server/.env (copia server/.env.example y generá un valor largo y aleatorio) antes de arrancar el servidor.'
  );
}
export const JWT_SECRET = process.env.JWT_SECRET;

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
  throw new Error(
    'Falta DATABASE_URL. Definila en server/.env (copia server/.env.example) — apunta a Postgres local (docker compose up -d) o a la conexion que te dio Railway.'
  );
}
// .trim() porque un espacio de mas al pegar la variable en un dashboard
// (p.ej. Railway) termina en el nombre de la base ("railway " en vez de
// "railway") y Postgres tira "database ... does not exist".
export const DATABASE_URL = process.env.DATABASE_URL.trim();

export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
export const JWT_EXPIRES_IN = '7d';
