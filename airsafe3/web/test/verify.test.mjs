// The in-browser verifier must accept the protocol example from the independent JS reference (and Rust) vectors
// and reject every tampering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyProof } from '../lib/verify.js';

const V = JSON.parse(readFileSync(new URL('../../backend/fixtures/web3_vectors.json', import.meta.url))).protocol;

const proofFor = (i = 2) => {
  const r = V.readings[i];
  return {
    status: 'sealed',
    reading: { id: 100 + i, device_id: V.device_id, reading_ms: r.reading_ms, body: r.body, signature: r.signature, attested: true,
      device_did: V.device_did, device_public_key: V.device_public_key },
    leaf_input: r.leaf_input, leaf_hash: r.leaf_hash, index: i, tree_size: V.readings.length,
    audit_path: i === 2 ? V.audit_path : null, root: V.root,
    batch: { id: V.batch.id, leaf_count: V.batch.leaf_count, from_ms: V.batch.from_ms, to_ms: V.batch.to_ms,
      checkpoint_signature: V.checkpoint_signature, anchor: null },
    server_key: { public_key_hex: V.server_public_key, did: V.server_did },
  };
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const failing = async (p) => (await verifyProof(p)).steps.filter((s) => s.ok === false).map((s) => s.id);

test('genuine proof passes every check that can be run here', async () => {
  const res = await verifyProof(proofFor());
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.deepEqual(res.steps.map((s) => [s.id, s.ok]), [['leaf', true], ['device', true], ['merkle', true], ['checkpoint', true], ['anchor', null]]);
});

test('tampering with the reading, signature, path, root, or checkpoint is detected', async () => {
  let p = proofFor(); p.reading.body = p.reading.body.replace('"co2_ppm":', '"co2_ppm":9'); assert.ok((await failing(p)).includes('leaf'));
  p = proofFor(); p.reading.signature = p.reading.signature.slice(0, -3) + 'AAA'; assert.ok((await failing(p)).includes('device'));
  p = proofFor(); p.audit_path = clone(p.audit_path); p.audit_path[0] = '00'.repeat(32); assert.ok((await failing(p)).includes('merkle'));
  p = proofFor(); p.index = 1; assert.ok((await failing(p)).includes('merkle'));
  p = proofFor(); p.batch.to_ms += 1; assert.ok((await failing(p)).includes('checkpoint'));
  p = proofFor(); p.server_key.public_key_hex = V.device_public_key; assert.ok((await failing(p)).includes('checkpoint'));
});

test('unsigned readings and pending proofs are reported honestly, not as failures', async () => {
  const p = proofFor();
  p.reading.attested = false; p.reading.signature = null;
  p.leaf_input = V.readings[2].unsigned_leaf_input;
  p.leaf_hash = createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(p.leaf_input)])).digest('hex');
  const res = await verifyProof({ ...p, status: 'pending', batch: null });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.equal(res.steps.find((s) => s.id === 'leaf').ok, true);
  assert.equal(res.steps.find((s) => s.id === 'device').ok, null);
  assert.equal(res.steps.find((s) => s.id === 'sealed').ok, null);
});
