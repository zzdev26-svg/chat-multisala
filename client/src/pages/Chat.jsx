import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { connectSocket, getSocket } from '../lib/socket.js';
import RoomList from '../components/RoomList.jsx';
import ChatWindow from '../components/ChatWindow.jsx';

export default function Chat() {
  const { token, user, logout } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [messagesByRoom, setMessagesByRoom] = useState({});
  const [presenceByRoom, setPresenceByRoom] = useState({});
  const [typingByRoom, setTypingByRoom] = useState({});
  const socketRef = useRef(null);
  const typingClearTimers = useRef({});

  // Establish the socket connection (once) and wire up listeners.
  useEffect(() => {
    const socket = getSocket() || connectSocket(token);
    socketRef.current = socket;

    function onMessageNew({ roomId, message }) {
      setMessagesByRoom((prev) => {
        const existing = prev[roomId] || [];
        if (existing.some((m) => m.id === message.id)) return prev;
        return { ...prev, [roomId]: [...existing, message] };
      });
    }

    function onPresence({ roomId, users }) {
      setPresenceByRoom((prev) => ({ ...prev, [roomId]: users }));
    }

    function onTyping({ roomId, username, isTyping }) {
      setTypingByRoom((prev) => {
        const current = new Set(prev[roomId] || []);
        if (isTyping) current.add(username);
        else current.delete(username);
        return { ...prev, [roomId]: Array.from(current) };
      });

      if (isTyping) {
        const key = `${roomId}:${username}`;
        clearTimeout(typingClearTimers.current[key]);
        typingClearTimers.current[key] = setTimeout(() => {
          setTypingByRoom((prev) => {
            const current = new Set(prev[roomId] || []);
            current.delete(username);
            return { ...prev, [roomId]: Array.from(current) };
          });
        }, 4000);
      }
    }

    function onErrorMessage(msg) {
      console.error('Socket error:', msg);
    }

    socket.on('message:new', onMessageNew);
    socket.on('room:presence', onPresence);
    socket.on('typing', onTyping);
    socket.on('error:message', onErrorMessage);

    return () => {
      socket.off('message:new', onMessageNew);
      socket.off('room:presence', onPresence);
      socket.off('typing', onTyping);
      socket.off('error:message', onErrorMessage);
    };
  }, [token]);

  // Load the room list once.
  useEffect(() => {
    api
      .listRooms(token)
      .then(({ rooms }) => {
        setRooms(rooms);
        if (rooms.length > 0) setActiveRoomId(rooms[0].id);
      })
      .catch((err) => console.error(err));
  }, [token]);

  // Join/leave rooms and load history when the active room changes.
  useEffect(() => {
    if (!activeRoomId) return;
    const socket = socketRef.current;
    if (!socket) return;

    api
      .getMessages(token, activeRoomId)
      .then(({ messages }) => {
        setMessagesByRoom((prev) => ({ ...prev, [activeRoomId]: messages }));
      })
      .catch((err) => console.error(err));

    socket.emit('room:join', activeRoomId);

    return () => {
      socket.emit('room:leave', activeRoomId);
    };
  }, [activeRoomId, token]);

  async function handleCreateRoom(name) {
    const { room } = await api.createRoom(token, name);
    setRooms((prev) => [...prev, room].sort((a, b) => a.name.localeCompare(b.name)));
    setActiveRoomId(room.id);
  }

  function handleSend(content) {
    socketRef.current?.emit('message:send', { roomId: activeRoomId, content });
  }

  function handleTyping(isTyping) {
    socketRef.current?.emit('typing', { roomId: activeRoomId, isTyping });
  }

  const activeRoom = rooms.find((r) => r.id === activeRoomId) || null;
  const messages = messagesByRoom[activeRoomId] || [];
  const users = presenceByRoom[activeRoomId] || [];
  const typingUsers = (typingByRoom[activeRoomId] || []).filter((u) => u !== user.username);

  return (
    <div className="chat-layout">
      <div className="topbar">
        <span>
          Conectado como <strong>{user.username}</strong>
          {user.isGuest ? ' (invitado)' : ''}
        </span>
        <button className="logout-btn" onClick={logout}>
          Salir
        </button>
      </div>
      <div className="chat-body">
        <RoomList rooms={rooms} activeRoomId={activeRoomId} onSelect={setActiveRoomId} onCreateRoom={handleCreateRoom} />
        <ChatWindow
          room={activeRoom}
          messages={messages}
          currentUsername={user.username}
          users={users}
          typingUsers={typingUsers}
          onSend={handleSend}
          onTyping={handleTyping}
        />
      </div>
    </div>
  );
}
