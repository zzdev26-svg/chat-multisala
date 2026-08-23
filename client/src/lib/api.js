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
  listRooms: (token) => request('/api/rooms', { token }),
  createRoom: (token, name) => request('/api/rooms', { method: 'POST', body: { name }, token }),
  getMessages: (token, roomId, before) =>
    request(`/api/rooms/${roomId}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`, {
      token,
    }),
};
