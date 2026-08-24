import { useEffect, useRef } from 'react';
import MessageInput from './MessageInput.jsx';
import MessageItem from './MessageItem.jsx';

export default function ChatWindow({
  room,
  messages,
  currentUsername,
  users,
  typingUsers,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onSend,
  onTyping,
  onEdit,
  onDelete,
  onReact,
}) {
  const containerRef = useRef(null);
  const bottomRef = useRef(null);
  const shouldStickToBottom = useRef(true);
  const prevScrollHeight = useRef(0);

  useEffect(() => {
    if (shouldStickToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length]);

  // After prepending older messages, restore the scroll position so the
  // view doesn't jump around under the user.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !prevScrollHeight.current) return;
    el.scrollTop = el.scrollHeight - prevScrollHeight.current;
    prevScrollHeight.current = 0;
  }, [messages]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    shouldStickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && hasMore && !loadingOlder) {
      prevScrollHeight.current = el.scrollHeight;
      onLoadOlder();
    }
  }

  if (!room) {
    return <div className="chat-window empty">Elegi una sala para empezar a chatear.</div>;
  }

  return (
    <div className="chat-window">
      <header className="chat-header">
        <h2># {room.name}</h2>
        <span className="presence">
          {users.length} conectado{users.length !== 1 ? 's' : ''}: {users.map((u) => u.username).join(', ') || '-'}
        </span>
      </header>

      <div className="messages" ref={containerRef} onScroll={handleScroll}>
        {loadingOlder && <div className="loading-older">Cargando mensajes anteriores...</div>}
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            isOwn={m.username === currentUsername}
            currentUsername={currentUsername}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="typing-indicator">
        {typingUsers.length > 0 && `${typingUsers.join(', ')} escribiendo...`}
      </div>

      <MessageInput onSend={onSend} onTyping={onTyping} />
    </div>
  );
}
