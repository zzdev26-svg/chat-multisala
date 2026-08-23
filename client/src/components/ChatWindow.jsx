import { useEffect, useRef } from 'react';
import MessageInput from './MessageInput.jsx';

function formatTime(iso) {
  try {
    return new Date(`${iso}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function ChatWindow({ room, messages, currentUsername, users, typingUsers, onSend, onTyping }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

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

      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={m.username === currentUsername ? 'message own' : 'message'}>
            <div className="message-meta">
              <span className="message-author">{m.username}</span>
              <span className="message-time">{formatTime(m.created_at)}</span>
            </div>
            <div className="message-content">{m.content}</div>
          </div>
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
