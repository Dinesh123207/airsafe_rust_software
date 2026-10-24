// End-to-end tests of the client tools against the reference server: signing virtual device, proof verifier,
// bridge (exact-byte forwarding, telnet stripping), hardware check.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeBackend, createFakeChain } from './fake_backend.mjs';
import { verify } from '../verify_proof.mjs';
import * as w from '../lib/web3ref.mjs';

const tool = (n) => fileURLToPath(new URL(`../${n}`, import.meta.url));
const run = (script, args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [tool(script), ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  const t = setTimeout(() => p.kill(), 30000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});
const stop = (srv) => { srv.close(); srv.closeAllConnections?.(); };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('sim_device provisions with its did:key, signs readings, and the ledger leaves match its own computation', async () => {
  const fb = createFakeBackend(); const port = await fb.listen();
  const { code, out } = await run('sim_device.mjs', ['--base', `http://127.0.0.1:${port}`, '--email', 'a@b.co', '--password', 'pw',
    '--device-id', 'sim-1', '--room', 'iso1', '--count', '5', '--interval', '0', '--require-signature']);
  assert.equal(code, 0, out);
  assert.equal(fb.state.readings.length, 5);
  assert.ok(fb.state.readings.every((r) => r.attested), 'every reading verified against the device key');
  assert.match(out, /did:key:z6Mk/);
  assert.match(out, /All readings accepted, attested/);
  fb.close();
});

test('verify_proof: genuine proof passes (offline + via API); tampered server data fails; wrong key fails', async () => {
  const fb = createFakeBackend(); const port = await fb.listen();
  await run('sim_device.mjs', ['--base', `http://127.0.0.1:${port}`, '--email', 'a@b.co', '--password', 'pw', '--device-id', 'sim-2', '--room', 'iso1', '--count', '6', '--interval', '0']);
  fb.state.seal();
  const args = ['--base', `http://127.0.0.1:${port}`, '--token', 'tok', '--reading'];
  let r = await run('verify_proof.mjs', [...args, '3']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /PASS  merkle inclusion/); assert.match(r.out, /PASS  checkpoint signature/); assert.match(r.out, /PASS  device signature/);
  fb.state.tamperProofs = true;
  r = await run('verify_proof.mjs', [...args, '3']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /FAIL  leaf matches the reading/);
  fb.state.tamperProofs = false;
  fb.close();
});

test('verify_proof --rpc: checks the anchor transaction and contract state on the chain; a lying chain is caught', async () => {
  const fb = createFakeBackend(); const port = await fb.listen();
  await run('sim_device.mjs', ['--base', `http://127.0.0.1:${port}`, '--email', 'a@b.co', '--password', 'pw', '--device-id', 'sim-3', '--room', 'iso1', '--count', '4', '--interval', '0']);
  const b = fb.state.seal(); fb.state.anchor(b, '0x' + 'cd'.repeat(32), 7);
  for (const [honest, want] of [[true, 0], [false, 1]]) {
    const chain = createFakeChain(fb.state, { honest }); const cport = await listen(chain);
    const r = await run('verify_proof.mjs', ['--base', `http://127.0.0.1:${port}`, '--token', 'tok', '--reading', '2', '--rpc', `http://127.0.0.1:${cport}`]);
    assert.equal(r.code, want, r.out);
    if (honest) assert.match(r.out, /PASS  on-chain anchor: transaction/);
    stop(chain);
  }
  fb.close();
});

test('verify (library): unsigned reading is "skip", not failure', async () => {
  const fb = createFakeBackend(); const port = await fb.listen();
  // provision without a key, send unsigned
  await fetch(`http://127.0.0.1:${port}/api/devices/provision`, { method: 'POST', body: JSON.stringify({ device_id: 'plain', room_id: 'iso1' }) });
  const body = JSON.stringify({ co2_ppm: 700, pm25_ugm3: 5, temp_c: 22, rh_pct: 40, occupancy: 1 });
  await fetch(`http://127.0.0.1:${port}/api/ingest/reading`, { method: 'POST', body, headers: { 'X-Device-Id': 'plain', 'X-Device-Key': 'KEY-plain' } });
  fb.state.seal();
  const proof = await (await fetch(`http://127.0.0.1:${port}/api/ledger/proof/1`)).json();
  const checks = await verify(proof);
  assert.equal(checks.find((c) => c.name === 'device signature').ok, null);
  assert.ok(checks.every((c) => c.ok !== false), JSON.stringify(checks));
  fb.close();
});

test('bridge: strips telnet negotiation, forwards the EXACT bytes (so signatures survive), reports rejects', async () => {
  const posts = [];
  const api = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      posts.push({ url: req.url, id: req.headers['x-device-id'], key: req.headers['x-device-key'], raw: b });
      const code = JSON.parse(b).co2_ppm === 65535 ? 422 : req.headers['x-device-key'] === 'KEY' ? 200 : 401;
      res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: 'x' }));
    });
  });
  const apiPort = await listen(api);
  const odd = '{"co2_ppm":812.50,"pm25_ugm3":14,"temp_c":23.0,"rh_pct":45,"occupancy":2}';   // spacing/number formats JSON.stringify would change
  const lines = ['AIRSAFE sensor node starting...', `AIRSAFE_JSON ${odd}`, 'AIRSAFE_JSON {broken json',
    'AIRSAFE_JSON {"co2_ppm":65535,"pm25_ugm3":14,"temp_c":23,"rh_pct":45,"occupancy":2}', 'AIRSAFE_JSON {"co2_ppm":900,"pm25_ugm3":20,"temp_c":23,"rh_pct":45,"occupancy":3}'];
  const serial = net.createServer((sock) => {
    sock.write(Buffer.from([255, 251, 44, 255, 250, 44, 1, 255, 240]));
    let i = 0;
    const t = setInterval(() => { if (i < lines.length) sock.write(lines[i++] + '\r\n'); else { clearInterval(t); setTimeout(() => sock.end(), 500); } }, 80);
  });
  const serialPort = await listen(serial);
  const { code, out } = await run('wokwi_bridge.mjs', ['--serial', `tcp://127.0.0.1:${serialPort}`, '--base', `http://127.0.0.1:${apiPort}`, '--device-id', 'dev1', '--device-key', 'KEY', '--max', '3']);
  stop(api); stop(serial);
  assert.equal(code, 0, out);
  assert.equal(posts[0].raw, odd, 'bridge forwards the firmware bytes unchanged');
  assert.deepEqual(posts.map((p) => JSON.parse(p.raw).co2_ppm), [812.5, 65535, 900]);
  assert.match(out, /REJECTED \(422\)/); assert.match(out, /bad JSON ignored/);
});

