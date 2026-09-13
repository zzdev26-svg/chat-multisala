export default function LocationToggle({ enabled, loading, error, onToggle }) {
  return (
    <div className="location-toggle">
      <button
        type="button"
        className={enabled ? 'location-toggle-btn on' : 'location-toggle-btn'}
        title={enabled ? 'Dejar de compartir mi ubicacion' : 'Ver usuarios cercanos primero'}
        onClick={() => onToggle(!enabled)}
        disabled={loading}
      >
        📍 {loading ? '...' : enabled ? 'Cercanos: ON' : 'Cercanos: OFF'}
      </button>
      {error && <p className="location-error">{error}</p>}
    </div>
  );
}
