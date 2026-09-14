import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { PORT, CLIENT_ORIGIN } from './config.js';
import authRoutes from './routes/auth.js';
import roomsRoutes from './routes/rooms.js';
import callsRoutes from './routes/calls.js';
import usersRoutes from './routes/users.js';
import { registerSocketHandlers } from './socket.js';
import './db/index.js'; // ensures schema is created on boot

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/calls', callsRoutes);
app.use('/api/users', usersRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CLIENT_ORIGIN },
});

registerSocketHandlers(io);

httpServer.listen(PORT, () => {
  console.log(`Servidor de chat escuchando en http://localhost:${PORT}`);
});
