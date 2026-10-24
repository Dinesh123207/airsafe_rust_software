// Independent reference implementation of every web3 primitive AIRSAFE uses (Node, no dependencies).
// The Rust backend must produce byte-identical results: backend/fixtures/web3_vectors.json is generated from this file,
// and both sides are checked against published vectors (Keccak, EIP-155, RFC 6962 / Certificate Transparency).
import { createHash, createHmac, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

export const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
export const hex = (b) => Buffer.from(b).toString('hex');
export const fromHex = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
export const b64u = (b) => Buffer.from(b).toString('base64url');

/* ---------------- Keccak-256 (original Keccak padding 0x01, as used by Ethereum) ---------------- */
const RC = [0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n, 0x000000000000808Bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800An, 0x800000008000000An, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1));
    for (let i = 0; i < 25; i++) s[i] ^= D[i % 5];
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & M64 & B[(x + 2) % 5 + 5 * y]);
    s[0] ^= RC[r];
  }
}
export function keccak256(data) {
  const rate = 136, msg = Buffer.from(data);
  const padLen = rate - (msg.length % rate);
  const padded = Buffer.concat([msg, Buffer.alloc(padLen)]);
  padded[msg.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

/* ---------------- secp256k1 (BigInt) with RFC 6979 deterministic ECDSA ---------------- */
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G = [0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) { let [lo, hi, x0, x1] = [mod(a, m), m, 1n, 0n]; while (hi) { const q = lo / hi; [lo, hi] = [hi, lo - q * hi]; [x0, x1] = [x1, x0 - q * x1]; } return mod(x0, m); }
function add(p, q) {
  if (!p) return q; if (!q) return p;
  if (p[0] === q[0]) { if ((p[1] + q[1]) % P === 0n) return null; }
  const l = p[0] === q[0] ? mod(3n * p[0] * p[0] * inv(2n * p[1])) : mod((q[1] - p[1]) * inv(q[0] - p[0]));
  const x = mod(l * l - p[0] - q[0]);
  return [x, mod(l * (p[0] - x) - p[1])];
}
function mul(k, p = G) { let r = null, a = p; while (k > 0n) { if (k & 1n) r = add(r, a); a = add(a, a); k >>= 1n; } return r; }
const toBuf32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const toBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));

