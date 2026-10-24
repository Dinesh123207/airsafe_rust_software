'use client';
import { SourceTag } from './Primitives';
import { spectrum, spectrumIaq, toIaq, riskLabel, iaqLabel, vocLabel, hotelIssue, FOCUS_CO2 } from '../../lib/risk.mjs';

const dash = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
const round = (v) => (v === null || v === undefined ? null : Math.round(v));

function NoData({ room, onOpen }) {
  return (
    <button type="button" className="room-card" style={{ '--accent': 'var(--text-3)' }} onClick={() => onOpen(room.id)}>
      <div className="rc-name">{room.name}</div>
      <div className="rc-sub">{room.department}</div>
      <div className="rc-status">Waiting for first reading</div>
    </button>
  );
}

export function HospitalCard({ room: r, onOpen }) {
  if (r.score === null || r.score === undefined) return <NoData room={r} onOpen={onOpen} />;
  const color = spectrum(r.score);
  return (
    <button type="button" className="room-card" style={{ '--accent': color }} onClick={() => onOpen(r.id)}
      aria-label={`${r.name}, risk index ${Math.round(r.score)}, ${riskLabel(r.score)}`}>
      <div className="rc-top"><span className="rc-name">{r.name}</span><SourceTag room={r} /></div>
      <div className="rc-sub">{r.department}</div>
      <div className="rc-label">TRANSMISSION RISK INDEX</div>
      <div className="rc-score-row"><span className="rc-score" style={{ color }}>{Math.round(r.score)}</span><span className="rc-max">/100</span></div>
      <div className="rc-status">{riskLabel(r.score)}</div>
      <div className="rc-metrics">
        <Metric l="CO₂" v={dash(round(r.co2_ppm), ' ppm')} />
        <Metric l="PM2.5" v={dash(r.pm25_ugm3, ' µg/m³')} />
        <Metric l="Temp" v={dash(r.temp_c, '°C')} />
        <Metric l="RH" v={dash(r.rh_pct, '%')} />
        <Metric l="Occupancy" v={`${dash(r.occupancy)} / ${r.capacity}`} />
        <Metric l="Est. ACH" v={dash(r.est_ach)} />
        {r.diff_pressure_pa !== null && r.diff_pressure_pa !== undefined ? <Metric l="Diff. pressure" v={`${r.diff_pressure_pa} Pa`} /> : null}
      </div>
    </button>
  );
}

export function HotelCard({ room: r, onOpen }) {
  if (r.score === null || r.score === undefined) return <NoData room={r} onOpen={onOpen} />;
  const iaq = toIaq(r.score);
  const color = spectrumIaq(iaq);
  const occupied = (r.occupancy ?? 0) > 0;
  const issue = hotelIssue(r);
  const co2Tag = r.co2_ppm >= 900 ? ' · Elevated' : r.co2_ppm >= 700 ? ' · Monitor' : '';
  const pmTag = r.pm25_ugm3 >= 18 ? ' · Monitor' : '';
  return (
    <button type="button" className="room-card" style={{ '--accent': color }} onClick={() => onOpen(r.id)}
      aria-label={`${r.name}, IAQ score ${iaq}, ${iaqLabel(iaq)}`}>
      <div className="rc-top">
        <span className="rc-name">{r.name}</span>
        <span className={`occ-tag ${occupied ? 'occ' : 'vac'}`}>{occupied ? `Occupied · ${r.occupancy}` : 'Vacant'}</span>
      </div>
      <div className="rc-label">IAQ SCORE</div>
      <div className="rc-score-row"><span className="rc-score" style={{ color }}>{iaq}</span></div>
      <div className="rc-status">{iaqLabel(iaq)}</div>
      <div className="rc-issue">{issue || 'No active environmental alerts'}</div>
      <div className="rc-metrics">
        <Metric l="CO₂" v={`${dash(round(r.co2_ppm))} ppm${co2Tag}`} />
        <Metric l="PM2.5" v={`${dash(round(r.pm25_ugm3))} µg/m³${pmTag}`} />
        <Metric l="TVOC" v={vocLabel(r.tvoc_ppb)} />
        <Metric l="Temp / RH" v={`${dash(round(r.temp_c))}°C · ${dash(round(r.rh_pct))}%`} />
      </div>
      <div style={{ marginTop: 8 }}><SourceTag room={r} /></div>
    </button>
  );
}

export function ZoneCard({ room: r, onOpen }) {
  if (r.score === null || r.score === undefined) return <NoData room={r} onOpen={onOpen} />;
  const iaq = toIaq(r.score);
  const color = spectrumIaq(iaq);
  const isMeeting = r.room_type === 'meeting';
  const ghost = Boolean(r.booked) && r.occupancy === 0;
  const pct = r.capacity ? Math.min(100, ((r.occupancy ?? 0) / r.capacity) * 100) : 0;
  return (
    <button type="button" className="room-card" style={{ '--accent': color }} onClick={() => onOpen(r.id)}
      aria-label={`${r.name}, environmental score ${iaq}, ${iaqLabel(iaq)}${ghost ? ', meeting no-show' : ''}`}>
      <div className="rc-top"><span className="rc-name">{r.name}</span>{ghost ? <span className="ghost-badge">NO-SHOW</span> : <SourceTag room={r} />}</div>
      <div className="rc-label">ENVIRONMENTAL SCORE</div>
      <div className="rc-score-row"><span className="rc-score" style={{ color }}>{iaq}</span></div>
      <div className="rc-status">{iaqLabel(iaq)}</div>
      <div className="rc-metrics">
        <Metric l="CO₂" v={`${dash(round(r.co2_ppm))}${r.co2_ppm >= FOCUS_CO2 ? ' ⚠' : ''} ppm`} />
        <Metric l="PM2.5" v={dash(round(r.pm25_ugm3), ' µg/m³')} />
        <Metric l="Temp" v={dash(round(r.temp_c), '°C')} />
        <Metric l="RH" v={dash(round(r.rh_pct), '%')} />
      </div>
      <div className="util-row">
        <div className="util-label"><span>{isMeeting ? `Occupancy (capacity ${r.capacity})` : 'Occupancy'}</span><span>{r.occupancy ?? 0}/{r.capacity}</span></div>
        <div className="util-track"><div className="util-fill" style={{ width: `${pct}%`, background: ghost ? 'var(--bad)' : color }} /></div>
      </div>
    </button>
  );
}

function Metric({ l, v }) {
  return <div className="rc-metric"><span className="rc-ml">{l}</span><span className="rc-mv">{v}</span></div>;
}
