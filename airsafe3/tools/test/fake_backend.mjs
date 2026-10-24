// In-memory REFERENCE implementation of the AIRSAFE API's ledger endpoints (the executable form of docs/PROTOCOL.md).
// It exists to test the client tools (sim_device, verify_proof, bridge) end to end without PostgreSQL or Rust.
import http from 'node:http';
import * as w from '../lib/web3ref.mjs';
import { analyze } from '../lib/analysis.mjs';

export function createFakeBackend({ serverSeed = Buffer.alloc(32, 9), tamperProofs = false } = {}) {
  const devices = new Map(), readings = [], batches = [];
  const serverPub = w.edPublicFromSeed(serverSeed);
  const serverKey = () => ({ algorithm: 'Ed25519', did: w.didKey(serverPub), public_key_hex: w.hex(serverPub) });
  const contract = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
  const state = { devices, readings, batches, tamperProofs, chain: new Map() };

  function seal() {
    const pending = readings.filter((r) => r.batchId === undefined);
    if (!pending.length) return null;
    const id = batches.length + 1;
    const leaves = pending.map((r) => w.fromHex(r.leaf_hash));
    const root = w.hex(w.mth(leaves));
    const fromMs = Math.min(...pending.map((r) => r.reading_ms)), toMs = Math.max(...pending.map((r) => r.reading_ms));
    const b = { id, root, leaf_count: pending.length, from_ms: fromMs, to_ms: toMs, anchor: null, status: 'sealed',
      checkpoint_signature: w.b64u(w.edSignWithSeed(serverSeed, w.checkpointMessage({ batchId: id, root, leafCount: pending.length, fromMs, toMs }))) };
    pending.forEach((r, i) => { r.batchId = id; r.index = i; });
    batches.push(b);
    return b;
  }
  state.seal = seal;
  state.anchor = (b, txHash, block) => {
    b.anchor = { chain_id: 31337, contract, tx_hash: txHash, block_number: block };
    b.status = 'anchored';
    state.chain.set(txHash, { b, block });
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, database: true, version: 'test', devices: devices.size, time: new Date().toISOString() });
      if (req.method === 'GET' && url.pathname === '/api/devices') {
        return send(200, [...devices.entries()].map(([id, d]) => {
          const mine = readings.filter((r) => r.device_id === id), last = mine[mine.length - 1];
          return { id, room_id: d.room, did: d.did, require_signature: Boolean(d.require), last_seen_at: last ? new Date(last.reading_ms).toISOString() : null, online: last ? Date.now() - last.reading_ms < 90000 : false };
        }));
      }
      const rm = url.pathname.match(/^\/api\/rooms\/([^/]+?)(\/analysis)?$/);
      if (req.method === 'GET' && rm) {
        const roomId = decodeURIComponent(rm[1]);
        if (roomId !== 'iso1') return send(404, { detail: 'Room not found' });
        const rs = readings.filter((r) => r.room_id === roomId);
        if (rm[2]) {
          const samples = rs.map((r) => { const b = JSON.parse(r.body); return { t_ms: r.reading_ms, co2: b.co2_ppm, pm25: b.pm25_ugm3 ?? null, pm10: b.pm10_ugm3 ?? null, tvoc: b.tvoc_ppb ?? null, temp: b.temp_c ?? null, rh: b.rh_pct ?? null, occ: b.occupancy ?? null, dp: b.diff_pressure_pa ?? null, air: b.air_velocity_ms ?? null }; });
          return send(200, analyze(samples, { windowMinutes: Number(url.searchParams.get('minutes') || 60), nowMs: Date.now() }));
        }
        const last = rs[rs.length - 1];
        if (!last) return send(200, { id: roomId, name: 'Isolation 1', vertical: 'hospital', source: 'simulator', stale: true });
        const b = JSON.parse(last.body);
        return send(200, { id: roomId, name: 'Isolation 1', vertical: 'hospital', source: `device:${last.device_id}`, stale: Date.now() - last.reading_ms > 120000, timestamp: new Date(last.reading_ms).toISOString(), co2_ppm: b.co2_ppm, pm25_ugm3: b.pm25_ugm3 ?? null, temp_c: b.temp_c ?? null, rh_pct: b.rh_pct ?? null, occupancy: b.occupancy ?? null, score: 12.3, status: 'Safe', attested: last.attested });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') return send(200, { access_token: 'tok', user: { email: 'a@b.co', role: 'master_admin' } });
      if (req.method === 'POST' && url.pathname === '/api/devices/provision') {
        const p = JSON.parse(raw.toString());
        if (devices.has(p.device_id)) return send(409, { detail: 'A device with this ID is already provisioned' });
        const pubBytes = p.public_key ? (p.public_key.startsWith('did:key:z') ? w.pubFromDid(p.public_key) : w.fromHex(p.public_key)) : null;
        devices.set(p.device_id, { key: 'KEY-' + p.device_id, did: pubBytes ? w.didKey(pubBytes) : null, pubBytes, require: p.require_signature, room: p.room_id });
        return send(200, { device_id: p.device_id, room_id: p.room_id, api_key: 'KEY-' + p.device_id, did: pubBytes ? w.didKey(pubBytes) : null, require_signature: Boolean(p.require_signature) });
      }
      if (req.method === 'POST' && url.pathname === '/api/ingest/reading') {
        const id = req.headers['x-device-id'], d = devices.get(id);
        if (!d || req.headers['x-device-key'] !== d.key) return send(401, { detail: 'Unknown device or invalid device key' });
        const sig = req.headers['x-device-signature'] || null;
        let attested = false;
        if (d.did && sig) {
          const ok = w.edVerifyWithPublic(d.pubBytes, w.readingSigMessage(id, raw), Buffer.from(sig, 'base64url'));
          if (!ok) return send(401, { detail: 'Invalid device signature' });
          attested = true;
        } else if (d.require) return send(401, { detail: 'This device must sign its readings' });
        const body = raw.toString();
        const parsed = JSON.parse(body);
        if (parsed.co2_ppm > 10000) return send(422, { detail: [{ loc: ['body', 'co2_ppm'], msg: 'out of range' }] });
        const now = Date.now(), t = (parsed.ts || 0) * 1000;
        const readingMs = t > 0 && t <= now + 300000 && t >= now - 7 * 86400000 ? t : now;
        const leaf = w.hex(w.leafHash(w.leafInput({ deviceId: id, readingMs, body, signature: attested ? sig : null })));
        const r = { id: readings.length + 1, device_id: id, room_id: d.room, reading_ms: readingMs, body, signature: attested ? sig : null, attested, leaf_hash: leaf };
        readings.push(r);
        return send(200, { status: 'ok', room_id: d.room, reading_time: new Date(readingMs).toISOString(), reading_id: r.id, attested, leaf_hash: leaf, used_device_ts: readingMs === t });
      }
      if (req.method === 'POST' && url.pathname === '/api/ledger/seal') { const b = seal(); return send(200, { sealed_batch_id: b ? b.id : null, anchoring: 'disabled' }); }
      const m = url.pathname.match(/^\/api\/ledger\/proof\/(\d+)$/);
      if (req.method === 'GET' && m) {
        const r = readings[Number(m[1]) - 1];
        if (!r) return send(404, { detail: 'Reading not found' });
        const d = devices.get(r.device_id);
        const reading = { id: r.id, room_id: r.room_id, device_id: r.device_id, reading_ms: r.reading_ms, body: state.tamperProofs ? r.body.replace('co2_ppm', 'co2_ppm ') : r.body,
          signature: r.signature, attested: r.attested, device_did: d.did || null, device_public_key: d.pubBytes ? w.hex(d.pubBytes) : null };
        const leaf_input = w.leafInput({ deviceId: r.device_id, readingMs: r.reading_ms, body: r.body, signature: r.signature }).toString();
        if (r.batchId === undefined) return send(200, { status: 'pending', reading, leaf_input, leaf_hash: r.leaf_hash, batch: null, server_key: serverKey() });
        const b = batches[r.batchId - 1];
        const leaves = readings.filter((x) => x.batchId === b.id).map((x) => w.fromHex(x.leaf_hash));
        return send(200, { status: b.status, reading, leaf_input, leaf_hash: r.leaf_hash, index: r.index, tree_size: leaves.length,
          audit_path: w.auditPath(r.index, leaves).map((h) => w.hex(h)), root: b.root, batch: b, server_key: serverKey() });
      }
      return send(404, { detail: 'Not found' });
    });
  });
  return {
    server, state,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => { server.close(); server.closeAllConnections?.(); },
  };
}

// Minimal JSON-RPC node that knows one anchored transaction (for verify_proof --rpc).
export function createFakeChain(state, { honest = true } = {}) {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      const { method, params, id } = JSON.parse(b);
      let result = null;
      const entry = state.chain.get(params?.[0]);
      if (method === 'eth_getTransactionByHash' && entry) {
        const batch = entry.b;
        const data = w.encodeAnchorCall({ root: '0x' + (honest ? batch.root : '11'.repeat(32)), batchId: batch.id, leafCount: batch.leaf_count, fromMs: batch.from_ms, toMs: batch.to_ms });
        result = { input: data, to: batch.anchor.contract };
      } else if (method === 'eth_getTransactionReceipt' && entry) result = { status: '0x1', blockNumber: '0x' + entry.block.toString(16) };
      else if (method === 'eth_call') result = '0x' + '00'.repeat(31) + (honest ? '01' : '00') + '00'.repeat(64);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
}
