'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell from '../../components/Shell';
import { LiveBadge } from '../../components/Badges';
import { useAuth } from '../../lib/useAuth';
import { api, VERTICALS, isLiveHardware } from '../../lib/api';

export default function MasterAdmin() {
  const user = useAuth();
  const [rooms, setRooms] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    const load = async () => {
      try { const r = await api('/api/rooms'); if (alive) { setRooms(r); setError(''); } }
      catch (e) { if (alive) setError(e.message); }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [user]);

  const stats = (v) => {
    const rs = rooms.filter((r) => r.vertical === v && r.score !== null);
    const avg = rs.length ? rs.reduce((a, r) => a + r.score, 0) / rs.length : null;
    return {
      total: rooms.filter((r) => r.vertical === v).length,
      avg,
      critical: rs.filter((r) => r.score >= 80).length,
      high: rs.filter((r) => r.score >= 60 && r.score < 80).length,
      hardware: rs.filter(isLiveHardware).length,
    };
  };

  return (
    <Shell user={user}>
      <div className="row"><div><h1>Portfolio overview</h1><div className="muted small">All verticals, refreshed every 5 s</div></div><LiveBadge rooms={rooms} /></div>
      {error ? <div className="error">{error}</div> : null}
      <h2>Verticals</h2>
      <div className="grid g3">
        {Object.entries(VERTICALS).map(([key, v]) => {
          const locked = user && user.vertical_access !== 'all' && user.vertical_access !== key;
          const s = stats(key);
          return (
            <div key={key} className="card" style={locked ? { opacity: 0.45 } : undefined}>
              <div className="row"><b>{v.label}</b>{locked ? <span className="muted small">no access</span> : null}</div>
              <div className="grid g4" style={{ margin: '12px 0' }}>
                <div className="stat"><div className="n">{s.total}</div><div className="l">rooms</div></div>
                <div className="stat"><div className="n">{s.avg === null ? '—' : Math.round(s.avg)}</div><div className="l">avg risk</div></div>
                <div className="stat"><div className="n">{s.critical + s.high}</div><div className="l">high / critical</div></div>
                <div className="stat"><div className="n">{s.hardware}</div><div className="l">real hardware</div></div>
              </div>
              {locked ? null : <Link className="btn" href={`/dashboard/${key}`}>Open dashboard</Link>}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}
