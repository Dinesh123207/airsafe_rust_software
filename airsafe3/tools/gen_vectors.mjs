// Generates backend/fixtures/web3_vectors.json from the independent reference implementation.
// The Rust tests (backend/tests/web3_vectors.rs) must reproduce every value here byte for byte.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as w from './lib/web3ref.mjs';

const out = {};
const H = w.hex;

out.keccak = [['', ''], ['abc', Buffer.from('abc').toString('hex')]].map(([, input]) => ({ input_hex: input, hash: H(w.keccak256(Buffer.from(input, 'hex'))) }));

const privs = ['0000000000000000000000000000000000000000000000000000000000000001',
  '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'];
out.addresses = privs.map((p) => ({ private_key: p, address: w.checksumAddress(w.addressOf(w.publicKey(w.fromHex(p)))) }));

// SIWE sign-in: deterministic signature, so Rust must recover exactly this address.
const sk = privs[1];
const msgs = [0, 1, 2, 3].map((i) => w.siweMessage({
  domain: 'airsafe.example', address: out.addresses[1].address, statement: 'Sign in to AIRSAFE.', uri: 'https://airsafe.example',
  chainId: 31337, nonce: `nonce${i}abcdef0123456789`, issuedAt: '2026-10-10T12:00:00.000Z', expirationTime: '2026-10-10T12:10:00.000Z' }));
out.personal_sign = msgs.map((message) => ({ message, signature: w.personalSign(w.fromHex(sk), message), address: out.addresses[1].address }));

// EIP-155 specification example + an AIRSAFE anchor transaction (Anvil default key 0, chain 31337).
const eip = { nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: '0x', chainId: 1 };
const t1 = w.signLegacyTx(w.fromHex('4646464646464646464646464646464646464646464646464646464646464646'), eip);
out.eip155 = { private_key: '4646464646464646464646464646464646464646464646464646464646464646', nonce: 9, gas_price: '20000000000', gas_limit: 21000,
  to: eip.to, value: '1000000000000000000', data: '', chain_id: 1, signing_hash: t1.signingHash, raw: t1.raw, tx_hash: t1.txHash };

const anvilKey = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const anchorArgs = { root: '0x' + H(w.sha256(Buffer.from('example root'))), batchId: 7, leafCount: 25, fromMs: 1760097600000, toMs: 1760097900000 };
const calldata = w.encodeAnchorCall(anchorArgs);
const contract = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const t2 = w.signLegacyTx(w.fromHex(anvilKey), { nonce: 1, gasPrice: 1000000000n, gasLimit: 200000, to: contract, value: 0n, data: calldata, chainId: 31337 });
out.anchor_tx = { private_key: anvilKey, sender: w.checksumAddress(w.addressOf(w.publicKey(w.fromHex(anvilKey)))), contract,
  root: anchorArgs.root, batch_id: 7, leaf_count: 25, from_ms: anchorArgs.fromMs, to_ms: anchorArgs.toMs, calldata,
  nonce: 1, gas_price: '1000000000', gas_limit: 200000, chain_id: 31337, signing_hash: t2.signingHash, raw: t2.raw, tx_hash: t2.txHash,
  selector: H(w.selector(w.ANCHOR_SIG)) };

// RFC 6962 / Certificate Transparency
const ct = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'];
out.ct_leaves = ct;
out.ct_roots = ct.map((_, i) => H(w.mth(ct.slice(0, i + 1).map((h) => w.leafHash(Buffer.from(h, 'hex'))))));

// Inclusion proofs for several tree sizes
out.proofs = [];
for (const n of [1, 2, 3, 5, 8, 13, 33]) {
  const leaves = Array.from({ length: n }, (_, i) => w.leafHash(Buffer.from(`leaf-${i}`)));
  const root = H(w.mth(leaves));
  for (const i of new Set([0, Math.floor(n / 2), n - 1])) {
    out.proofs.push({ size: n, index: i, leaf_hash: H(leaves[i]), path: w.auditPath(i, leaves).map(H), root, leaf_data: `leaf-${i}` });
  }
}

// Full protocol example: device-signed readings -> ledger leaves -> batch -> proof -> signed checkpoint
const devSeed = Buffer.alloc(32, 7), srvSeed = Buffer.alloc(32, 9);
const devPub = w.edPublicFromSeed(devSeed), srvPub = w.edPublicFromSeed(srvSeed);
const deviceId = 'esp32-iso1-01', base = 1760097600000;
const readings = Array.from({ length: 5 }, (_, i) => {
  const body = JSON.stringify({ co2_ppm: 600 + i * 40, pm25_ugm3: 8 + i, temp_c: 22.5, rh_pct: 44, occupancy: i % 3, firmware_version: '0.2.0', ts: Math.floor((base + i * 30000) / 1000) });
  const signature = w.b64u(w.edSignWithSeed(devSeed, w.readingSigMessage(deviceId, body)));
  const readingMs = base + i * 30000;
  const input = w.leafInput({ deviceId, readingMs, body, signature });
  return { body, signature, reading_ms: readingMs, leaf_input: input.toString(), leaf_hash: H(w.leafHash(input)), unsigned_leaf_input: w.leafInput({ deviceId, readingMs, body, signature: null }).toString() };
});
const leaves = readings.map((r) => Buffer.from(r.leaf_hash, 'hex'));
const root = H(w.mth(leaves));
const batch = { batchId: 3, root, leafCount: 5, fromMs: readings[0].reading_ms, toMs: readings[4].reading_ms };
out.protocol = {
  device_id: deviceId, device_seed: H(devSeed), device_public_key: H(devPub), device_did: w.didKey(devPub),
  server_seed: H(srvSeed), server_public_key: H(srvPub), server_did: w.didKey(srvPub),
  readings, root, batch: { id: 3, leaf_count: 5, from_ms: batch.fromMs, to_ms: batch.toMs },
  proof_index: 2, audit_path: w.auditPath(2, leaves).map(H),
  checkpoint_message: w.checkpointMessage(batch).toString(),
  checkpoint_signature: w.b64u(w.edSignWithSeed(srvSeed, w.checkpointMessage(batch))),
  reading_sig_message_hex: H(w.readingSigMessage(deviceId, readings[0].body)),
};

const dest = fileURLToPath(new URL('../backend/fixtures/web3_vectors.json', import.meta.url));
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log('wrote', dest, '|', out.proofs.length, 'proofs |', out.personal_sign.length, 'signatures | did', out.protocol.device_did);
