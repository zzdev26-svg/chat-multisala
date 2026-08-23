import { useRef, useState } from 'react';

export default function MessageInput({ onSend, onTyping }) {
  const [value, setValue] = useState('');
  const typingTimeout = useRef(null);

  function handleChange(e) {
    setValue(e.target.value);
    onTyping?.(true);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => onTyping?.(false), 1500);
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
      <input
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
