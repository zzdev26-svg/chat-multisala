import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { connectSocket, getSocket } from '../lib/socket.js';
import { playNotificationSound } from '../lib/sound.js';
import RoomList from '../components/RoomList.jsx';
import ChatWindow from '../components/ChatWindow.jsx';

const PAGE_SIZE = 50;
const BASE_TITLE = 'Chat Multisala';

export default function Chat() {
  const { token, user, logout } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [messagesByRoom, setMessagesByRoom] = useState({});
  const [presenceByRoom, setPresenceByRoom] = useState({});
  const [typingByRoom, setTypingByRoom] = useState({});
  const [hasMoreByRoom, setHasMoreByRoom] = useState({});
  const [loadingOlderByRoom, setLoadingOlderByRoom] = useState({});
  const [unreadCount, setUnreadCount] = useState(0);
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

      if (message.username !== user.username && document.hidden) {
        setUnreadCount((c) => c + 1);
        playNotificationSound();
      }
    }

    function onMessageUpdated({ roomId, message }) {
      setMessagesByRoom((prev) => {
        const existing = prev[roomId] || [];
        return { ...prev, [roomId]: existing.map((m) => (m.id === message.id ? message : m)) };
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

    function onConnectError(err) {
      // The token was rejected (expired, or the user no longer exists) —
      // force a clean re-login instead of leaving a dead connection around.
      console.error('Socket connect_error:', err.message);
      logout();
    }

    socket.on('message:new', onMessageNew);
    socket.on('message:updated', onMessageUpdated);
    socket.on('room:presence', onPresence);
    socket.on('typing', onTyping);
    socket.on('error:message', onErrorMessage);
    socket.on('connect_error', onConnectError);

    return () => {
      socket.off('message:new', onMessageNew);
      socket.off('message:updated', onMessageUpdated);
      socket.off('room:presence', onPresence);
      socket.off('typing', onTyping);
      socket.off('error:message', onErrorMessage);
      socket.off('connect_error', onConnectError);
    };
  }, [token, user.username, logout]);

  // Reflect unread messages in the tab title while the window is hidden.
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
  }, [unreadCount]);

  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden) setUnreadCount(0);
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

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
        setHasMoreByRoom((prev) => ({ ...prev, [activeRoomId]: messages.length === PAGE_SIZE }));
      })
      .catch((err) => console.error(err));

    socket.emit('room:join', activeRoomId);

    return () => {
      socket.emit('room:leave', activeRoomId);
    };
  }, [activeRoomId, token]);

  async function handleLoadOlder() {
    if (!activeRoomId) return;
    const roomMessages = messagesByRoom[activeRoomId] || [];
    const oldest = roomMessages[0];
    if (!oldest) return;

    setLoadingOlderByRoom((prev) => ({ ...prev, [activeRoomId]: true }));
    try {
      const { messages: older } = await api.getMessages(token, activeRoomId, oldest.created_at);
      setMessagesByRoom((prev) => {
        const existingIds = new Set((prev[activeRoomId] || []).map((m) => m.id));
        const merged = [...older.filter((m) => !existingIds.has(m.id)), ...(prev[activeRoomId] || [])];
        return { ...prev, [activeRoomId]: merged };
      });
      setHasMoreByRoom((prev) => ({ ...prev, [activeRoomId]: older.length === PAGE_SIZE }));
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingOlderByRoom((prev) => ({ ...prev, [activeRoomId]: false }));
    }
  }

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

  function handleEditMessage(messageId, content) {
    socketRef.current?.emit('message:edit', { roomId: activeRoomId, messageId, content });
  }

  function handleDeleteMessage(messageId) {
    if (!window.confirm('¿Eliminar este mensaje?')) return;
    socketRef.current?.emit('message:delete', { roomId: activeRoomId, messageId });
  }

  function handleReact(messageId, emoji) {
    socketRef.current?.emit('message:reaction', { roomId: activeRoomId, messageId, emoji });
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
          hasMore={!!hasMoreByRoom[activeRoomId]}
          loadingOlder={!!loadingOlderByRoom[activeRoomId]}
          onLoadOlder={handleLoadOlder}
          onSend={handleSend}
          onTyping={handleTyping}
          onEdit={handleEditMessage}
          onDelete={handleDeleteMessage}
          onReact={handleReact}
        />
      </div>
    </div>
  );
}
