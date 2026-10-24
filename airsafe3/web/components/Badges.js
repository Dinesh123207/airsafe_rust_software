const STATUS_CLASS = { Safe: 'safe', Low: 'low', Moderate: 'mod', High: 'high', Critical: 'crit', 'No-Show': 'mod' };

export function ScoreBadge({ score, status }) {
  if (score === null || score === undefined) return <span className="badge muted">no data</span>;
  return <span className={`badge ${STATUS_CLASS[status] || 'muted'}`}>{Math.round(score)} · {status}</span>;
}

export function SourceTag({ room }) {
  if (!room.source) return null;
  const hw = String(room.source).startsWith('device:');
  if (hw && room.stale) return <span className="tag stale" title="Device has gone quiet (no data for 2+ minutes)">STALE</span>;
  if (hw) return <span className="tag hw" title={room.source}>HARDWARE</span>;
  if (room.stale) return <span className="tag stale" title="A device is assigned but not reporting yet">NO DEVICE DATA</span>;
  return <span className="tag sim">SIMULATED</span>;
}

// Never claim LIVE just because the API answered: only real, fresh hardware readings count.
export function LiveBadge({ rooms }) {
  const total = rooms.length;
  const live = rooms.filter((r) => String(r.source || '').startsWith('device:') && !r.stale).length;
  return live > 0
    ? <span className="live on">LIVE · {live}/{total} ON HARDWARE</span>
    : <span className="live">CONNECTED · SIMULATED DATA</span>;
}
