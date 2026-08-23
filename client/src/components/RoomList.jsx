import { useState } from 'react';

export default function RoomList({ rooms, activeRoomId, onSelect, onCreateRoom }) {
  const [newRoomName, setNewRoomName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e) {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    setCreating(true);
    setError('');
    try {
      await onCreateRoom(newRoomName.trim());
      setNewRoomName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="room-list">
      <h2>Salas</h2>
      <ul>
        {rooms.map((room) => (
          <li key={room.id}>
            <button
              className={room.id === activeRoomId ? 'room-item active' : 'room-item'}
              onClick={() => onSelect(room.id)}
            >
              # {room.name}
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={handleCreate} className="create-room-form">
        <input
          value={newRoomName}
          onChange={(e) => setNewRoomName(e.target.value)}
          placeholder="Nueva sala..."
          maxLength={30}
        />
        <button type="submit" disabled={creating}>
          +
        </button>
      </form>
      {error && <p className="auth-error small">{error}</p>}
    </aside>
  );
}
