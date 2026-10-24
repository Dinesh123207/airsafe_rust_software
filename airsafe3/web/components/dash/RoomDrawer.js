'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { SourceTag } from './Primitives';
import AnalysisPanel from './AnalysisPanel';
import { verifyProof } from '../../lib/verify';
import { spectrum, spectrumIaq, toIaq, riskLabel, iaqLabel, ago, CERT_CO2, FOCUS_CO2 } from '../../lib/risk.mjs';

export function MiniChart({ values, min = 0, max, color, refs = [], label }) {
  if (!values || values.length < 2) return <div className="chart-empty">Not enough history yet</div>;
  const W = 300, H = 70;
  const hi = max ?? Math.max(...values, ...refs.map((r) => r.v)) * 1.05;
  const y = (v) => H - ((Math.min(Math.max(v, min), hi) - min) / (hi - min || 1)) * H;
  const step = W / (values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={label} preserveAspectRatio="none">
      {refs.map((r) => <line key={r.v} x1="0" x2={W} y1={y(r.v)} y2={y(r.v)} stroke="var(--text-3)" strokeDasharray="4 4" strokeWidth="1" />)}
      <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const fmt = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);

export default function RoomDrawer({ room, vertical, onClose }) {
  const [history, setHistory] = useState([]);
  const [check, setCheck] = useState(null);   // { state: 'running'|'done'|'error', result?, proof?, message? }
  const closeRef = useRef(null);

  useEffect(() => { closeRef.current?.focus(); }, [room.id]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Refetch whenever a new reading arrives for this room.
  useEffect(() => {
    let alive = true;
    api(`/api/rooms/${encodeURIComponent(room.id)}/history?limit=90`)
      .then((h) => { if (alive) setHistory(h); })
      .catch(() => {});
    return () => { alive = false; };
  }, [room.id, room.timestamp]);

  useEffect(() => { setCheck(null); }, [room.id, room.reading_id]);

  async function verify() {
    setCheck({ state: 'running' });
    try {
      const proof = await api(`/api/ledger/proof/${room.reading_id}`);
      setCheck({ state: 'done', proof, result: await verifyProof(proof) });
    } catch (e) {
      setCheck({ state: 'error', message: e.message || 'Could not load the proof' });
    }
  }

  const hardware = String(room.source || '').startsWith('device:') && room.reading_id;
  const hospital = vertical === 'hospital';
  const hasScore = room.score !== null && room.score !== undefined;
  const iaq = hasScore ? toIaq(room.score) : null;
  const color = hasScore ? (hospital ? spectrum(room.score) : spectrumIaq(iaq)) : 'var(--text-3)';
  const scoreSeries = history.map((h) => (hospital ? h.score : toIaq(h.score)));

  const metrics = [
    ['CO₂', fmt(room.co2_ppm, ' ppm')], ['PM2.5', fmt(room.pm25_ugm3, ' µg/m³')], ['PM10', fmt(room.pm10_ugm3, ' µg/m³')],
    ['TVOC', fmt(room.tvoc_ppb, ' ppb')], ['Temperature', fmt(room.temp_c, ' °C')], ['Humidity', fmt(room.rh_pct, ' %')],
    ['Occupancy', `${fmt(room.occupancy)} / ${room.capacity}`], ['Air velocity', fmt(room.air_velocity_ms, ' m/s')],
    ['Diff. pressure', fmt(room.diff_pressure_pa, ' Pa')], ['Est. ACH', fmt(room.est_ach)],
  ];

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={`${room.name} details`} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <div className="drawer-name">{room.name}</div>
            <div className="rc-sub">{room.department} · {room.tier}</div>
          </div>
          <button type="button" className="dash-btn" ref={closeRef} onClick={onClose}>Close</button>
        </div>

        <div className="drawer-score" style={{ '--accent': color }}>
          <span className="rc-score" style={{ color }}>{hasScore ? (hospital ? Math.round(room.score) : iaq) : '—'}</span>
          <span className="rc-max">/100</span>
          <span className="drawer-status">{hasScore ? (hospital ? riskLabel(room.score) : iaqLabel(iaq)) : 'No data yet'}</span>
          <SourceTag room={room} />
        </div>
        <div className="rc-sub">{hospital ? 'Transmission risk index' : 'IAQ score (higher is better)'} · updated {ago(room.timestamp)}</div>

        <div className="metric-grid">
          {metrics.map(([l, v]) => <div key={l} className="rc-metric"><span className="rc-ml">{l}</span><span className="rc-mv">{v}</span></div>)}
        </div>

        <div className="drawer-sec">CO₂ over time <span className="rc-sub">dashed: {CERT_CO2} / {FOCUS_CO2} ppm</span></div>
        <MiniChart values={history.map((h) => h.co2_ppm)} min={400} color="var(--chart-a)" refs={[{ v: CERT_CO2 }, { v: FOCUS_CO2 }]} label="CO2 history" />

        <div className="drawer-sec">{hospital ? 'Risk index' : 'IAQ score'} over time</div>
        <MiniChart values={scoreSeries} min={0} max={100} color={color} label="Score history" />

        <div className="drawer-sec">Analysis</div>
        <AnalysisPanel roomId={room.id} refreshKey={Math.floor(new Date(room.timestamp || 0).getTime() / 30000)} />

        {room.drivers && room.drivers.length ? (
          <>
            <div className="drawer-sec">Why this score</div>
            {room.drivers.map((d) => (
              <div key={d.factor} className="driver">
                <div className="driver-top"><span>{d.factor}</span><b>+{d.contribution}</b></div>
                <div className="rc-sub">{d.value}</div>
                <div className="driver-src">{d.source}</div>
              </div>
            ))}
          </>
        ) : null}
        <div className="drawer-sec">Data integrity</div>
        {hardware ? (
          <>
            <div className="rc-sub" style={{ marginBottom: 8 }}>
              Re-checks this reading in your browser: its ledger hash, the device signature, the Merkle proof and the signed checkpoint.
            </div>
            <button type="button" className="dash-btn" onClick={verify} disabled={check?.state === 'running'}>
              {check?.state === 'running' ? 'Verifying…' : 'Verify this reading'}
            </button>
            {check?.state === 'error' ? <div className="ledger-err" role="alert">{check.message}</div> : null}
            {check?.state === 'done' ? (
              <div className="ledger-checks" data-ok={String(check.result.ok)}>
                <div className="ledger-verdict">{check.result.ok ? 'All checks that can run here passed' : 'VERIFICATION FAILED'}
                  <span> · proof status: {check.proof.status}</span></div>
                {check.result.steps.map((st) => (
                  <div key={st.id} className={`ledger-step ${st.ok === true ? 'pass' : st.ok === false ? 'fail' : 'skip'}`}>
                    <span className="ledger-mark">{st.ok === true ? '✓' : st.ok === false ? '✗' : '–'}</span>
                    <div><div>{st.label}</div><div className="rc-sub">{st.detail}</div></div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className="rc-sub">Simulated readings are not part of the ledger: only data from provisioned hardware is hashed and anchored.</div>
        )}
        {room.booked ? <div className="drawer-sec">Booked{room.occupancy === 0 ? ': no occupancy detected (no-show)' : ''}</div> : null}
      </div>
    </div>
  );
}
