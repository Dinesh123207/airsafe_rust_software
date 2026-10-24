// Independent, in-browser verification of an AIRSAFE ledger proof (WebCrypto only; no trust in the server's say-so).
// The same algorithm is implemented in tools/verify_proof.mjs and in the Rust backend; all three are checked against
// backend/fixtures/web3_vectors.json.
const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export const hexToBytes = (h) => Uint8Array.from((h || '').replace(/^0x/, '').match(/../g) || [], (b) => parseInt(b, 16));
export const bytesToHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (...parts) => new Uint8Array(await subtle().digest('SHA-256', concat(...parts)));

export const leafHash = (data) => sha256(Uint8Array.of(0), data);
export const nodeHash = (l, r) => sha256(Uint8Array.of(1), l, r);

export async function verifyInclusion(leaf, index, size, path, root) {   // RFC 9162 section 2.1.3.2
  if (index >= size) return false;
  let fnum = index, sn = size - 1, r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if ((fnum & 1) === 1 || fnum === sn) {
      r = await nodeHash(p, r);
      if ((fnum & 1) === 0) while ((fnum & 1) === 0 && fnum !== 0) { fnum >>= 1; sn >>= 1; }
    } else r = await nodeHash(r, p);
    fnum >>= 1; sn >>= 1;
  }
  return sn === 0 && bytesToHex(r) === bytesToHex(root);
}

// true / false, or null when this browser has no Ed25519 in WebCrypto.
export async function verifyEd25519(publicKeyHex, message, signature) {
  try {
    const key = await subtle().importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await subtle().verify({ name: 'Ed25519' }, key, signature, message);
  } catch (e) {
    return e && (e.name === 'NotSupportedError' || /not supported|unrecognized/i.test(String(e.message))) ? null : false;
  }
}

const step = (id, label, ok, detail) => ({ id, label, ok, detail });

/** Verifies everything a proof document claims. ok = no check failed; null checks are "could not be checked here". */
export async function verifyProof(proof) {
  const steps = [];
  const rd = proof.reading;

  // 1. the leaf really commits to the stored reading
  const bodyHash = bytesToHex(await sha256(enc.encode(rd.body)));
  const input = `AIRSAFE-LEAF-V1|${rd.device_id}|${rd.reading_ms}|${bodyHash}|${rd.signature || '-'}`;
  const leaf = await leafHash(enc.encode(input));
  steps.push(step('leaf', 'Reading data matches its ledger leaf', input === proof.leaf_input && bytesToHex(leaf) === proof.leaf_hash,
    `leaf ${proof.leaf_hash.slice(0, 16)}…`));

  // 2. device signature (web3 device identity)
  if (rd.attested && rd.device_public_key && rd.signature) {
    const msg = enc.encode(`AIRSAFE-READING-V1\n${rd.device_id}\n${rd.body}`);
    const ok = await verifyEd25519(rd.device_public_key, msg, b64uToBytes(rd.signature));
    steps.push(step('device', 'Signed by the device key', ok, rd.device_did || rd.device_public_key.slice(0, 16)));
  } else {
    steps.push(step('device', 'Signed by the device key', null, 'Not signed: accepted on the strength of the device API key only'));
  }

  if (proof.status === 'pending' || !proof.batch) {
    steps.push(step('sealed', 'Sealed into a Merkle batch', null, 'Pending: sealing runs every few minutes'));
    return { ok: steps.every((s) => s.ok !== false), steps };
  }

  // 3. inclusion proof reaches the batch root
  const path = proof.audit_path.map(hexToBytes);
  const included = await verifyInclusion(leaf, proof.index, proof.tree_size, path, hexToBytes(proof.root));
  steps.push(step('merkle', 'Inclusion proof reaches the batch root', included,
    `leaf ${proof.index + 1} of ${proof.tree_size}, ${path.length} hashes, root ${proof.root.slice(0, 16)}…`));

  // 4. the batch checkpoint is signed by the server's published key
  const b = proof.batch;
  const cp = enc.encode(`AIRSAFE-CHECKPOINT-V1|${b.id}|${proof.root}|${b.leaf_count}|${b.from_ms}|${b.to_ms}`);
  const cpOk = b.checkpoint_signature
    ? await verifyEd25519(proof.server_key.public_key_hex, cp, b64uToBytes(b.checkpoint_signature))
    : false;
  steps.push(step('checkpoint', 'Batch checkpoint signed by the server key', cpOk, proof.server_key.did));

  // 5. the root is on a public chain (this page does not query the chain: tools/verify_proof.mjs does)
  steps.push(b.anchor
    ? step('anchor', 'Root anchored on an EVM chain', null,
      `tx ${b.anchor.tx_hash} (chain ${b.anchor.chain_id}, block ${b.anchor.block_number}). Check it independently with tools/verify_proof.mjs --rpc`)
    : step('anchor', 'Root anchored on an EVM chain', null, 'Not anchored yet (sealed and signed only)'));

  return { ok: steps.every((s) => s.ok !== false), steps };
}
