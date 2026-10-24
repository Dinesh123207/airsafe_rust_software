export default function Sparkline({ points, height = 60, width = 260, max = 100 }) {
  if (!points || points.length < 2) return <div className="muted small">Not enough history yet</div>;
  const step = width / (points.length - 1);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(height - (Math.min(v, max) / max) * height).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="score history">
      <path d={d} fill="none" stroke="#2f7dd1" strokeWidth="2" />
    </svg>
  );
}
