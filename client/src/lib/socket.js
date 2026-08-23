import { io } from 'socket.io-client';
import { API_URL } from './api.js';

let socket = null;

export function connectSocket(token) {
  if (socket) {
    socket.disconnect();
  }
  socket = io(API_URL, {
    auth: { token },
    autoConnect: true,
  });
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
