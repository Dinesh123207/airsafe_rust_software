import test from 'node:test';
import assert from 'node:assert/strict';
import { spectrum, spectrumIaq, toIaq, riskLabel, iaqLabel, vocLabel, filterOptions, tierGroups,
  hospitalKpis, hotelKpis, corporateKpis, hardwareSummary, ago, hotelIssue } from '../lib/risk.mjs';

test('spectrum hits the five anchor colours and interpolates between them', () => {
  assert.equal(spectrum(0), 'rgb(28,78,156)');
  assert.equal(spectrum(25), 'rgb(31,158,122)');
  assert.equal(spectrum(100), 'rgb(214,40,57)');
  assert.equal(spectrum(-20), spectrum(0));
  assert.equal(spectrum(250), spectrum(100));
  assert.equal(spectrum(37.5), 'rgb(132,176,90)');           // halfway between 25 and 50
  assert.equal(spectrumIaq(100), spectrum(0));
});

test('labels use the original thresholds', () => {
  assert.deepEqual([0, 19.9, 20, 39, 40, 59, 60, 79, 80].map(riskLabel),
    ['Safe', 'Safe', 'Low Risk', 'Low Risk', 'Moderate Risk', 'Moderate Risk', 'High Risk', 'High Risk', 'Critical Risk']);
  assert.deepEqual([100, 85, 84, 65, 64, 40, 39].map(iaqLabel), ['Good', 'Good', 'Monitor', 'Monitor', 'Action Required', 'Action Required', 'Critical']);
  assert.deepEqual([null, 50, 100, 299, 300].map(vocLabel), ['Low', 'Low', 'Moderate', 'Moderate', 'High']);
  assert.equal(toIaq(34), 66);
  assert.equal(toIaq(null), 100);
});

const R = (o) => ({ vertical: 'hospital', department: 'ICU / CCU', tier: 'Critical Care & Isolation', capacity: 4, occupancy: 0,
  co2_ppm: 600, score: 10, est_ach: 12, drivers: [], source: 'simulator', stale: false, ...o });

test('hospital KPIs', () => {
  const rooms = [R({ score: 10, est_ach: 12 }), R({ score: 70, est_ach: 6 }), R({ score: 90, est_ach: 14 }), R({ score: null, est_ach: null })];
  assert.deepEqual(hospitalKpis(rooms, [1, 2]), { index: 57, attention: 2, alerts: 2, ventilation: 50 });
  assert.deepEqual(hospitalKpis([], []), { index: null, attention: 0, alerts: 0, ventilation: null });
});

test('hotel KPIs: IAQ = 100 - risk; attention and tasks both mean IAQ below 65', () => {
  const drv = [{ factor: 'CO2 rebreathed fraction' }];
  const rooms = [R({ score: 10, occupancy: 2 }), R({ score: 45, drivers: drv }), R({ score: 30, drivers: drv })];
  assert.deepEqual(hotelKpis(rooms), { iaq: 72, attention: 1, occupied: 1, tasks: 1 });
  assert.equal(hotelIssue(rooms[1]), 'CO2 rebreathed fraction: review');
  assert.equal(hotelIssue(rooms[2]), '');
  assert.equal(hotelIssue(R({ score: 36, drivers: drv })), 'CO2 rebreathed fraction: review');   // IAQ 64
  assert.equal(hotelIssue(R({ score: 35, drivers: drv })), '');                                   // IAQ 65
  assert.equal(hotelIssue(R({ score: null, drivers: drv })), '');
});

test('corporate KPIs: utilization, no-shows (booked and empty), CO2 reference share', () => {
  const rooms = [R({ capacity: 10, occupancy: 5, co2_ppm: 700 }), R({ capacity: 10, occupancy: 0, booked: true, co2_ppm: 900 }),
    R({ capacity: 20, occupancy: 0, booked: false, co2_ppm: 450 })];
  assert.deepEqual(corporateKpis(rooms), { iaq: 90, utilization: 13, noShows: 1, reference: 67 });
});

test('filters and tier grouping', () => {
  const rooms = [R({ department: 'A', score: 10 }), R({ department: 'A', score: 30 }), R({ department: 'B', score: 50, tier: 'Other' })];
  const o = filterOptions(rooms, 'department');
  assert.deepEqual(o.map((x) => [x.name, x.count, x.avgRisk]), [['All', 3, 30], ['A', 2, 20], ['B', 1, 50]]);
  assert.deepEqual(tierGroups(rooms, ['Critical Care & Isolation']).map((g) => [g.tier, g.rooms.length]), [['Critical Care & Isolation', 2], ['Other', 1]]);
});

test('hardware summary counts only fresh device data; ago() formats', () => {
  const rooms = [R({ source: 'device:x' }), R({ source: 'device:y', stale: true }), R({ source: 'simulator' })];
  assert.deepEqual(hardwareSummary(rooms), { live: 1, total: 3 });
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.deepEqual([null, '2026-10-10T11:59:30Z', '2026-10-10T11:55:00Z', '2026-10-10T09:00:00Z'].map((x) => ago(x, now)),
    ['never', '30s ago', '5 min ago', '3 h ago']);
});
