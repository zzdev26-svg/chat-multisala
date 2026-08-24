const COLORS = ['#6c8cff', '#ff6b6b', '#4ecdc4', '#ffa94d', '#a78bfa', '#63e6be', '#f783ac', '#74c0fc'];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

export default function Avatar({ username, size = 30 }) {
  const initials = (username || '?').slice(0, 2).toUpperCase();
  const color = COLORS[hashString(username || '') % COLORS.length];

  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
      title={username}
    >
      {initials}
    </div>
  );
}
