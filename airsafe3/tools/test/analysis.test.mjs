import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyze } from '../lib/analysis.mjs';

// deterministic noise (same on every run)
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5);

const T0 = 1_760_000_000_000;
/** 30 s samples. phases: [{minutes, occ, kind:'rise'|'decay', ach}] */
function scenario(phases, { ach = 4, noise = 4 } = {}) {
  const s = []; let co2 = 440, t = T0;
  for (const ph of phases) {
    for (let k = 0; k < ph.minutes * 2; k++) {
      if (ph.occ > 0) co2 += (425 + 1100 - co2) * 0.05;               // rises toward ~1500 while occupied
      else co2 = 425 + (co2 - 425) * Math.exp(-(ph.ach ?? ach) * 30 / 3600);   // exact first-order decay
      s.push({ t_ms: t, co2: Math.round((co2 + rnd() * noise) * 10) / 10, pm25: 8 + rnd() * 2, pm10: null, tvoc: null, temp: 22.5, rh: 44, occ: ph.occ, dp: null, air: null });
      t += 30000;
    }
  }
  return s;
}
const NOW = (s) => s[s.length - 1].t_ms + 20000;

test('recovers a known ventilation rate from CO2 decay (within 8%)', () => {
  for (const ach of [2, 4, 8]) {
    const s = scenario([{ minutes: 40, occ: 5 }, { minutes: 40, occ: 0, ach }], { ach });
    const a = analyze(s, { windowMinutes: 90, nowMs: NOW(s) });
    assert.equal(a.ventilation.episodes.length, 1, JSON.stringify(a.ventilation));
    const est = a.ventilation.estimated_ach;
    assert.ok(Math.abs(est - ach) / ach < 0.08, `true ${ach}, estimated ${est}`);
  }
});

test('time above thresholds, bands, trend and statistics', () => {
  const s = scenario([{ minutes: 60, occ: 6 }]);
  const a = analyze(s, { windowMinutes: 60, nowMs: NOW(s) });
  assert.ok(a.co2.max > 1300 && a.co2.minutes_above_1000 > 10 && a.co2.minutes_above_800 >= a.co2.minutes_above_1000);
  assert.ok(a.risk.minutes_by_band.High + a.risk.minutes_by_band.Critical + a.risk.minutes_by_band.Moderate > 0);
  assert.equal(a.occupancy.max, 6);
  assert.equal(a.sample_count, 120);
  assert.ok(a.insights.some((x) => /above 1000 ppm/.test(x)));
});

test('missing sensors are reported, not hidden; no occupancy means no ventilation estimate', () => {
  const s = scenario([{ minutes: 30, occ: 3 }]).map((x) => ({ ...x, pm25: null, occ: null, temp: null, rh: null }));
  const a = analyze(s, { windowMinutes: 30, nowMs: NOW(s) });
  assert.equal(a.ventilation.estimated_ach, null);
  assert.match(a.ventilation.note, /No occupancy data/);
  assert.equal(a.completeness.pm25, 0);
  assert.ok(a.flags.some((f) => /PM2.5 is missing/.test(f)) && a.flags.some((f) => /Occupancy is missing/.test(f)) && a.flags.some((f) => /Temperature/.test(f)));
});

test('stuck CO2 and stale data are flagged; empty window is handled', () => {
  const s = scenario([{ minutes: 10, occ: 1 }]).map((x) => ({ ...x, co2: 400 }));
  const a = analyze(s, { windowMinutes: 10, nowMs: NOW(s) + 600000 });
  assert.ok(a.flags.some((f) => /identical for/.test(f)) && a.flags.some((f) => /may be offline/.test(f)));
  const e = analyze([], { windowMinutes: 10, nowMs: T0 });
  assert.equal(e.sample_count, 0); assert.equal(e.co2, null);
});

test('a data gap is not counted as time above a threshold', () => {
  const s = [{ t_ms: T0, co2: 1200 }, { t_ms: T0 + 30000, co2: 1200 }, { t_ms: T0 + 3 * 3600 * 1000, co2: 500 }].map((x) => ({ pm25: 5, pm10: null, tvoc: null, temp: 22, rh: 40, occ: 2, dp: null, air: null, ...x }));
  const a = analyze(s, { windowMinutes: 240, nowMs: s[2].t_ms + 1000 });
  assert.ok(a.co2.minutes_above_1000 <= 5.6, `gap counted: ${a.co2.minutes_above_1000} min`);   // 30 s + 5 min cap, not 3 hours
});

test('write golden vectors for the Rust implementation', () => {
  const cases = [];
  const mk = (name, s, windowMinutes) => { const nowMs = s.length ? NOW(s) : T0; cases.push({ name, window_minutes: windowMinutes, now_ms: nowMs, samples: s, expected: analyze(s, { windowMinutes, nowMs }) }); };
  seed = 777;
  mk('occupied then empty (ACH 4)', scenario([{ minutes: 30, occ: 4 }, { minutes: 35, occ: 0, ach: 4 }, { minutes: 20, occ: 2 }]), 120);
  mk('busy room', scenario([{ minutes: 45, occ: 8 }]), 60);
  mk('sensors missing', scenario([{ minutes: 20, occ: 2 }]).map((x) => ({ ...x, pm25: null, occ: null, temp: null, rh: null })), 30);
  mk('stuck co2', scenario([{ minutes: 10, occ: 1 }]).map((x) => ({ ...x, co2: 400 })), 10);
  mk('empty', [], 15);
  writeFileSync(fileURLToPath(new URL('../../backend/fixtures/analysis_vectors.json', import.meta.url)), JSON.stringify(cases));
  assert.equal(cases.length, 5);
});
