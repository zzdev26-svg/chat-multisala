import { useState } from 'react';

const DEFAULT_TEXT_COLOR = '#e7e9ee';
const DEFAULT_BG_COLOR = '#3b4a7a';

export default function ColorSettings({ user, onSave }) {
  const [open, setOpen] = useState(false);
  const [textColor, setTextColor] = useState(user.textColor || DEFAULT_TEXT_COLOR);
  const [bgColor, setBgColor] = useState(user.bgColor || DEFAULT_BG_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function toggleOpen() {
    if (!open) {
      setTextColor(user.textColor || DEFAULT_TEXT_COLOR);
      setBgColor(user.bgColor || DEFAULT_BG_COLOR);
      setError('');
    }
    setOpen((v) => !v);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await onSave({ textColor, bgColor });
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setError('');
    try {
      await onSave({ textColor: null, bgColor: null });
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="color-settings">
      <button type="button" className="color-settings-btn" title="Color de tus mensajes" onClick={toggleOpen}>
        🎨
      </button>
      {open && (
        <div className="color-settings-panel">
          <h3>Color de tus mensajes</h3>

          <label className="color-field">
            Texto
            <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} />
          </label>
          <label className="color-field">
            Fondo
            <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
          </label>

          <div className="color-preview" style={{ color: textColor, background: bgColor }}>
            Asi se ve tu mensaje
          </div>

          {error && <p className="auth-error small">{error}</p>}

          <div className="color-settings-actions">
            <button type="button" onClick={handleSave} disabled={saving}>
              Guardar
            </button>
            <button type="button" onClick={handleReset} disabled={saving}>
              Restablecer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
