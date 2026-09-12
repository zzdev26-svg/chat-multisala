import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { connectSocket, getSocket } from '../lib/socket.js';
import { playNotificationSound } from '../lib/sound.js';
import RoomList from '../components/RoomList.jsx';
import ChatWindow from '../components/ChatWindow.jsx';

const PAGE_SIZE = 50;
const BASE_TITLE = 'Chat Multisala';

function openRoomsStorageKey(username) {
  return `chat-multisala:open-rooms:${username}`;
}

function loadStoredOpenRooms(username) {
  try {
    const raw = localStorage.getItem(openRoomsStorageKey(username));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function Chat() {
  const { token, user, logout } = useAuth();
  const [rooms, setRooms] = useState([]);
  // Private 1-to-1 chats, normalized to the same { id, name } shape as
  // public rooms (name = the other participant's username) so they can
  // share the open/panel machinery below. isDm distinguishes them for
  // display (header prefix, etc).
  const [dmRooms, setDmRooms] = useState([]);
  // Every room in this list is joined and receiving live updates at once —
  // not just one "active" room.
  const [openRoomIds, setOpenRoomIds] = useState([]);
  const [messagesByRoom, setMessagesByRoom] = useState({});
  const [presenceByRoom, setPresenceByRoom] = useState({});
  const [typingByRoom, setTypingByRoom] = useState({});
  const [hasMoreByRoom, setHasMoreByRoom] = useState({});
  const [loadingOlderByRoom, setLoadingOlderByRoom] = useState({});
  const [unreadCount, setUnreadCount] = useState(0);
  // Rooms/DMs with a message that arrived while their panel wasn't open —
  // shown as a dot in the sidebar until the user opens that room.
  const [unreadRoomIds, setUnreadRoomIds] = useState(new Set());
  const socketRef = useRef(null);
  const typingClearTimers = useRef({});
  const joinedRoomsRef = useRef(new Set());
  const loadedRoomsRef = useRef(new Set());
  const openRoomIdsRef = useRef([]);

  useEffect(() => {
    openRoomIdsRef.current = openRoomIds;
  }, [openRoomIds]);

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

      if (message.username !== user.username) {
        // Every open room is joined and delivering live messages (see the
        // join/leave effect below), including DMs whose panel isn't open —
        // flag those as unread instead of just silently updating state.
        if (!openRoomIdsRef.current.includes(roomId)) {
          setUnreadRoomIds((prev) => (prev.has(roomId) ? prev : new Set(prev).add(roomId)));
        }
        if (document.hidden) {
          setUnreadCount((c) => c + 1);
          playNotificationSound();
        }
      }
    }

    // A new DM thread was just started with us by someone else — add it to
    // the sidebar in real time, flagged unread, without opening its panel.
    function onDmNew({ room }) {
      setDmRooms((prev) => (prev.some((r) => r.id === room.id) ? prev : [...prev, { id: room.id, name: room.otherUsername, isDm: true }]));
      setUnreadRoomIds((prev) => (prev.has(room.id) ? prev : new Set(prev).add(room.id)));
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
    socket.on('dm:new', onDmNew);
    socket.on('error:message', onErrorMessage);
    socket.on('connect_error', onConnectError);

    return () => {
      socket.off('message:new', onMessageNew);
      socket.off('message:updated', onMessageUpdated);
      socket.off('room:presence', onPresence);
      socket.off('typing', onTyping);
      socket.off('dm:new', onDmNew);
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

  // Load public rooms and existing DM chats once, then restore whichever
  // rooms this user had open (falling back to the first public room so the
  // app isn't empty on first login).
  useEffect(() => {
    Promise.all([api.listRooms(token), api.listDmRooms(token)])
      .then(([{ rooms }, { rooms: dms }]) => {
        setRooms(rooms);
        setDmRooms(dms.map((r) => ({ id: r.id, name: r.otherUsername, isDm: true })));

        const knownIds = new Set([...rooms.map((r) => r.id), ...dms.map((r) => r.id)]);
        const stored = loadStoredOpenRooms(user.username).filter((id) => knownIds.has(id));
        if (stored.length > 0) setOpenRoomIds(stored);
        else if (rooms.length > 0) setOpenRoomIds([rooms[0].id]);
      })
      .catch((err) => console.error(err));
  }, [token, user.username]);

  // Persist which rooms are open so a reload keeps chatting in the same set.
  useEffect(() => {
    localStorage.setItem(openRoomsStorageKey(user.username), JSON.stringify(openRoomIds));
  }, [openRoomIds, user.username]);

  // Opening a room (or DM) is what counts as "seen" — clear its unread flag.
  useEffect(() => {
    setUnreadRoomIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const roomId of openRoomIds) {
        if (next.delete(roomId)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [openRoomIds]);

  // Keep the socket joined to exactly the set of open rooms: join newly
  // opened ones (loading their history on first open), leave closed ones.
  // Because every open room stays joined at once, live events for all of
  // them keep flowing in regardless of which panel the user is looking at.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    const current = new Set(openRoomIds);

    for (const roomId of current) {
      if (joinedRoomsRef.current.has(roomId)) continue;
      socket.emit('room:join', roomId);

      if (!loadedRoomsRef.current.has(roomId)) {
        loadedRoomsRef.current.add(roomId);
        api
          .getMessages(token, roomId)
          .then(({ messages }) => {
            setMessagesByRoom((prev) => ({ ...prev, [roomId]: messages }));
            setHasMoreByRoom((prev) => ({ ...prev, [roomId]: messages.length === PAGE_SIZE }));
          })
          .catch((err) => console.error(err));
      }
    }

    for (const roomId of joinedRoomsRef.current) {
      if (!current.has(roomId)) socket.emit('room:leave', roomId);
    }

    joinedRoomsRef.current = current;
  }, [openRoomIds, token]);

  // Leave every joined room on unmount (e.g. logout) so presence clears up.
  useEffect(() => {
    return () => {
      const socket = socketRef.current;
      if (!socket) return;
      for (const roomId of joinedRoomsRef.current) socket.emit('room:leave', roomId);
    };
  }, []);

  async function handleLoadOlder(roomId) {
    const roomMessages = messagesByRoom[roomId] || [];
    const oldest = roomMessages[0];
    if (!oldest) return;

    setLoadingOlderByRoom((prev) => ({ ...prev, [roomId]: true }));
    try {
      const { messages: older } = await api.getMessages(token, roomId, oldest.created_at);
      setMessagesByRoom((prev) => {
        const existingIds = new Set((prev[roomId] || []).map((m) => m.id));
        const merged = [...older.filter((m) => !existingIds.has(m.id)), ...(prev[roomId] || [])];
        return { ...prev, [roomId]: merged };
      });
      setHasMoreByRoom((prev) => ({ ...prev, [roomId]: older.length === PAGE_SIZE }));
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingOlderByRoom((prev) => ({ ...prev, [roomId]: false }));
    }
  }

  async function handleCreateRoom(name) {
    const { room } = await api.createRoom(token, name);
    setRooms((prev) => [...prev, room].sort((a, b) => a.name.localeCompare(b.name)));
    setOpenRoomIds((prev) => (prev.includes(room.id) ? prev : [...prev, room.id]));
  }

  // Opens (or resumes) a private chat with another user, e.g. after
  // clicking their name in a room's presence list.
  async function handleStartDm(username) {
    try {
      const { room } = await api.startDm(token, username);
      setDmRooms((prev) =>
        prev.some((r) => r.id === room.id) ? prev : [...prev, { id: room.id, name: room.otherUsername, isDm: true }]
      );
      setOpenRoomIds((prev) => (prev.includes(room.id) ? prev : [...prev, room.id]));
    } catch (err) {
      console.error(err);
    }
  }

  function handleToggleRoom(roomId) {
    setOpenRoomIds((prev) => (prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId]));
  }

  function handleCloseRoom(roomId) {
    setOpenRoomIds((prev) => prev.filter((id) => id !== roomId));
  }

  function handleSend(roomId, content) {
    socketRef.current?.emit('message:send', { roomId, content });
  }

  function handleTyping(roomId, isTyping) {
    socketRef.current?.emit('typing', { roomId, isTyping });
  }

  function handleEditMessage(roomId, messageId, content) {
    socketRef.current?.emit('message:edit', { roomId, messageId, content });
  }

  function handleDeleteMessage(roomId, messageId) {
    if (!window.confirm('¿Eliminar este mensaje?')) return;
    socketRef.current?.emit('message:delete', { roomId, messageId });
  }

  function handleReact(roomId, messageId, emoji) {
    socketRef.current?.emit('message:reaction', { roomId, messageId, emoji });
  }

  return (
    <div className="chat-layout">
      <div className="topbar">
        <span>
          Conectado como <strong>{user.username}</strong>
          {user.isGuest ? ' (invitado)' : ''}
          {user.isAdmin ? ' (admin)' : ''}
        </span>
        <button className="logout-btn" onClick={logout}>
          Salir
        </button>
      </div>
      <div className="chat-body">
        <RoomList
          rooms={rooms}
          dmRooms={dmRooms}
          openRoomIds={openRoomIds}
          unreadRoomIds={unreadRoomIds}
          canCreateRoom={!!user.isAdmin}
          onToggleRoom={handleToggleRoom}
          onCreateRoom={handleCreateRoom}
        />
        {openRoomIds.length === 0 ? (
          <div className="chat-window empty">Elegi una o mas salas para empezar a chatear.</div>
        ) : (
          <div className="chat-panels">
            {openRoomIds.map((roomId) => {
              const room = rooms.find((r) => r.id === roomId) || dmRooms.find((r) => r.id === roomId);
              if (!room) return null;
              const typingUsers = (typingByRoom[roomId] || []).filter((u) => u !== user.username);
              return (
                <ChatWindow
                  key={roomId}
                  room={room}
                  messages={messagesByRoom[roomId] || []}
                  currentUsername={user.username}
                  users={presenceByRoom[roomId] || []}
                  typingUsers={typingUsers}
                  hasMore={!!hasMoreByRoom[roomId]}
                  loadingOlder={!!loadingOlderByRoom[roomId]}
                  onLoadOlder={() => handleLoadOlder(roomId)}
                  onSend={(content) => handleSend(roomId, content)}
                  onTyping={(isTyping) => handleTyping(roomId, isTyping)}
                  onEdit={(messageId, content) => handleEditMessage(roomId, messageId, content)}
                  onDelete={(messageId) => handleDeleteMessage(roomId, messageId)}
                  onReact={(messageId, emoji) => handleReact(roomId, messageId, emoji)}
                  onClose={() => handleCloseRoom(roomId)}
                  onSelectUser={handleStartDm}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
