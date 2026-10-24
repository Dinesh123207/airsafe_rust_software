#!/usr/bin/env node
/**
 * Commission a real AIRSAFE node, then watch the analysis come in.
 *
 *   node tools/connect_hardware.mjs setup  --email you@x.com --password '...' --room iso1 \
 *        --wifi-ssid "MyWiFi" --wifi-pass "secret" [--device-id esp32-iso1-01] [--api-host 192.168.1.23] [--sign] [--watch]
 *   node tools/connect_hardware.mjs watch  --email ... --password ... --room iso1 [--until-first]
 *   node tools/connect_hardware.mjs doctor --email ... --password ... --room iso1 --device-id esp32-iso1-01
 *
 * setup   checks the API, provisions the device, finds your PC's LAN address and writes firmware/airsafe_node/config_local.h
 *         (WiFi, API address, device id, key, optional signing seed). Flash after that: nothing to edit by hand.
 * watch   prints each reading as it arrives, then an analysis summary (insights, sensor-health warnings).
 * doctor  explains, check by check, why a node is not showing up, with the fix for each problem.
 * The password can also come from AIRSAFE_PASSWORD and the WiFi password from AIRSAFE_WIFI_PASSWORD.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as w from './lib/web3ref.mjs';

const [, , cmd = 'help', ...rest] = process.argv;
const arg = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (['--sign', '--watch', '--until-first', '--force'].includes(k)) arg[k.slice(2)] = true;
  else if (k.startsWith('--')) arg[k.slice(2)] = rest[++i];
}
const base = (arg.base || 'http://localhost:8000').replace(/\/$/, '');
const room = arg.room || 'iso1';
const deviceId = arg['device-id'] || `esp32-${room}-01`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = arg.out || path.join(repoRoot, 'firmware', 'airsafe_node', 'config_local.h');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const time = () => new Date().toLocaleTimeString();

const c = { ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
const PASS = c.ok('PASS'), WARN = c.warn('WARN'), FAIL = c.bad('FAIL');

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

async function call(p, { method = 'GET', token, body } = {}) {
  try {
    const res = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    let data = null; try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { detail: e.cause?.code || e.message } }; }
}

async function requireApi() {
  const h = await call('/api/health');
  if (h.status === 0) {
    console.error(`${FAIL} Cannot reach the API at ${base} (${h.data.detail}).\n  Start it first:  Windows: scripts\\start-windows.ps1   others: docker compose up -d --build`);
    process.exit(2);
  }
  if (h.status !== 200 || !h.data.ok) { console.error(`${FAIL} The API is up but its database is not ready (HTTP ${h.status}). Wait a few seconds, or check:  docker compose logs db api`); process.exit(2); }
  return h.data;
}

async function login() {
  const password = arg.password || process.env.AIRSAFE_PASSWORD;
  if (!arg.email || !password) { console.error('Need --email and --password (or AIRSAFE_PASSWORD). Register an account in the web app first.'); process.exit(2); }
  const r = await call('/api/auth/login', { method: 'POST', body: { email: arg.email, password } });
  if (r.status !== 200) { console.error(`${FAIL} Login failed (${r.status}): ${r.data?.detail}`); process.exit(2); }
  return r.data.access_token;
}

const cString = (s) => JSON.stringify(String(s));

async function setup() {
  const health = await requireApi();
  console.log(`${PASS} API is up (v${health.version}), database ready.`);
  const token = await login();
  console.log(`${PASS} Logged in as ${arg.email}.`);

  const roomRes = await call(`/api/rooms/${encodeURIComponent(room)}`, { token });
  if (roomRes.status === 404) {
    const all = await call('/api/rooms', { token });
    const ids = (all.data || []).map((r) => r.id).join(', ');
    console.error(`${FAIL} Room "${room}" does not exist. Available: ${ids}`); process.exit(2);
  }
  console.log(`${PASS} Room: ${roomRes.data.name} (${roomRes.data.vertical}).`);

  let seed = null, did = null;
  if (arg.sign) { seed = randomBytes(32); did = w.didKey(w.edPublicFromSeed(seed)); }
  const prov = await call('/api/devices/provision', { method: 'POST', token, body: { device_id: deviceId, room_id: room, label: 'ESP32 node', public_key: did, require_signature: Boolean(arg.sign) } });
  if (prov.status === 409) { console.error(`${FAIL} A device called "${deviceId}" already exists. Its API key was shown only once, so choose a new id, e.g. --device-id ${deviceId.replace(/(\d+)$/, (m) => String(Number(m) + 1).padStart(m.length, '0'))}`); process.exit(2); }
  if (prov.status !== 200) { console.error(`${FAIL} Provisioning failed (${prov.status}): ${JSON.stringify(prov.data?.detail)}`); process.exit(2); }
  console.log(`${PASS} Device "${deviceId}" provisioned${did ? ` with identity ${did}` : ' (API key only, add --sign for an Ed25519 device identity)'}.`);

  const lans = lanAddresses();
  const host = arg['api-host'] || lans[0]?.address;
  const port = new URL(base).port || '8000';
  if (!host) console.log(`${WARN} Could not detect this PC's LAN address: pass --api-host <ip> (see "ipconfig" / "ip addr").`);
  const apiUrl = `http://${host || 'PUT-YOUR-PC-LAN-IP-HERE'}:${port}`;

  if (existsSync(outPath) && !arg.force) { const bak = `${outPath}.${Date.now()}.bak`; renameSync(outPath, bak); console.log(c.dim(`  existing config_local.h kept as ${path.basename(bak)}`)); }
  const lines = [
    `// Generated by tools/connect_hardware.mjs at ${new Date().toISOString()}. Contains secrets: never commit this file.`,
    `#define WIFI_SSID ${cString(arg['wifi-ssid'] || 'your-wifi-name')}`,
    `#define WIFI_PASSWORD ${cString(arg['wifi-pass'] || process.env.AIRSAFE_WIFI_PASSWORD || 'your-wifi-password')}`,
    `#define API_BASE_URL ${cString(apiUrl)}`,
    `#define DEVICE_ID ${cString(deviceId)}`,
    `#define DEVICE_API_KEY ${cString(prov.data.api_key)}`,
  ];
  if (seed) lines.push('#define DEVICE_SIGNING 1', `#define DEVICE_SIGNING_SEED_HEX ${cString(w.hex(seed))}`);
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`${PASS} Wrote ${outPath}`);
  if (!arg['wifi-ssid']) console.log(`${WARN} No --wifi-ssid given: open config_local.h and set WIFI_SSID / WIFI_PASSWORD (2.4 GHz network).`);
  if (lans.length > 1) console.log(c.dim(`  this PC has several networks: ${lans.map((l) => `${l.address} (${l.name})`).join(', ')}. Using ${host}. Override with --api-host.`));

  console.log(`
Next steps
  1. Windows only, once, as Administrator:  scripts\\open-firewall.ps1   (lets the ESP32 reach port ${port})
  2. Test from your phone on the same WiFi:  http://${host || '<PC-IP>'}:${port}/api/health  must show {"ok":true,...}
  3. Flash:  cd wokwi && pio run -e esp32_real -t upload   (or PlatformIO sidebar -> esp32_real -> Upload)
  4. Serial monitor (115200): read the SELF-TEST block, every line should say OK
  5. The node warms up for 3 minutes, then publishes every 30 s.   Watch it here:  node tools/connect_hardware.mjs watch --email ${arg.email} --password ... --room ${room}
  Something wrong?  node tools/connect_hardware.mjs doctor --email ${arg.email} --password ... --room ${room} --device-id ${deviceId}
${seed ? `\nSigning is on: the device prints its PUBLIC key at boot. It already matches the identity registered above (${did}).` : ''}`);
  if (arg.watch) await watch(token);
}

function describe(r) {
  const f = (v, u = '') => (v === null || v === undefined ? '--' : `${v}${u}`);
  return `source=${r.source} co2=${f(r.co2_ppm)} pm25=${f(r.pm25_ugm3)} T=${f(r.temp_c)} RH=${f(r.rh_pct)} occ=${f(r.occupancy)} risk=${f(r.score)} (${f(r.status)})${r.attested ? ' signed' : ''}`;
}

async function watch(tokenIn) {
  await requireApi();
  const token = tokenIn || await login();
  const every = Number(arg.interval || 5) * 1000;
  const timeoutMs = Number(arg.timeout || (arg['until-first'] ? 900 : 0)) * 1000;
  const started = Date.now();
  let live = false, lastAnalysis = 0;
  console.log(`Watching room ${room} (Ctrl+C to stop). The node needs ~3 min of warm-up after power-on before it publishes.`);
  for (;;) {
    const r = await call(`/api/rooms/${encodeURIComponent(room)}`, { token });
    if (r.status !== 200) console.log(`[${time()}] ${FAIL} room query failed (${r.status})`);
    else {
      const d = r.data, fromDevice = String(d.source || '').startsWith('device:'), fresh = fromDevice && !d.stale;
      if (fresh) {
        if (!live) { live = true; console.log(`\n${PASS} Hardware is reporting. Your sensors are now feeding the analysis.\n`); }
        console.log(`[${time()}] ${describe(d)}`);
      } else if (fromDevice) console.log(`[${time()}] ${WARN} device went quiet (last reading ${d.timestamp}). Power, WiFi or API address changed?`);
      else console.log(`[${time()}] waiting for the first hardware reading (still showing ${d.source || 'no data'})...`);
      if (fresh && (Date.now() - lastAnalysis > 30000 || lastAnalysis === 0)) {
        lastAnalysis = Date.now();
        const a = await call(`/api/rooms/${encodeURIComponent(room)}/analysis?minutes=${arg.minutes || 15}`, { token });
        if (a.status === 200 && a.data.sample_count > 0) {
          console.log(c.dim(`  ---- analysis, last ${a.data.window_minutes} min (${a.data.sample_count} readings) ----`));
          for (const i of a.data.insights.slice(0, 4)) console.log(`  • ${i}`);
          for (const fl of a.data.flags) console.log(`  ${c.warn('⚠')} ${fl}`);
          if (arg['until-first']) { console.log(`\nOpen http://localhost:${new URL(base).port || 8000} -> the room's detail panel for the full analysis and "Verify this reading".`); return; }
        }
      }
    }
    if (timeoutMs && Date.now() - started > timeoutMs) { console.log(`${FAIL} Gave up after ${timeoutMs / 1000} s with no hardware reading. Run the doctor command.`); process.exit(1); }
    await sleep(every);
  }
}

async function doctor() {
  let failed = 0;
  const line = (level, msg, fix) => { if (level === FAIL) failed++; console.log(`${level}  ${msg}`); if (fix && level !== PASS) console.log(`        ${c.dim('fix:')} ${fix}`); };

  const h = await call('/api/health');
  if (h.status === 0) { line(FAIL, `API not reachable at ${base}`, 'start it: scripts\\start-windows.ps1 (or docker compose up -d --build)'); process.exit(1); }
  line(h.data?.ok ? PASS : FAIL, `API up, database ${h.data?.ok ? 'ready' : 'NOT ready'} (v${h.data?.version})`, 'docker compose logs db api');
  const skew = Math.abs(Date.now() - Date.parse(h.data?.time || Date.now())) / 1000;
  if (skew > 120) line(WARN, `PC clock and API clock differ by ${Math.round(skew)} s`, 'sync your PC clock (device timestamps are accepted only within a few minutes)');

  const token = await login();
  line(PASS, 'login works');

  const lans = lanAddresses();
  line(lans.length ? PASS : WARN, `this PC's LAN address(es): ${lans.map((l) => l.address).join(', ') || 'none found'}`, 'connect the PC to the same WiFi/router as the ESP32');
  if (existsSync(outPath)) {
    const txt = readFileSync(outPath, 'utf8');
    const m = txt.match(/#define API_BASE_URL "http:\/\/([^:"/]+)/);
    if (m) {
      const ip = m[1];
      if (/^(localhost|127\.)/.test(ip)) line(FAIL, `config_local.h points the ESP32 at ${ip}: that is the ESP32 itself`, 're-run setup (or use --api-host <PC LAN IP>)');
      else if (lans.length && !lans.some((l) => l.address === ip)) line(WARN, `config_local.h uses ${ip}, which is not one of this PC's addresses (${lans.map((l) => l.address).join(', ')})`, 'if the PC moved networks, re-run setup with --api-host <current IP> and reflash');
      else line(PASS, `config_local.h targets ${ip}`);
    }
  } else line(WARN, 'no firmware/airsafe_node/config_local.h yet', 'run: node tools/connect_hardware.mjs setup ...');

  const devs = await call('/api/devices', { token });
  const dev = (devs.data || []).find((d) => d.id === deviceId);
  if (!dev) { line(FAIL, `device "${deviceId}" is not provisioned`, `run setup, or use the id shown on the Devices page (${(devs.data || []).map((d) => d.id).join(', ') || 'none yet'})`); process.exit(1); }
  line(PASS, `device provisioned in room ${dev.room_id}${dev.did ? `, identity ${dev.did}${dev.require_signature ? ' (signature required)' : ''}` : ', API-key identity'}`);
  if (!dev.last_seen_at) line(FAIL, 'the API has never heard from this device', 'flash the firmware, read the SELF-TEST in the serial monitor (115200): WiFi, API line, key rejected? Then check the PC firewall (scripts\\open-firewall.ps1)');
  else line(dev.online ? PASS : WARN, `last report ${dev.last_seen_at} (${dev.online ? 'online' : 'offline'})`, 'power, WiFi range, or the PC changed IP address');

  const r = await call(`/api/rooms/${encodeURIComponent(dev.room_id)}`, { token });
  const fromDevice = String(r.data?.source || '').startsWith('device:');
  line(fromDevice && !r.data.stale ? PASS : FAIL, fromDevice ? (r.data.stale ? 'room data from the device is stale' : 'room shows live hardware data') : `room still shows ${r.data?.source || 'no data'}, not the device`, 'the node publishes only after its 3 minute warm-up; check CO2 (MH-Z19B) in the SELF-TEST: without CO2 nothing is published');

  const a = await call(`/api/rooms/${encodeURIComponent(dev.room_id)}/analysis?minutes=15`, { token });
  if (a.status === 200 && a.data.sample_count > 0) {
    const cp = a.data.completeness;
    line(PASS, `${a.data.sample_count} readings in the last 15 min, every ${a.data.median_interval_s} s`);
    const hint = { pm25: 'PMS5003: 5 V, fan spinning, sensor TX to GPIO4', temperature: 'SHT31: I2C SDA21/SCL22, 3.3 V, address 0x44', occupancy: 'LD2410: baud must be 9600 (firmware/bringup/ld2410_set_baud), TX to GPIO27', tvoc: 'SGP30: I2C 0x58, 3.3 V' };
    for (const [k, fix] of Object.entries(hint)) line(cp[k] >= 80 ? PASS : cp[k] > 0 ? WARN : FAIL, `${k} present in ${cp[k]}% of readings`, fix);
    for (const f of a.data.flags) line(WARN, f);
  } else line(WARN, 'no readings in the last 15 minutes to analyse yet');
  console.log(failed ? `\n${failed} problem(s) found: fix them in the order shown, then run doctor again.` : `\n${c.ok('Everything that can be checked from the PC looks healthy.')}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('connect_hardware.mjs')) {
  if (cmd === 'setup') await setup();
  else if (cmd === 'watch') await watch();
  else if (cmd === 'doctor') await doctor();
  else { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n/**', '')); process.exit(cmd === 'help' ? 0 : 2); }
}
