'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

const WINDOWS = [[15, '15 min'], [60, '1 h'], [360, '6 h'], [1440, '24 h']];
const BAND_COLORS = { Safe: '#1C4E9C', Low: '#1F9E7A', Moderate: '#E8C13A', High: '#E86A2E', Critical: '#D62839' };
const f = (v, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);

/** What the readings add up to over a window: statistics, time above thresholds, risk bands, ventilation, sensor health. */
export default function AnalysisPanel({ roomId, refreshKey }) {
  const [minutes, setMinutes] = useState(60);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api(`/api/rooms/${encodeURIComponent(roomId)}/analysis?minutes=${minutes}`)
      .then((d) => { if (alive) { setData(d); setError(''); } })
      .catch((e) => { if (alive) setError(e.message || 'Could not load the analysis'); });
    return () => { alive = false; };
  }, [roomId, minutes, refreshKey]);

  const bands = data?.risk?.minutes_by_band;
  const totalBand = bands ? Object.values(bands).reduce((a, b) => a + b, 0) : 0;
  const mix = data?.source_mix;

  return (
    <div className="an">
      <div className="an-win" role="group" aria-label="Analysis window">
        {WINDOWS.map(([m, label]) => (
          <button type="button" key={m} className={`an-chip${m === minutes ? ' active' : ''}`} aria-pressed={m === minutes} onClick={() => setMinutes(m)}>{label}</button>
        ))}
      </div>
      {error ? <div className="ledger-err" role="alert">{error}</div> : null}
      {!data && !error ? <div className="rc-sub">Analysing…</div> : null}

      {data && data.sample_count === 0 ? <div className="rc-sub">No readings in this window yet.</div> : null}
      {data && data.sample_count > 0 ? (
        <>
          <div className="rc-sub">
            {data.sample_count} readings, every {f(data.median_interval_s, ' s')}, newest {f(data.last_age_s, ' s')} old
            {mix && mix.simulator > 0 && mix.device > 0 ? ` · mixed data: ${mix.device} from hardware, ${mix.simulator} simulated` : mix && mix.device === 0 ? ' · simulated data' : ' · hardware data'}
          </div>

          {data.flags.length > 0 ? (
            <div className="an-flags" role="status">{data.flags.map((x) => <div key={x} className="an-flag">⚠ {x}</div>)}</div>
          ) : null}

          <div className="metric-grid">
            <Stat l="CO₂ mean / peak" v={`${f(data.co2.mean)} / ${f(data.co2.max)} ppm`} />
            <Stat l="CO₂ above 1000 ppm" v={f(data.co2.minutes_above_1000, ' min')} />
            <Stat l="PM2.5 mean / peak" v={data.pm25.samples ? `${f(data.pm25.mean)} / ${f(data.pm25.max)} µg/m³` : 'no PM data'} />
            <Stat l="PM2.5 above WHO" v={data.pm25.samples ? f(data.pm25.minutes_above_who, ' min') : '—'} />
            <Stat l="Temperature mean" v={data.temperature.samples ? f(data.temperature.mean, ' °C') : 'no data'} />
            <Stat l="Humidity mean" v={data.humidity.samples ? f(data.humidity.mean, ' %') : 'no data'} />
            <Stat l="Peak occupancy" v={f(data.occupancy.max)} />
            <Stat l="Ventilation (est.)" v={data.ventilation.estimated_ach === null ? 'not measurable yet' : `${data.ventilation.estimated_ach} ACH`} />
          </div>

          {bands ? (
            <>
              <div className="rc-ml" style={{ marginTop: 10 }}>Time in each risk band</div>
              <div className="an-band" role="img" aria-label={Object.entries(bands).map(([k, v]) => `${k} ${v} minutes`).join(', ')}>
                {Object.entries(bands).filter(([, v]) => v > 0).map(([k, v]) => (
                  <div key={k} title={`${k}: ${v} min`} style={{ width: `${(v / (totalBand || 1)) * 100}%`, background: BAND_COLORS[k] }} />
                ))}
              </div>
              <div className="an-legend">{Object.entries(bands).filter(([, v]) => v > 0).map(([k, v]) => <span key={k}><i style={{ background: BAND_COLORS[k] }} />{k} {v} min</span>)}</div>
            </>
          ) : null}

          <div className="an-ins">{data.insights.map((x) => <div key={x}>• {x}</div>)}</div>

          {data.ventilation.episodes.length > 0 ? (
            <div className="rc-sub">Ventilation estimated from {data.ventilation.episodes.length} empty-room CO₂ decay episode(s):{' '}
              {data.ventilation.episodes.map((e) => `${e.ach} ACH over ${e.minutes} min (R² ${e.r2})`).join('; ')}</div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Stat({ l, v }) {
  return <div className="rc-metric"><span className="rc-ml">{l}</span><span className="rc-mv">{v}</span></div>;
}