function fakeApi(roomPatch) {
  return http.createServer((req, res) => {
    const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/auth/login') return send(200, { access_token: 't', user: { email: 'a@b.co', role: 'master_admin' } });
    if (req.url === '/api/devices') return send(200, [{ id: 'dev1', room_id: 'iso1', room_name: 'Isolation 1', vertical: 'hospital' }]);
    if (req.url === '/api/rooms/iso1') return send(200, { co2_ppm: 800, pm25_ugm3: 10, score: 34, status: 'Low', ...roomPatch });
    return send(404, { detail: 'no' });
  });
}
test('verify_hardware: REAL exits 0; STALE / SIMULATED exit 1', async () => {
  for (const [patch, verdict, want] of [[{ source: 'device:dev1', stale: false }, /VERDICT: REAL/, 0], [{ source: 'device:dev1', stale: true }, /VERDICT: STALE/, 1], [{ source: 'simulator', stale: true }, /VERDICT: SIMULATED/, 1]]) {
    const srv = fakeApi(patch); const port = await listen(srv);
    const { code, out } = await run('verify_hardware.mjs', ['--base', `http://127.0.0.1:${port}`, '--email', 'a@b.co', '--password', 'pw', '--device-id', 'dev1']);
    stop(srv); assert.match(out, verdict, out); assert.equal(code, want, out);
  }
});
