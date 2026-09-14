import { useState } from 'react';
import Avatar from './Avatar.jsx';
import { QUICK_EMOJIS } from '../lib/emojis.js';

function formatTime(iso) {
  try {
    return new Date(`${iso}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function MessageItem({ message, isOwn, currentUsername, onEdit, onDelete, onReact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [showPicker, setShowPicker] = useState(false);
  const isDeleted = !!message.deleted_at;

  function startEdit() {
    setDraft(message.content);
    setEditing(true);
    setShowPicker(false);
  }

  function saveEdit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== message.content) {
      onEdit(message.id, trimmed);
    }
    setEditing(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      setEditing(false);
    }
  }

  // The sender's chosen colors are stored on the message itself (denormalized
  // like the username), so they render the same for everyone regardless of
  // whether the sender later changes their profile color.
  const customStyle =
    message.text_color || message.bg_color
      ? { color: message.text_color || undefined, background: message.bg_color || undefined }
      : undefined;

  return (
    <div className={isOwn ? 'message-row own' : 'message-row'}>
      {!isOwn && <Avatar username={message.username} />}

      <div className={isOwn ? 'message own' : 'message'} style={customStyle}>
        <div className="message-meta">
          <span className="message-author">{message.username}</span>
          {!!message.is_support && (
            <span className="support-badge" title="Mensaje oficial de esta sala">
              ✓ Soporte
            </span>
          )}
          <span className="message-time">{formatTime(message.created_at)}</span>
          {message.edited_at && !isDeleted && <span className="message-edited">(editado)</span>}
        </div>

        {editing ? (
          <div className="message-edit-form">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} maxLength={2000} autoFocus />
            <div className="message-edit-actions">
              <button onClick={saveEdit}>Guardar</button>
              <button onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div className={isDeleted ? 'message-content deleted' : 'message-content'}>
            {isDeleted ? 'Mensaje eliminado' : message.content}
          </div>
        )}

        {!isDeleted && message.reactions?.length > 0 && (
          <div className="reactions">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                className={r.users.includes(currentUsername) ? 'reaction mine' : 'reaction'}
                onClick={() => onReact(message.id, r.emoji)}
                title={r.users.join(', ')}
              >
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}

        {!isDeleted && !editing && (
          <div className="message-actions">
            <div className="emoji-picker-wrapper">
              <button className="icon-btn" onClick={() => setShowPicker((v) => !v)} title="Reaccionar">
                😊+
              </button>
              {showPicker && (
                <div className="emoji-picker">
                  {QUICK_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        onReact(message.id, emoji);
                        setShowPicker(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {isOwn && (
              <>
                <button className="icon-btn" onClick={startEdit} title="Editar">
                  ✏️
                </button>
                <button className="icon-btn" onClick={() => onDelete(message.id)} title="Eliminar">
                  🗑️
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
