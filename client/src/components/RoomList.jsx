import { useState } from 'react';

export default function RoomList({ rooms, dmRooms, openRoomIds, unreadRoomIds, onToggleRoom, onCreateRoom }) {
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
      <p className="room-list-hint">Elegi una o varias para chatear al mismo tiempo.</p>
      <ul>
        {rooms.map((room) => {
          const isOpen = openRoomIds.includes(room.id);
          return (
            <li key={room.id}>
              <label className={isOpen ? 'room-item open' : 'room-item'}>
                <input type="checkbox" checked={isOpen} onChange={() => onToggleRoom(room.id)} /># {room.name}
                {unreadRoomIds.has(room.id) && <span className="unread-dot" title="Mensajes nuevos" />}
              </label>
            </li>
          );
        })}
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

      {dmRooms.length > 0 && (
        <>
          <h2 className="room-list-section">Mensajes directos</h2>
          <ul>
            {dmRooms.map((room) => {
              const isOpen = openRoomIds.includes(room.id);
              return (
                <li key={room.id}>
                  <label className={isOpen ? 'room-item open' : 'room-item'}>
                    <input type="checkbox" checked={isOpen} onChange={() => onToggleRoom(room.id)} />@ {room.name}
                    {unreadRoomIds.has(room.id) && <span className="unread-dot" title="Mensajes nuevos" />}
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
