/**
 * AIRSAFE risk engine: faithful port of the Python original (Rudnick & Milton 2003
 * rebreathed-fraction model, WHO PM2.5 guideline, illustrative isolation-room pressure target).
 * test/riskEngine.test.js checks it against 504 cases produced by the Python version.
 * See /api/methodology for the citations behind every constant.
 */
export const CO2_OUTDOOR_PPM = 425.0;      // ASHRAE Position Document on Indoor CO2 (2025)
export const CO2_EXHALED_PPM = 38000.0;    // Rudnick & Milton (2003)
export const PM25_WHO_24H_UGM3 = 15.0;     // WHO Global Air Quality Guidelines (2021)
export const ISOLATION_TARGET_PA = -5.0;   // illustrative default: replace with facility spec

export const CO2_CALIBRATION = [
  [CO2_OUTDOOR_PPM, 0], [620.0, 20], [800.0, 40], [1000.0, 60], [1600.0, 80], [2500.0, 100],
];

const r = (x, n) => Number(x.toFixed(n));

export function rebreathedFraction(co2) {
  return Math.max(0.0, (co2 - CO2_OUTDOOR_PPM) / (CO2_EXHALED_PPM - CO2_OUTDOOR_PPM));
}

function co2Index(co2) {
  const pts = CO2_CALIBRATION;
  if (co2 <= pts[0][0]) return 0.0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (x0 <= co2 && co2 <= x1) return y0 + ((co2 - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 100.0;
}

function pm25Penalty(pm25) {
  if (pm25 <= PM25_WHO_24H_UGM3) return 0.0;
  return Math.min(15.0, ((pm25 - PM25_WHO_24H_UGM3) / 35.0) * 15.0);
}

function pressurePenalty(dp) {
  if (dp === null || dp === undefined) return 0.0;
  if (dp <= ISOLATION_TARGET_PA) return 0.0;
  const mag = Math.abs(ISOLATION_TARGET_PA);
  if (mag === 0) return 0.0;
  return Math.min(15.0, ((dp - ISOLATION_TARGET_PA) / mag) * 15.0);
}

export function computeScore(co2, pm25, dp = null) {
  const f = rebreathedFraction(co2);
  const co2c = co2Index(co2);
  const pmPen = pm25Penalty(pm25);
  const hasDp = dp !== null && dp !== undefined;
  const pPen = hasDp ? pressurePenalty(dp) : null;

  const raw = co2c * 0.85 + pmPen + (pPen || 0.0);
  const score = Math.max(0.0, Math.min(100.0, raw));

  const drivers = [{
    factor: 'CO2 rebreathed fraction',
    value: `${co2.toFixed(0)} ppm (${(f * 100).toFixed(2)}% rebreathed air)`,
    contribution: r(co2c * 0.85, 1),
    source: 'Rudnick & Milton (2003), Indoor Air 13(3):237-245',
  }];
  if (pmPen > 0) {
    drivers.push({
      factor: 'PM2.5 above WHO guideline',
      value: `${pm25.toFixed(0)} ug/m3 (guideline: ${PM25_WHO_24H_UGM3.toFixed(0)})`,
      contribution: r(pmPen, 1),
      source: 'WHO Global Air Quality Guidelines (2021)',
    });
  }
  if (pPen) {
    drivers.push({
      factor: 'Differential pressure below target',
      value: `${dp.toFixed(1)} Pa (target: ${ISOLATION_TARGET_PA.toFixed(1)} Pa)`,
      contribution: r(pPen, 1),
      source: 'Illustrative facility target -- not a specific cited regulatory value',
    });
  }
  return {
    score: r(score, 1),
    rebreathed_fraction_pct: r(f * 100, 2),
    co2_component: r(co2c, 1),
    pm25_penalty: r(pmPen, 1),
    pressure_penalty: pPen !== null ? r(pPen, 1) : null,
    drivers,
  };
}

export function statusLabel(score) {
  if (score < 20) return 'Safe';
  if (score < 40) return 'Low';
  if (score < 60) return 'Moderate';
  if (score < 80) return 'High';
  return 'Critical';
}
