# Chat Multisala

Chat en tiempo real con múltiples salas, login de usuarios registrados y acceso como invitado anónimo.

## Stack

- **Backend**: Node.js + Express + Socket.IO + SQLite (`better-sqlite3`), auth con JWT y contraseñas hasheadas (`bcryptjs`).
- **Frontend**: React (Vite) + React Router + `socket.io-client`.

## Estructura

```
chat-multisala/
  server/         API REST + WebSocket + base de datos SQLite
  client/         SPA en React
```

## Requisitos

- Node.js 18+ (probado con Node 22)

## Puesta en marcha

Instalar dependencias (ya hecho si acabás de clonar, `npm install` en la raíz instala todo vía workspaces):

```bash
npm install
```

Copiá las variables de entorno de ejemplo:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Levantar backend y frontend juntos en modo desarrollo:

```bash
npm run dev
```

- Backend en `http://localhost:4000`
- Frontend en `http://localhost:5173`

También podés levantarlos por separado con `npm run dev:server` y `npm run dev:client`.

## Funcionalidad

- **Registro / login** con usuario y contraseña (hash con bcrypt, sesión vía JWT).
- **Entrar como invitado**: sin registrarse, eligiendo un nombre para mostrar (o uno generado automáticamente).
- **Salas múltiples**: lista de salas públicas, creación de salas nuevas.
- **Mensajería en tiempo real** vía Socket.IO, con historial persistido en SQLite.
- **Presencia**: lista de usuarios conectados por sala.
- **Indicador de "escribiendo..."**.

## Notas de seguridad / producción

Este proyecto está pensado como base funcional para seguir iterando. Antes de un despliegue real conviene:

- Usar un `JWT_SECRET` largo y aleatorio en producción (no el de `.env.example`).
- Servir por HTTPS y ajustar `CLIENT_ORIGIN`/CORS al dominio real.
- Agregar rate limiting a los endpoints de auth.
- Migrar de SQLite a una base gestionada si se espera alta concurrencia.
