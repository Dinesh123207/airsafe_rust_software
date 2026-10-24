// The commissioning tool, end to end against the reference server: setup writes a working firmware config, the
// "firmware" (simulated here from that very file) can then report, and watch / doctor see it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBackend } from './fake_backend.mjs';
import * as w from '../lib/web3ref.mjs';

const tool = fileURLToPath(new URL('../connect_hardware.mjs', import.meta.url));
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [tool, ...args], { env: { ...process.env, NO_COLOR: '1', ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const t = setTimeout(() => p.kill(), 40000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }); });
});
const define = (txt, name) => (txt.match(new RegExp(`#define ${name} (".*")`)) || [])[1];

test('setup provisions, writes config_local.h (escaped, with a signing identity); the node can then report; doctor and watch see it', async () => {
  const fb = createFakeBackend(); const port = await fb.listen();
  const base = `http://127.0.0.1:${port}`;
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'airsafe-')), 'config_local.h');
  const common = ['--base', base, '--email', 'a@b.co', '--password', 'pw', '--room', 'iso1'];

  // before anything exists, doctor must fail clearly
  let r = await run(['doctor', ...common, '--device-id', 'esp32-iso1-01', '--out', out]);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /FAIL  device "esp32-iso1-01" is not provisioned/);

  r = await run(['setup', ...common, '--wifi-ssid', 'My "Home" WiFi', '--wifi-pass', 'p\\w"d', '--api-host', '192.168.1.50', '--sign', '--out', out]);
  assert.equal(r.code, 0, r.out);
  const cfg = readFileSync(out, 'utf8');
  assert.equal(JSON.parse(define(cfg, 'WIFI_SSID')), 'My "Home" WiFi');
  assert.equal(JSON.parse(define(cfg, 'WIFI_PASSWORD')), 'p\\w"d');
  assert.equal(JSON.parse(define(cfg, 'API_BASE_URL')), `http://192.168.1.50:${port}`);
  assert.equal(JSON.parse(define(cfg, 'DEVICE_ID')), 'esp32-iso1-01');
  assert.equal(JSON.parse(define(cfg, 'DEVICE_API_KEY')), 'KEY-esp32-iso1-01');
  assert.match(cfg, /#define DEVICE_SIGNING 1/);
  const seed = JSON.parse(define(cfg, 'DEVICE_SIGNING_SEED_HEX'));
  assert.match(seed, /^[0-9a-f]{64}$/);
  assert.ok(fb.state.devices.get('esp32-iso1-01').require, 'device registered with require_signature');

  // the same device id twice is refused with advice
  r = await run(['setup', ...common, '--out', out + '.2']);
  assert.equal(r.code, 2); assert.match(r.out, /already exists.*--device-id esp32-iso1-02/);

  // no readings yet: doctor FAILs on "never heard from this device" but reports the config as fine
  r = await run(['doctor', ...common, '--device-id', 'esp32-iso1-01', '--out', out]);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /FAIL  the API has never heard from this device/); assert.match(r.out, /config_local.h targets 192\.168\.1\.50|not one of this PC/);

  // act as the firmware: signed readings using ONLY what is in config_local.h; 20 min of occupied then empty room
  const deviceSeed = w.fromHex(seed);
  const t0 = Date.now() - 40 * 60000;
  let co2 = 450;
  for (let k = 0; k < 80; k++) {
    const occupied = k < 40;
    co2 = occupied ? co2 + (1525 - co2) * 0.06 : 425 + (co2 - 425) * Math.exp(-3 * 30 / 3600);
    const body = JSON.stringify({ co2_ppm: Math.round(co2 * 10) / 10, pm25_ugm3: 9, temp_c: 22.5, rh_pct: 44, occupancy: occupied ? 4 : 0, ts: Math.floor((t0 + k * 30000) / 1000) });
    const sig = w.b64u(w.edSignWithSeed(deviceSeed, w.readingSigMessage('esp32-iso1-01', body)));
    const res = await fetch(`${base}/api/ingest/reading`, { method: 'POST', body, headers: { 'X-Device-Id': 'esp32-iso1-01', 'X-Device-Key': 'KEY-esp32-iso1-01', 'X-Device-Signature': sig } });
    assert.equal(res.status, 200, await res.text());
  }

  r = await run(['doctor', ...common, '--device-id', 'esp32-iso1-01', '--out', out]);
  assert.match(r.out, /PASS  room shows live hardware data/); assert.match(r.out, /PASS  pm25 present in 100% of readings/);
  assert.match(r.out, /PASS  device provisioned in room iso1, identity did:key:z6Mk/);

  r = await run(['watch', ...common, '--until-first', '--interval', '1']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Hardware is reporting/); assert.match(r.out, /CO2 averaged/);
  fb.close();
});

test('doctor catches a node pointed at localhost, and reports a missing sensor with the wiring fix', async () => {
  const fb = createFakeBackend(); const port = await fb.listen(); const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'airsafe-')); const out = path.join(dir, 'config_local.h');
  await run(['setup', '--base', base, '--email', 'a@b.co', '--password', 'pw', '--room', 'iso1', '--api-host', '127.0.0.1', '--out', out]);
  // readings without PM, temperature or occupancy (sensors not wired)
  for (let k = 0; k < 6; k++) {
    await fetch(`${base}/api/ingest/reading`, { method: 'POST', body: JSON.stringify({ co2_ppm: 600 + k, ts: Math.floor(Date.now() / 1000) - (6 - k) * 30 }), headers: { 'X-Device-Id': 'esp32-iso1-01', 'X-Device-Key': 'KEY-esp32-iso1-01' } });
  }
  const r = await run(['doctor', '--base', base, '--email', 'a@b.co', '--password', 'pw', '--room', 'iso1', '--device-id', 'esp32-iso1-01', '--out', out]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL  config_local.h points the ESP32 at 127\.0\.0\.1/);
  assert.match(r.out, /FAIL  pm25 present in 0% of readings/); assert.match(r.out, /PMS5003: 5 V, fan spinning/);
  assert.match(r.out, /FAIL  occupancy present in 0% of readings/); assert.match(r.out, /LD2410: baud must be 9600/);
  fb.close();
});
