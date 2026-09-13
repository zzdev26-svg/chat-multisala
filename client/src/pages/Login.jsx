import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

const TABS = [
  { key: 'guest', label: 'Entrar como invitado' },
  { key: 'login', label: 'Ingresar' },
  { key: 'register', label: 'Crear cuenta' },
];

export default function Login() {
  const [tab, setTab] = useState('guest');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      let data;
      if (tab === 'login') {
        data = await api.login(username, password);
      } else if (tab === 'register') {
        data = await api.register(username, password);
      } else {
        data = await api.guest(username);
      }
      login(data.token, data.user);
      navigate('/chat');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Chat Multisala</h1>
        <div className="auth-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={t.key === tab ? 'tab active' : 'tab'}
              onClick={() => {
                setTab(t.key);
                setError('');
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            {tab === 'guest' ? 'Nombre para mostrar (opcional)' : 'Usuario'}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={tab === 'guest' ? 'Ej: Visitante' : 'Ej: gonza'}
              required={tab !== 'guest'}
              maxLength={20}
              autoFocus
            />
          </label>

          {tab !== 'guest' && (
            <label>
              Contrasena
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimo 6 caracteres"
                required
                minLength={6}
              />
            </label>
          )}

          {error && <p className="auth-error">{error}</p>}

          <button type="submit" disabled={loading}>
            {loading
              ? 'Un momento...'
              : tab === 'login'
                ? 'Ingresar'
                : tab === 'register'
                  ? 'Crear cuenta y entrar'
                  : 'Entrar como invitado'}
          </button>
        </form>
      </div>
    </div>
  );
}
