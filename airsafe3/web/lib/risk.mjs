// Pure helpers shared by the three vertical dashboards (no React, no browser APIs: unit-testable in Node).

// Thermal-style spectrum tied to the 0-100 transmission-risk score (same stops as the original dashboards).
const STOPS = [
  [0, [28, 78, 156]], [25, [31, 158, 122]], [50, [232, 193, 58]], [75, [232, 106, 46]], [100, [214, 40, 57]],
];

export function spectrum(risk) {
  const s = Math.max(0, Math.min(100, Number.isFinite(risk) ? risk : 0));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (s >= t0 && s <= t1) {
      const f = (s - t0) / (t1 - t0);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * f)).join(',')})`;
    }
  }
  return 'rgb(214,40,57)';
}

// Hotel and corporate show an IAQ score where HIGHER IS BETTER: iaq = 100 - risk.
export const toIaq = (risk) => Math.round(100 - (risk ?? 0));
export const spectrumIaq = (iaq) => spectrum(100 - iaq);

export function riskLabel(score) {
  if (score < 20) return 'Safe';
  if (score < 40) return 'Low Risk';
  if (score < 60) return 'Moderate Risk';
  if (score < 80) return 'High Risk';
  return 'Critical Risk';
}

export function iaqLabel(iaq) {
  if (iaq >= 85) return 'Good';
  if (iaq >= 65) return 'Monitor';
  if (iaq >= 40) return 'Action Required';
  return 'Critical';
}

export function vocLabel(ppb) {
  if (ppb === null || ppb === undefined) return 'Low';
  if (ppb < 100) return 'Low';
  if (ppb < 300) return 'Moderate';
  return 'High';
}

export const isHardware = (r) => String(r.source || '').startsWith('device:');
export const isLiveHardware = (r) => isHardware(r) && !r.stale;

export function hardwareSummary(rooms) {
  return { live: rooms.filter(isLiveHardware).length, total: rooms.length };
}

export const VERTICAL_CONFIG = {
  hospital: {
    theme: 'hospital', title: 'AIRS Command Center', subtitle: 'Hospital transmission-risk monitoring',
    filterTitle: 'Departments', filterKey: 'department', feedTitle: 'Alert Feed', feedSub: 'Live: computed from current readings',
    tierOrder: ['Critical Care & Isolation', 'Surgical & Specialty', 'General & Support'],
    tierNote: { 'Critical Care & Isolation': 'High-priority monitoring', 'Surgical & Specialty': 'Priority monitoring', 'General & Support': 'Standard monitoring' },
    footnote: 'Transmission Risk Index is an environmental indicator calculated from configured thresholds, not pathogen detection or a clinical diagnosis.',
  },
  hotel: {
    theme: 'hotel', title: 'AirSafe Hotel Intelligence', subtitle: 'Staff operations dashboard',
    filterTitle: 'Floors', filterKey: 'department', feedTitle: 'Flagged Tasks', feedSub: 'Auto-generated from environmental monitoring',
    tierOrder: ['Floor 1', 'Floor 2', 'Floor 3', 'Floor 4'], tierNote: {},
    footnote: 'IAQ score = 100 minus the transmission-risk index. Tasks are generated from current readings.',
  },
  corporate: {
    theme: 'corporate', title: 'AirSafe Workplace Intelligence', subtitle: 'Workplace environment dashboard',
    filterTitle: 'Zone Type', filterKey: 'department', feedTitle: 'AI Workplace Insights', feedSub: 'Live: computed from current readings',
    tierOrder: ['Collaboration Spaces', 'Focus & Executive', 'Amenities & Common Areas'], tierNote: {},
    footnote: 'CO2 reference levels (1000 ppm focus, 800 ppm certification proxy) are illustrative, not a clinical instrument.',
  },
};

export const FOCUS_CO2 = 1000;
export const CERT_CO2 = 800;

const scored = (rooms) => rooms.filter((r) => r.score !== null && r.score !== undefined);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Sidebar filter options: name, room count and the average risk (for the colour dot).
export function filterOptions(rooms, key) {
  const names = [...new Set(rooms.map((r) => r[key]))];
  const opt = (name, list) => ({ name, count: list.length, avgRisk: mean(scored(list).map((r) => r.score)) });
  return [opt('All', rooms), ...names.map((n) => opt(n, rooms.filter((r) => r[key] === n)))];
}

export function tierGroups(rooms, tierOrder) {
  const extra = [...new Set(rooms.map((r) => r.tier))].filter((t) => !tierOrder.includes(t));
  return [...tierOrder, ...extra]
    .map((tier) => ({ tier, rooms: rooms.filter((r) => r.tier === tier) }))
    .filter((g) => g.rooms.length > 0);
}

// A room needs a task exactly when it needs attention: IAQ score below 65 (same rule as the KPI and the label).
export function hotelIssue(r) {
  const top = r.drivers && r.drivers.length && r.score !== null && toIaq(r.score) < 65 ? r.drivers[0] : null;
  return top ? `${top.factor}: review` : '';
}

export function hospitalKpis(rooms, alerts) {
  const s = scored(rooms);
  const avg = mean(s.map((r) => r.score));
  return {
    index: avg === null ? null : Math.round(avg),
    attention: s.filter((r) => r.score >= 60).length,
    alerts: alerts.length,
    ventilation: rooms.length ? Math.round((rooms.filter((r) => (r.est_ach ?? 0) >= 10).length / rooms.length) * 100) : null,
  };
}

export function hotelKpis(rooms) {
  const s = scored(rooms);
  const avgIaq = mean(s.map((r) => toIaq(r.score)));
  return {
    iaq: avgIaq === null ? null : Math.round(avgIaq),
    attention: s.filter((r) => toIaq(r.score) < 65).length,
    occupied: rooms.filter((r) => (r.occupancy ?? 0) > 0).length,
    tasks: s.filter((r) => hotelIssue(r)).length,
  };
}

export function corporateKpis(rooms) {
  const s = scored(rooms);
  const avgIaq = mean(s.map((r) => toIaq(r.score)));
  const cap = rooms.reduce((a, r) => a + (r.capacity || 0), 0);
  const occ = rooms.reduce((a, r) => a + (r.occupancy || 0), 0);
  return {
    iaq: avgIaq === null ? null : Math.round(avgIaq),
    utilization: cap ? Math.round((occ / cap) * 100) : null,
    noShows: rooms.filter((r) => r.booked && r.occupancy === 0).length,
    reference: s.length ? Math.round((s.filter((r) => r.co2_ppm < CERT_CO2).length / s.length) * 100) : null,
  };
}

export function ago(iso, now = Date.now()) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
