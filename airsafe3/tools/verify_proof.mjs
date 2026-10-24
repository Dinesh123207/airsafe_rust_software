#!/usr/bin/env node
/**
 * Independent verifier for an AIRSAFE ledger proof. It trusts nothing the server says: it recomputes the leaf from the
 * raw reading, checks the device's Ed25519 signature, walks the Merkle audit path to the root, checks the server's
 * signed checkpoint and (with --rpc) asks an Ethereum node whether that exact root is anchored on chain.
 *
 *   node tools/verify_proof.mjs --base http://localhost:8000 --token <JWT> --reading 123 [--rpc http://localhost:8545]
 *   node tools/verify_proof.mjs --base http://localhost:8000 --email you@x.com --password '...' --reading 123
 *   node tools/verify_proof.mjs --file proof.json [--rpc ...]      # offline: a proof you saved earlier
 * Exit code 0 only if every check that ran passed.
 */
import { readFileSync } from 'node:fs';
import * as w from './lib/web3ref.mjs';

const arg = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === '--json') arg.json = true;
  else if (k.startsWith('--')) arg[k.slice(2)] = process.argv[++i];
}

async function getProof() {
  if (arg.file) return JSON.parse(readFileSync(arg.file, 'utf8'));
  if (!arg.reading) { console.error('Need --reading <id> (or --file proof.json)'); process.exit(2); }
  const base = (arg.base || 'http://localhost:8000').replace(/\/$/, '');
  let token = arg.token || process.env.AIRSAFE_TOKEN;
  if (!token) {
    const email = arg.email, password = arg.password || process.env.AIRSAFE_PASSWORD;
    if (!email || !password) { console.error('Need --token, or --email and --password'); process.exit(2); }
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!r.ok) { console.error(`Login failed (${r.status})`); process.exit(2); }
    token = (await r.json()).access_token;
  }
  const res = await fetch(`${base}/api/ledger/proof/${arg.reading}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`Proof request failed (${res.status}): ${(await res.text()).slice(0, 200)}`); process.exit(2); }
  return res.json();
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

export async function verify(proof, { rpcUrl } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const rd = proof.reading;

  const input = w.leafInput({ deviceId: rd.device_id, readingMs: rd.reading_ms, body: rd.body, signature: rd.signature });
  const leaf = w.leafHash(input);
  add('leaf matches the reading', input.toString() === proof.leaf_input && w.hex(leaf) === proof.leaf_hash, `leaf ${proof.leaf_hash}`);

  if (rd.attested && rd.device_public_key && rd.signature) {
    add('device signature', w.edVerifyWithPublic(w.fromHex(rd.device_public_key), w.readingSigMessage(rd.device_id, rd.body), Buffer.from(rd.signature, 'base64url')), rd.device_did);
  } else add('device signature', null, 'reading was not signed by a device key');

  if (!proof.batch) { add('sealed into a batch', null, 'pending'); return checks; }

  const path = proof.audit_path.map((h) => w.fromHex(h));
  add('merkle inclusion', w.verifyInclusion(leaf, proof.index, proof.tree_size, path, w.fromHex(proof.root)), `index ${proof.index} of ${proof.tree_size}, root ${proof.root}`);

  const b = proof.batch;
  const cp = w.checkpointMessage({ batchId: b.id, root: proof.root, leafCount: b.leaf_count, fromMs: b.from_ms, toMs: b.to_ms });
  add('checkpoint signature', Boolean(b.checkpoint_signature) &&
    w.edVerifyWithPublic(w.fromHex(proof.server_key.public_key_hex), cp, Buffer.from(b.checkpoint_signature, 'base64url')), proof.server_key.did);

  if (!b.anchor) add('on-chain anchor', null, 'batch is sealed and signed but not anchored yet');
  else if (!rpcUrl) add('on-chain anchor', null, `claimed tx ${b.anchor.tx_hash}; pass --rpc <url> to check it on the chain`);
  else {
    try {
      const expected = w.encodeAnchorCall({ root: '0x' + proof.root, batchId: b.id, leafCount: b.leaf_count, fromMs: b.from_ms, toMs: b.to_ms });
      const tx = await rpc(rpcUrl, 'eth_getTransactionByHash', [b.anchor.tx_hash]);
      const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [b.anchor.tx_hash]);
      const okTx = Boolean(tx) && tx.input.toLowerCase() === expected.toLowerCase() &&
        tx.to.toLowerCase() === b.anchor.contract.toLowerCase();
      const okRc = Boolean(receipt) && receipt.status === '0x1' && Number(BigInt(receipt.blockNumber)) === b.anchor.block_number;
      add('on-chain anchor: transaction', okTx && okRc, `tx ${b.anchor.tx_hash}, block ${b.anchor.block_number}, contract ${b.anchor.contract}`);
      const call = await rpc(rpcUrl, 'eth_call', [{ to: b.anchor.contract, data: '0x' + w.hex(w.selector('isAnchored(bytes32)')) + proof.root }, 'latest']);
      add('on-chain anchor: contract state', BigInt('0x' + call.slice(2, 66)) === 1n, 'contract.isAnchored(root) == true');
    } catch (e) { add('on-chain anchor', false, e.message); }
  }
  return checks;
}

if (process.argv[1] && process.argv[1].endsWith('verify_proof.mjs')) {
  const proof = await getProof();
  const checks = await verify(proof, { rpcUrl: arg.rpc });
  if (arg.json) console.log(JSON.stringify(checks, null, 2));
  else {
    console.log(`Proof status: ${proof.status}   reading #${proof.reading.id} from ${proof.reading.device_id}`);
    for (const c of checks) console.log(`  ${c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'skip'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  const failed = checks.some((c) => c.ok === false);
  console.log(failed ? '\nVERIFICATION FAILED' : '\nAll checks that could run passed.');
  process.exit(failed ? 1 : 0);
}
