#!/usr/bin/env node
/**
 * Proves whether a provisioned device is really sending data, instead of trusting a dashboard badge.
 * Logs in, finds the device's room, prints its live readings and a verdict:
 *   REAL | STALE | SIMULATED | NO DATA     (exit code 0 only for REAL: usable in scripts)
 *
 *   node tools/verify_hardware.mjs --base http://localhost:8000 --email you@company.com \
 *        --password '...' --device-id esp32-iso1-01 [--watch]
 * The password may also come from the AIRSAFE_PASSWORD environment variable.
 */
const args = { base: 'http://localhost:8000', password: process.env.AIRSAFE_PASSWORD, watch: false };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === '--watch') args.watch = true;
  else if (['--base', '--email', '--password', '--device-id'].includes(k)) args[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = process.argv[++i];
}
if (!args.email || !args.password || !args.deviceId) {
  console.error('Usage: node tools/verify_hardware.mjs --base URL --email E --password P --device-id ID [--watch]');
  process.exit(2);
}

async function call(path, { token, method = 'GET', body } = {}) {
  try {
    const res = await fetch(`${args.base.replace(/\/$/, '')}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  } catch (e) {
    console.error(`\nCannot reach ${args.base} (${e.cause?.code || e.message})`);
    console.error('Check: is the Express server running? Same network? Firewall rule for port 8000?');
    process.exit(2);
  }
}

const login = await call('/api/auth/login', { method: 'POST', body: { email: args.email, password: args.password } });
if (login.status !== 200) { console.error(`Login failed (${login.status}): ${login.data.detail}`); process.exit(2); }
const token = login.data.access_token;
console.log(`Logged in as ${login.data.user.email} (${login.data.user.role})`);

const devs = await call('/api/devices', { token });
if (devs.status !== 200) { console.error(`Could not list devices (${devs.status})`); process.exit(2); }
const device = devs.data.find((d) => d.id === args.deviceId);
if (!device) { console.error(`No device '${args.deviceId}' is provisioned. Provision it first from the Devices page.`); process.exit(2); }
console.log(`Device '${device.id}' is assigned to room '${device.room_id}' (${device.room_name}, ${device.vertical})`);

async function checkOnce() {
  const { status, data: room } = await call(`/api/rooms/${device.room_id}`, { token });
  if (status !== 200) { console.log(`Could not read room (${status})`); return false; }
  const hardware = String(room.source || '').startsWith('device:');
  console.log(`\n--- ${new Date().toLocaleTimeString()} ---`);
  for (const k of ['source', 'stale', 'co2_ppm', 'pm25_ugm3', 'pm10_ugm3', 'tvoc_ppb', 'temp_c', 'rh_pct', 'occupancy', 'diff_pressure_pa', 'score', 'status', 'timestamp']) {
    console.log(`  ${(k + ':').padEnd(18)} ${room[k]}`);
  }
  if (hardware && !room.stale) { console.log('\n  VERDICT: REAL — live hardware data, fresh within the last 2 minutes.'); return true; }
  if (hardware) console.log('\n  VERDICT: STALE — a device published before, but has gone quiet. Check power/WiFi on the unit.');
  else if (room.source === 'simulator') console.log('\n  VERDICT: SIMULATED — nothing from this device has arrived yet; this is still the simulator.');
  else console.log('\n  VERDICT: NO DATA — nothing has been recorded for this room at all yet.');
  return false;
}

if (args.watch) {
  console.log('Watching (Ctrl+C to stop)...');
  for (;;) { await checkOnce(); await new Promise((r) => setTimeout(r, 5000)); }
} else {
  process.exit((await checkOnce()) ? 0 : 1);
}
