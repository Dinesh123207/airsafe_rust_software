'use client';
import { useCallback, useEffect, useState } from 'react';
import Shell from '../../components/Shell';
import { useAuth } from '../../lib/useAuth';
import { api } from '../../lib/api';

export default function Devices() {
  const user = useAuth();
  const [devices, setDevices] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [form, setForm] = useState({ device_id: '', room_id: '', label: '', public_key: '', require_signature: false });
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setDevices(await api('/api/devices')); setError(''); } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    load();
    api('/api/rooms').then((r) => { setRooms(r); setForm((f) => (f.room_id ? f : { ...f, room_id: r[0]?.id || '' })); }).catch(() => {});
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [user, load]);

  async function provision(e) {
    e.preventDefault();
    setBusy(true); setError(''); setIssued(null);
    try {
      const body = { device_id: form.device_id.trim(), room_id: form.room_id, label: form.label.trim() || null,
        public_key: form.public_key.trim() || null, require_signature: Boolean(form.public_key.trim()) && form.require_signature };
      setIssued(await api('/api/devices/provision', { method: 'POST', body }));
      setForm({ ...form, device_id: '', label: '', public_key: '', require_signature: false });
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
  };

  return (
    <Shell user={user}>
      <h1>Devices</h1>
      <div className="muted small">A provisioned device owns its room: the simulator stops writing there.</div>
      {error ? <div className="error">{error}</div> : null}

      <h2>Provision a device</h2>
      <form className="card" onSubmit={provision} style={{ maxWidth: 520 }}>
        <label htmlFor="did">Device ID (goes in firmware config.h)</label>
        <input id="did" value={form.device_id} onChange={(e) => setForm({ ...form, device_id: e.target.value })} placeholder="esp32-iso1-01" required />
        <label htmlFor="room">Room</label>
        <select id="room" value={form.room_id} onChange={(e) => setForm({ ...form, room_id: e.target.value })} required>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.vertical} · {r.name} ({r.id})</option>)}
        </select>
        <label htmlFor="label">Label (optional)</label>
        <input id="label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <label htmlFor="pk">Device public key (optional): Ed25519, 64 hex characters or did:key</label>
        <input id="pk" value={form.public_key} onChange={(e) => setForm({ ...form, public_key: e.target.value })} placeholder="did:key:z6Mk…" />
        <label className="check"><input type="checkbox" checked={form.require_signature} disabled={!form.public_key.trim()}
          onChange={(e) => setForm({ ...form, require_signature: e.target.checked })} /> Reject readings that are not signed by this key</label>
        <div style={{ marginTop: 16 }}><button disabled={busy} type="submit">Provision</button></div>
        {issued ? (
          <div className="keybox">
            <div className="small muted">API key for {issued.device_id}: shown ONCE. Copy it now.</div>
            <div style={{ marginTop: 6 }}>{issued.api_key}</div>
            <button className="ghost" type="button" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(issued.api_key)}>Copy</button>
          </div>
        ) : null}
      </form>

      <h2>Provisioned devices</h2>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Device</th><th>Room</th><th>Vertical</th><th>Firmware</th><th>Identity</th><th>Last seen</th><th>Status</th></tr></thead>
          <tbody>
            {devices.length === 0 ? <tr><td colSpan={7} className="muted">No devices yet</td></tr> : devices.map((d) => (
              <tr key={d.id}>
                <td>{d.id}</td><td>{d.room_name}</td><td>{d.vertical}</td><td>{d.firmware_version || '—'}</td>
                <td className="mono" title={d.did || ''}>{d.did ? `${d.did.slice(0, 18)}…${d.require_signature ? ' · required' : ''}` : 'API key only'}</td>
                <td>{ago(d.last_seen_at)}</td>
                <td><span className={`dot ${d.online ? 'on' : 'off'}`} />{d.online ? 'online' : 'offline'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
