import { useRef, useState } from 'react';
import { COMPOSE_EMOJIS } from '../lib/emojis.js';

export default function MessageInput({ onSend, onTyping }) {
  const [value, setValue] = useState('');
  const [showEmojis, setShowEmojis] = useState(false);
  const typingTimeout = useRef(null);
  const inputRef = useRef(null);

  function scheduleTypingStop() {
    onTyping?.(true);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => onTyping?.(false), 1500);
  }

  function handleChange(e) {
    setValue(e.target.value);
    scheduleTypingStop();
  }

  function insertEmoji(emoji) {
    setValue((v) => v + emoji);
    scheduleTypingStop();
    inputRef.current?.focus();
  }

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue('');
    onTyping?.(false);
  }

  return (
    <form onSubmit={handleSubmit} className="message-input">
      <div className="emoji-picker-wrapper">
        <button
          type="button"
          className="icon-btn"
          title="Insertar emoji"
          onClick={() => setShowEmojis((v) => !v)}
        >
          😊
        </button>
        {showEmojis && (
          <div className="emoji-picker compose-emoji-picker">
            {COMPOSE_EMOJIS.map((emoji) => (
              <button type="button" key={emoji} onClick={() => insertEmoji(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        placeholder="Escribi un mensaje..."
        maxLength={2000}
        autoFocus
      />
      <button type="submit">Enviar</button>
    </form>
  );
}
