// Room analysis over a time window: statistics, time above thresholds, risk bands, ventilation (air changes per hour)
// estimated from CO2 decay, trend, sensor health and plain-language insights.
// Reference implementation: backend/src/analysis.rs must reproduce it (backend/fixtures/analysis_vectors.json).
import { computeScore, statusLabel, CO2_OUTDOOR_PPM, PM25_WHO_24H_UGM3 } from './risk.mjs';

export const MAX_GAP_MS = 5 * 60 * 1000;      // a gap longer than this is "no data", not "the same value"
const MIN_EPISODE_MS = 10 * 60 * 1000;
const MIN_EPISODE_SAMPLES = 5;
const MIN_DROP_PPM = 150;
const MIN_R2 = 0.9;
const STUCK_RUN = 10;

const round = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number((Math.round(x * 10 ** d) / 10 ** d).toFixed(d)));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function p95(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]; }

function stats(values, d = 1) {
  const v = values.filter((x) => x !== null && x !== undefined);
  if (!v.length) return { min: null, max: null, mean: null, p95: null, samples: 0 };
  return { min: round(Math.min(...v), d), max: round(Math.max(...v), d), mean: round(mean(v), d), p95: round(p95(v), d), samples: v.length };
}

// least-squares line y = a + b*x ; returns {b, r2}
function linfit(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (sxx === 0) return { b: 0, r2: 0 };
  const b = sxy / sxx;
  return { b, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

/** samples: ascending by t_ms. Each: {t_ms, co2, pm25, pm10, tvoc, temp, rh, occ, dp, air} (null when not measured). */
export function analyze(samples, { windowMinutes, nowMs }) {
  const n = samples.length;
  const out = { window_minutes: windowMinutes, sample_count: n, insights: [], flags: [] };
  if (n === 0) {
    out.insights.push('No readings in this window yet.');
    return { ...out, last_age_s: null, median_interval_s: null, co2: null, pm25: null, temperature: null, humidity: null, occupancy: null, risk: null, ventilation: null, trend: null, completeness: null };
  }

  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(samples[i].t_ms - samples[i - 1].t_ms);
  const medGap = gaps.length ? median(gaps) : 30000;
  const dt = samples.map((s, i) => (i < n - 1 ? Math.min(samples[i + 1].t_ms - s.t_ms, MAX_GAP_MS) : Math.min(medGap, MAX_GAP_MS)));
  const minutesWhere = (pred) => round(samples.reduce((acc, s, i) => acc + (pred(s) ? dt[i] : 0), 0) / 60000, 1);

  out.last_age_s = round((nowMs - samples[n - 1].t_ms) / 1000, 0);
  out.median_interval_s = round(medGap / 1000, 1);

  const co2v = samples.map((s) => s.co2);
  out.co2 = { ...stats(co2v), minutes_above_800: minutesWhere((s) => s.co2 > 800), minutes_above_1000: minutesWhere((s) => s.co2 > 1000), minutes_above_1500: minutesWhere((s) => s.co2 > 1500) };
  out.pm25 = { ...stats(samples.map((s) => s.pm25)), minutes_above_who: minutesWhere((s) => s.pm25 !== null && s.pm25 > PM25_WHO_24H_UGM3) };
  out.temperature = stats(samples.map((s) => s.temp));
  out.humidity = stats(samples.map((s) => s.rh));
  const occ = samples.map((s) => s.occ);
  out.occupancy = { max: occ.some((v) => v !== null) ? Math.max(...occ.filter((v) => v !== null)) : null, mean: round(mean(occ.filter((v) => v !== null)), 2), minutes_occupied: minutesWhere((s) => s.occ !== null && s.occ > 0) };

  const scores = samples.map((s) => computeScore(s.co2, s.pm25 ?? 0, s.dp ?? null).score);
  const bands = { Safe: 0, Low: 0, Moderate: 0, High: 0, Critical: 0 };
  scores.forEach((sc, i) => { bands[statusLabel(sc)] += dt[i] / 60000; });
  Object.keys(bands).forEach((k) => { bands[k] = round(bands[k], 1); });
  out.risk = { mean: round(mean(scores), 1), max: round(Math.max(...scores), 1), minutes_by_band: bands };

  // ---- ventilation from CO2 decay while the room is empty ----
  const episodes = [];
  let reason = null;
  if (!occ.some((v) => v !== null)) reason = 'No occupancy data, so empty-room CO2 decay cannot be identified.';
  else {
    let i = 0;
    while (i < n) {
      if (samples[i].occ !== 0) { i++; continue; }
      let j = i;
      while (j + 1 < n && samples[j + 1].occ === 0 && samples[j + 1].t_ms - samples[j].t_ms <= MAX_GAP_MS) j++;
      let peak = i;
      for (let k = i; k <= j; k++) if (samples[k].co2 > samples[peak].co2) peak = k;
      const seg = samples.slice(peak, j + 1);
      if (seg.length >= MIN_EPISODE_SAMPLES && seg[seg.length - 1].t_ms - seg[0].t_ms >= MIN_EPISODE_MS && seg[0].co2 - CO2_OUTDOOR_PPM >= MIN_DROP_PPM) {
        const xs = seg.map((s) => (s.t_ms - seg[0].t_ms) / 1000);
        const ys = seg.map((s) => Math.log(Math.max(1, s.co2 - CO2_OUTDOOR_PPM)));
        const { b, r2 } = linfit(xs, ys);
        const ach = -b * 3600;
        if (b < 0 && r2 >= MIN_R2 && ach >= 0.05 && ach <= 60) {
          episodes.push({ start_ms: seg[0].t_ms, end_ms: seg[seg.length - 1].t_ms, minutes: round((seg[seg.length - 1].t_ms - seg[0].t_ms) / 60000, 1), start_co2: round(seg[0].co2, 1), end_co2: round(seg[seg.length - 1].co2, 1), ach: round(ach, 2), r2: round(r2, 3) });
        }
      }
      i = j + 1;
    }
    if (!episodes.length) reason = 'No clean empty-room CO2 decay of 10+ minutes in this window (needs the room to empty out after being occupied).';
  }
  out.ventilation = { estimated_ach: episodes.length ? round(median(episodes.map((e) => e.ach)), 2) : null, episodes, note: reason };

  // ---- trend over the last 15 minutes ----
  const recent = samples.filter((s) => s.t_ms >= samples[n - 1].t_ms - 15 * 60000);
  if (recent.length >= 3 && recent[recent.length - 1].t_ms > recent[0].t_ms) {
    const { b } = linfit(recent.map((s) => (s.t_ms - recent[0].t_ms) / 60000), recent.map((s) => s.co2));
    out.trend = { co2_ppm_per_min: round(b, 2), minutes_used: round((recent[recent.length - 1].t_ms - recent[0].t_ms) / 60000, 1) };
  } else out.trend = null;

  // ---- sensor health ----
  const fields = { pm25: 'pm25', pm10: 'pm10', tvoc: 'tvoc', temperature: 'temp', humidity: 'rh', occupancy: 'occ', air_velocity: 'air', diff_pressure: 'dp' };
  out.completeness = {};
  for (const [name, key] of Object.entries(fields)) out.completeness[name] = round((samples.filter((s) => s[key] !== null && s[key] !== undefined).length / n) * 100, 1);
  const longestRun = (get) => { let best = 1, run = 1; for (let k = 1; k < n; k++) { const a = get(samples[k]), b = get(samples[k - 1]); if (a !== null && a !== undefined && a === b) { run++; best = Math.max(best, run); } else run = 1; } return best; };
  const stuckCo2 = longestRun((s) => s.co2);
  if (stuckCo2 >= STUCK_RUN) out.flags.push(`CO2 reading identical for ${stuckCo2} samples in a row: sensor may be stuck or still warming up.`);
  if (n > 1 && out.completeness.pm25 < 50) out.flags.push('PM2.5 is missing from most readings: check the PM sensor wiring.');
  if (n > 1 && out.completeness.occupancy < 50) out.flags.push('Occupancy is missing from most readings: check the occupancy sensor (LD2410 baud rate).');
  if (n > 1 && out.completeness.temperature < 50) out.flags.push('Temperature/humidity are missing from most readings: check the SHT31.');
  if (out.last_age_s > 120) out.flags.push(`Newest reading is ${out.last_age_s} s old: the device may be offline.`);

  // ---- plain-language insights ----
  const ins = out.insights;
  const c = out.co2;
  ins.push(`CO2 averaged ${c.mean} ppm (peak ${c.max} ppm).`);
  if (c.minutes_above_1000 > 0) ins.push(`CO2 was above 1000 ppm for ${c.minutes_above_1000} min${c.minutes_above_1500 > 0 ? ` (${c.minutes_above_1500} min above 1500 ppm)` : ''}: indicates poor ventilation for the occupancy.`);
  else if (c.minutes_above_800 > 0) ins.push(`CO2 was above 800 ppm for ${c.minutes_above_800} min: acceptable, but ventilation margin is small.`);
  else ins.push('CO2 stayed below 800 ppm: ventilation is keeping up.');
  if (out.pm25.samples > 0 && out.pm25.minutes_above_who > 0) ins.push(`PM2.5 exceeded the WHO 24 h guideline (${PM25_WHO_24H_UGM3} µg/m³) for ${out.pm25.minutes_above_who} min (peak ${out.pm25.max} µg/m³).`);
  if (out.ventilation.estimated_ach !== null) ins.push(`Estimated ventilation about ${out.ventilation.estimated_ach} air changes/hour from ${episodes.length} empty-room CO2 decay episode(s). Compare with your facility's specification.`);
  else ins.push(`Ventilation rate could not be estimated: ${out.ventilation.note}`);
  if (out.trend && out.trend.co2_ppm_per_min > 5) ins.push(`CO2 is rising about ${out.trend.co2_ppm_per_min} ppm/min over the last ${out.trend.minutes_used} min.`);
  if (out.risk.minutes_by_band.High + out.risk.minutes_by_band.Critical > 0) ins.push(`Risk index was High or Critical for ${round(out.risk.minutes_by_band.High + out.risk.minutes_by_band.Critical, 1)} min (peak ${out.risk.max}/100).`);
  return out;
}
