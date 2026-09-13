import { useEffect, useRef, useState } from 'react';
import { useCall } from '../hooks/useCall.js';
import Avatar from './Avatar.jsx';
import MessageInput from './MessageInput.jsx';
import MessageItem from './MessageItem.jsx';

export default function ChatWindow({
  room,
  messages,
  currentUsername,
  isAdmin,
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
  onClose,
  onSelectUser,
  onKickUser,
}) {
  const containerRef = useRef(null);
  const bottomRef = useRef(null);
  const shouldStickToBottom = useRef(true);
  const prevScrollHeight = useRef(0);
  const [showMembers, setShowMembers] = useState(false);
  const call = useCall(room?.id, !!room?.isDm);

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

  if (!room) return null;

  return (
    <div className="chat-window">
      <header className="chat-header">
        <h2>
          {room.isDm ? '@' : '#'} {room.name}
        </h2>
        {!room.isDm && (
          <button
            type="button"
            className={showMembers ? 'members-toggle-btn open' : 'members-toggle-btn'}
            title="Ver conectados"
            onClick={() => setShowMembers((v) => !v)}
          >
            👥 {users.length}
          </button>
        )}
        {room.isDm && call.status === 'idle' && (
          <button type="button" className="members-toggle-btn" title="Llamar con camara" onClick={call.startCall}>
            📹
          </button>
        )}
        <button type="button" className="panel-close-btn" title="Cerrar sala" onClick={onClose}>
          ×
        </button>
      </header>

      {room.isDm && call.status !== 'idle' && (
        <div className="call-panel">
          {call.status === 'calling' && (
            <div className="call-banner">
              <span>Llamando a {room.name}...</span>
              <button type="button" onClick={call.cancelCall}>
                Cancelar
              </button>
            </div>
          )}

          {call.status === 'ringing' && (
            <div className="call-banner">
              <span>📹 {call.callerUsername} te esta llamando</span>
              <div className="call-banner-actions">
                <button type="button" className="call-accept-btn" onClick={call.acceptCall}>
                  Aceptar
                </button>
                <button type="button" onClick={call.rejectCall}>
                  Rechazar
                </button>
              </div>
            </div>
          )}

          {call.status === 'in-call' && (
            <div className="call-video-area">
              <video ref={call.remoteVideoRef} className="remote-video" autoPlay playsInline />
              <video ref={call.localVideoRef} className="local-video" autoPlay playsInline muted />
              <div className="call-controls">
                <button type="button" className="icon-btn" title={call.micOn ? 'Silenciar' : 'Activar microfono'} onClick={call.toggleMic}>
                  {call.micOn ? '🎤' : '🔇'}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={call.cameraOn ? 'Apagar camara' : 'Prender camara'}
                  onClick={call.toggleCamera}
                >
                  {call.cameraOn ? '📷' : '🚫'}
                </button>
                <button type="button" className="call-hangup-btn" title="Colgar" onClick={call.endCall}>
                  📴
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {room.isDm && call.error && <p className="call-error">{call.error}</p>}

      <div className="chat-window-body">
        <div className="chat-main">
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

        {!room.isDm && showMembers && (
          <aside className="members-panel">
            <h3>Conectados ({users.length})</h3>
            {users.length === 0 && <p className="members-empty">Nadie mas por aca todavia.</p>}
            <ul>
              {users.map((u) => (
                <li key={u.username} className="member-row">
                  <Avatar username={u.username} size={24} />
                  {u.username === currentUsername ? (
                    <span className="member-name">{u.username} (vos)</span>
                  ) : (
                    <button
                      type="button"
                      className="member-name member-name-btn"
                      title={`Chatear en privado con ${u.username}`}
                      onClick={() => onSelectUser(u.username)}
                    >
                      {u.username}
                    </button>
                  )}
                  {u.proximity && (
                    <span className={`proximity-badge proximity-${u.proximity.bucket}`}>{u.proximity.label}</span>
                  )}
                  {isAdmin && u.username !== currentUsername && (
                    <button
                      type="button"
                      className="icon-btn kick-btn"
                      title={`Expulsar a ${u.username}`}
                      onClick={() => onKickUser(u.username)}
                    >
                      🚫
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}
