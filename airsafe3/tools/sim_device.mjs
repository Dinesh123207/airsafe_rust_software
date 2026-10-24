#!/usr/bin/env node
/**
 * A virtual AIRSAFE device that behaves like the signing firmware: it holds an Ed25519 key, provisions itself
 * (with its did:key) through the API, then sends signed readings. Use it to exercise the whole chain
 * (ingest -> ledger -> proofs -> anchoring) without any hardware or Wokwi.
 *
 *   node tools/sim_device.mjs --base http://localhost:8000 --email you@x.com --password '...' \
 *        --device-id sim-iso1 --room iso1 --count 12 --interval 2 [--require-signature] [--seed <64 hex>]
 * Re-running with the same --device-id and --seed (and --key <api key>) continues an existing device.
 */
import { randomBytes } from 'node:crypto';
import * as w from './lib/web3ref.mjs';

const arg = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === '--require-signature') arg.requireSignature = true;
  else if (k.startsWith('--')) arg[k.slice(2)] = process.argv[++i];
}
const base = (arg.base || 'http://localhost:8000').replace(/\/$/, '');
const deviceId = arg['device-id'] || 'sim-device-01';
const room = arg.room || 'iso1';
const count = Number(arg.count || 12), intervalS = Number(arg.interval || 2);
const seed = arg.seed ? w.fromHex(arg.seed) : randomBytes(32);
const pub = w.edPublicFromSeed(seed);
const did = w.didKey(pub);

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(typeof body === 'string' && body.startsWith('{') ? { 'Content-Type': 'application/json' } : {}), ...headers }, body });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}
const jbody = (o) => JSON.stringify(o);

let apiKey = arg.key;
if (!apiKey) {
  let token = arg.token || process.env.AIRSAFE_TOKEN;
  if (!token) {
    const password = arg.password || process.env.AIRSAFE_PASSWORD;
    if (!arg.email || !password) { console.error('Need --key (existing device) or --token / --email + --password to provision'); process.exit(2); }
    const login = await call('/api/auth/login', { method: 'POST', body: jbody({ email: arg.email, password }) });
    if (login.status !== 200) { console.error('Login failed:', login.data?.detail); process.exit(2); }
    token = login.data.access_token;
  }
  const prov = await call('/api/devices/provision', { method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: jbody({ device_id: deviceId, room_id: room, label: 'virtual signing device', public_key: did, require_signature: Boolean(arg.requireSignature) }) });
  if (prov.status !== 200) { console.error('Provisioning failed:', prov.status, prov.data?.detail); process.exit(2); }
  apiKey = prov.data.api_key;
  console.log(`Provisioned ${deviceId} in room ${room}\n  did:    ${did}\n  seed:   ${w.hex(seed)}   (keep it to continue this device)\n  apikey: ${apiKey}`);
}

let co2 = 450, bad = 0;
for (let i = 0; i < count; i++) {
  const phase = Math.floor(i / 4) % 2;                                   // empty -> occupied -> empty ...
  co2 += ((420 + phase * 700) - co2) * 0.3 + (Math.random() - 0.5) * 12;
  const body = jbody({ co2_ppm: Math.round(co2 * 10) / 10, pm25_ugm3: Math.round((8 + Math.random() * 3) * 10) / 10, temp_c: 22.5, rh_pct: 44,
    occupancy: phase * 3, firmware_version: 'sim-0.1', ts: Math.floor(Date.now() / 1000) });
  const signature = w.b64u(w.edSignWithSeed(seed, w.readingSigMessage(deviceId, body)));
  const res = await call('/api/ingest/reading', { method: 'POST', body, headers: { 'X-Device-Id': deviceId, 'X-Device-Key': apiKey, 'X-Device-Signature': signature, 'Content-Type': 'application/json' } });
  if (res.status !== 200) { bad++; console.log(`#${i + 1} rejected (${res.status}): ${JSON.stringify(res.data?.detail)}`); continue; }
  // trust, but verify: recompute the ledger leaf locally and compare with the one the server committed to
  const readingMs = Date.parse(res.data.reading_time);
  const local = w.hex(w.leafHash(w.leafInput({ deviceId, readingMs, body, signature })));
  const same = local === res.data.leaf_hash;
  if (!same) bad++;
  console.log(`#${i + 1} co2=${JSON.parse(body).co2_ppm} reading=${res.data.reading_id} attested=${res.data.attested} leaf ${same ? 'matches' : 'DIFFERS'} ${res.data.leaf_hash.slice(0, 12)}…`);
  if (i < count - 1) await new Promise((r) => setTimeout(r, intervalS * 1000));
}
console.log(bad ? `\n${bad} problem(s).` : '\nAll readings accepted, attested, and committed to the ledger exactly as expected.');
process.exit(bad ? 1 : 0);
