export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function request(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

export const api = {
  register: (username, password) =>
    request('/api/auth/register', { method: 'POST', body: { username, password } }),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: { username, password } }),
  guest: (username) => request('/api/auth/guest', { method: 'POST', body: { username } }),
  updateColor: (token, { textColor, bgColor }) =>
    request('/api/auth/me', { method: 'PATCH', body: { textColor, bgColor }, token }),
  updatePlan: (token, plan) => request('/api/auth/plan', { method: 'PATCH', body: { plan }, token }),
  getIceServers: (token) => request('/api/calls/ice-servers', { token }),
  promoteToAdmin: (token, username) =>
    request(`/api/users/${encodeURIComponent(username)}/promote`, { method: 'PATCH', token }),
  listRooms: (token) => request('/api/rooms', { token }),
  createRoom: (token, name) => request('/api/rooms', { method: 'POST', body: { name }, token }),
  listDmRooms: (token) => request('/api/rooms/dm', { token }),
  startDm: (token, username) => request('/api/rooms/dm', { method: 'POST', body: { username }, token }),
  contactSupport: (token, roomId) => request('/api/rooms/support', { method: 'POST', body: { roomId }, token }),
  getMessages: (token, roomId, before) =>
    request(`/api/rooms/${roomId}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`, {
      token,
    }),
};
