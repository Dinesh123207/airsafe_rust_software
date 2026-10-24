'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { hardwareSummary } from '../../lib/risk.mjs';

export function ModeBadge({ rooms, offline }) {
  const { live, total } = hardwareSummary(rooms);
  if (offline) return <span className="mode-badge off">OFFLINE · SHOWING LAST DATA</span>;
  // Never claim LIVE just because the API answered: only real, fresh hardware readings count.
  if (live > 0) return <span className="mode-badge on">LIVE · {live}/{total} ON HARDWARE</span>;
  return <span className="mode-badge sim">CONNECTED · SIMULATED DATA</span>;
}

function Clock() {
  const [now, setNow] = useState(null);       // null on the server render: no hydration mismatch
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="dash-clock" suppressHydrationWarning>
      {now ? now.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short' }) : ''}
    </span>
  );
}

export function Topbar({ config, rooms, offline, user, onLogout }) {
  return (
    <header className="dash-top">
      <div className="dash-brand">
        <div className="dash-logo" aria-hidden="true">A</div>
        <div>
          <div className="dash-title">{config.title}</div>
          <div className="dash-sub">{config.subtitle}</div>
        </div>
      </div>
      <div className="dash-right">
        <ModeBadge rooms={rooms} offline={offline} />
        <Clock />
        <Link className="dash-link" href="/master-admin">Overview</Link>
        <Link className="dash-link" href="/devices">Devices</Link>
        <span className="dash-user" title={user ? `${user.email} · ${user.role}` : ''}>{user?.email || ''}</span>
        <button type="button" className="dash-btn" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}

export function KpiStrip({ items }) {
  return (
    <section className="kpi-strip" aria-label="Key indicators">
      {items.map((k) => (
        <div className="kpi" key={k.label}>
          <span className="kpi-label">{k.label}</span>
          <div className="kpi-row">
            <span className="kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value === null || k.value === undefined ? '—' : k.value}</span>
            {k.unit ? <span className="kpi-unit">{k.unit}</span> : null}
          </div>
          {k.sub ? <span className="kpi-sub">{k.sub}</span> : null}
        </div>
      ))}
    </section>
  );
}

export function FilterSidebar({ title, options, active, onSelect, colorFor }) {
  return (
    <aside className="dash-side" aria-label={title}>
      <div className="side-title">{title}</div>
      {options.map((o) => (
        <button type="button" key={o.name} className={`side-item${o.name === active ? ' active' : ''}`}
          aria-pressed={o.name === active} onClick={() => onSelect(o.name)}>
          <span className="side-dot" style={{ background: o.avgRisk === null ? 'var(--text-3)' : colorFor(o.avgRisk) }} />
          <span className="side-name">{o.name}</span>
          <span className="side-count">{o.count}</span>
        </button>
      ))}
    </aside>
  );
}

export function FeedPanel({ title, sub, items, emptyText, onOpen }) {
  return (
    <aside className="dash-feed" aria-label={title}>
      <div className="feed-title">{title}</div>
      <div className="feed-sub">{sub}</div>
      {items.length === 0 ? <div className="feed-item" style={{ '--accent': 'var(--text-3)' }}><div className="feed-room">{emptyText}</div></div> : null}
      {items.map((i) => (
        <button type="button" key={i.key} className="feed-item" style={{ '--accent': i.accent }} onClick={() => onOpen(i.roomId)}>
          <div className="feed-top">{i.top}</div>
          <div className="feed-room">{i.title}</div>
          {i.detail ? <div className="feed-detail">{i.detail}</div> : null}
          {i.rec ? <div className="feed-rec">{i.rec}</div> : null}
        </button>
      ))}
    </aside>
  );
}

export function SourceTag({ room }) {
  if (!room.source) return null;
  const hw = String(room.source).startsWith('device:');
  if (hw && room.stale) return <span className="tag stale" title="Device has gone quiet (no data for 2+ minutes)">STALE</span>;
  if (hw) {
    return (
      <span className="tag-group">
        <span className="tag hw" title={room.source}>HARDWARE</span>
        {room.attested ? <span className="tag signed" title="Signed by the device's own key (Ed25519)">SIGNED</span> : null}
      </span>
    );
  }
  if (room.stale) return <span className="tag stale" title="A device is assigned but not reporting yet">NO DEVICE DATA</span>;
  return <span className="tag sim">SIMULATED</span>;
}