export function publicKey(priv) { const [x, y] = mul(toBig(priv)); return Buffer.concat([Buffer.from([4]), toBuf32(x), toBuf32(y)]); }
export function addressOf(pubUncompressed) { return keccak256(pubUncompressed.subarray(1)).subarray(12); }
export function checksumAddress(addr20) {
  const a = hex(addr20), h = hex(keccak256(Buffer.from(a)));
  return '0x' + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

function rfc6979(priv, h1) {            // HMAC-SHA256 DRBG, qlen = 256
  const x = toBuf32(toBig(priv)), z = toBuf32(toBig(h1) % N);
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  const hm = (key, ...p) => createHmac('sha256', key).update(Buffer.concat(p)).digest();
  K = hm(K, V, Buffer.from([0]), x, z); V = hm(K, V);
  K = hm(K, V, Buffer.from([1]), x, z); V = hm(K, V);
  for (;;) { V = hm(K, V); const k = toBig(V); if (k >= 1n && k < N) return k; K = hm(K, V, Buffer.from([0])); V = hm(K, V); }
}
// Returns {r, s, recid}; s is normalised to the lower half (as Ethereum and k256 do).
export function signPrehash(priv, hash32) {
  const d = toBig(priv), z = toBig(hash32), k = rfc6979(priv, hash32);
  const R = mul(k);
  let r = mod(R[0], N), s = mod(inv(k, N) * (z + r * d), N);
  let recid = (R[1] & 1n ? 1 : 0) | (R[0] >= N ? 2 : 0);
  if (s > N / 2n) { s = N - s; recid ^= 1; }
  return { r, s, recid };
}
export function recoverPrehash(hash32, r, s, recid) {
  const x = r + (recid & 2 ? N : 0n);
  const y2 = mod(x ** 3n + 7n);
  let y = 1n, e = (P + 1n) / 4n, b = y2; for (; e > 0n; e >>= 1n) { if (e & 1n) y = mod(y * b); b = mod(b * b); }
  if (mod(y * y) !== y2) throw new Error('bad r');
  if ((y & 1n) !== BigInt(recid & 1)) y = P - y;
  const rinv = inv(r, N), z = toBig(hash32);
  const pt = add(mul(mod(-z * rinv, N)), mul(mod(s * rinv, N), [x, y]));
  return Buffer.concat([Buffer.from([4]), toBuf32(pt[0]), toBuf32(pt[1])]);
}

/* ---------------- EIP-191 personal_sign + SIWE (EIP-4361) ---------------- */
export const eip191Hash = (msg) => { const m = Buffer.from(msg); return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m])); };
export function personalSign(priv, msg) {
  const { r, s, recid } = signPrehash(priv, eip191Hash(msg));
  return '0x' + hex(Buffer.concat([toBuf32(r), toBuf32(s), Buffer.from([27 + recid])]));
}
export function personalRecover(msg, sigHex) {
  const sig = fromHex(sigHex);
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  return checksumAddress(addressOf(recoverPrehash(eip191Hash(msg), toBig(sig.subarray(0, 32)), toBig(sig.subarray(32, 64)), v)));
}
export function siweMessage({ domain, address, statement, uri, chainId, nonce, issuedAt, expirationTime }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expirationTime}`;
}

/* ---------------- RLP + legacy (EIP-155) transaction signing ---------------- */
const be = (n) => { if (n === 0n) return Buffer.alloc(0); let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
export function rlp(x) {
  if (Array.isArray(x)) { const body = Buffer.concat(x.map(rlp)); return Buffer.concat([lenPrefix(body.length, 0xc0), body]); }
  const b = Buffer.from(x);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([lenPrefix(b.length, 0x80), b]);
}
function lenPrefix(len, base) { if (len < 56) return Buffer.from([base + len]); const l = be(BigInt(len)); return Buffer.concat([Buffer.from([base + 55 + l.length]), l]); }
export function signLegacyTx(priv, { nonce, gasPrice, gasLimit, to, value, data, chainId }) {
  const fields = [be(BigInt(nonce)), be(BigInt(gasPrice)), be(BigInt(gasLimit)), fromHex(to), be(BigInt(value)), fromHex(data || '0x')];
  const signingHash = keccak256(rlp([...fields, be(BigInt(chainId)), Buffer.alloc(0), Buffer.alloc(0)]));
  const { r, s, recid } = signPrehash(priv, signingHash);
  const v = BigInt(recid) + BigInt(chainId) * 2n + 35n;
  const raw = rlp([...fields, be(v), be(r), be(s)]);
  return { signingHash: hex(signingHash), v, r, s, raw: '0x' + hex(raw), txHash: '0x' + hex(keccak256(raw)) };
}

/* ---------------- ABI for AirSafeAnchor.anchor(bytes32,uint64,uint64,uint64,uint64) ---------------- */
export const ANCHOR_SIG = 'anchor(bytes32,uint64,uint64,uint64,uint64)';
export const selector = (sig) => keccak256(Buffer.from(sig)).subarray(0, 4);
export const word = (n) => toBuf32(BigInt(n));
export function encodeAnchorCall({ root, batchId, leafCount, fromMs, toMs }) {
  return '0x' + hex(Buffer.concat([selector(ANCHOR_SIG), fromHex(root), word(batchId), word(leafCount), word(fromMs), word(toMs)]));
}

/* ---------------- RFC 6962 Merkle tree (leaf prefix 0x00, node prefix 0x01) ---------------- */
export const leafHash = (data) => sha256(Buffer.from([0]), data);
export const nodeHash = (l, r) => sha256(Buffer.from([1]), l, r);
const splitPoint = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };
export function mth(leaves) {                       // leaves = array of leaf HASHES
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0];
  const k = splitPoint(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}
export function auditPath(m, leaves) {
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  return m < k ? [...auditPath(m, leaves.slice(0, k)), mth(leaves.slice(k))] : [...auditPath(m - k, leaves.slice(k)), mth(leaves.slice(0, k))];
}
export function verifyInclusion(leaf, index, size, path, root) {   // RFC 9162 section 2.1.3.2
  if (index >= size) return false;
  let fn = index, sn = size - 1, r = Buffer.from(leaf);
  for (const p of path) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(Buffer.from(p), r);
      if ((fn & 1) === 0) while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else r = nodeHash(r, Buffer.from(p));
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && Buffer.compare(r, Buffer.from(root)) === 0;
}

/* ---------------- AIRSAFE protocol (see docs/PROTOCOL.md) ---------------- */
export const readingSigMessage = (deviceId, body) => Buffer.concat([Buffer.from(`AIRSAFE-READING-V1\n${deviceId}\n`), Buffer.from(body)]);
export const leafInput = ({ deviceId, readingMs, body, signature }) =>
  Buffer.from(`AIRSAFE-LEAF-V1|${deviceId}|${readingMs}|${hex(sha256(Buffer.from(body)))}|${signature || '-'}`);
export const checkpointMessage = ({ batchId, root, leafCount, fromMs, toMs }) =>
  Buffer.from(`AIRSAFE-CHECKPOINT-V1|${batchId}|${root}|${leafCount}|${fromMs}|${toMs}`);

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export const edPublicFromSeed = (seed) => createPublicKey(createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).subarray(-32);
export const edSignWithSeed = (seed, msg) => edSign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' }));
export const edVerifyWithPublic = (pub, msg, sig) => edVerify(null, Buffer.from(msg), createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pub)]), format: 'der', type: 'spki' }), Buffer.from(sig));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(buf) {
  let n = BigInt('0x' + (hex(buf) || '0')), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}
export const didKey = (pub32) => 'did:key:z' + base58(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from(pub32)]));

export function pubFromDid(did) {
  let n = 0n;
  for (const c of did.replace('did:key:z', '')) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes = Buffer.from(n.toString(16).padStart(68, '0'), 'hex');
  if (bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('not an Ed25519 did:key');
  return bytes.subarray(2);
}
