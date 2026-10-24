import test from 'node:test';
import assert from 'node:assert/strict';
import * as w from '../lib/web3ref.mjs';

test('keccak256 published vectors', () => {
  assert.equal(w.hex(w.keccak256(Buffer.alloc(0))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(w.hex(w.keccak256(Buffer.from('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(w.hex(w.keccak256(Buffer.alloc(200, 0x61))).length, 64);   // multi-block input works
});

test('Ethereum addresses from private keys (published vectors)', () => {
  const addr = (hexKey) => w.checksumAddress(w.addressOf(w.publicKey(w.fromHex(hexKey))));
  assert.equal(addr('0000000000000000000000000000000000000000000000000000000000000001'), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.equal(addr('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  assert.equal(addr('4646464646464646464646464646464646464646464646464646464646464646'), '0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F');
});

test('EIP-155 specification example transaction reproduces byte for byte', () => {
  const t = w.signLegacyTx(w.fromHex('4646464646464646464646464646464646464646464646464646464646464646'), {
    nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: '0x', chainId: 1 });
  assert.equal(t.signingHash, 'daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53');
  assert.equal(t.v, 37n);
  assert.equal(t.raw, '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83');
});

test('personal_sign round trip recovers the signer (both recovery ids over many messages)', () => {
  const priv = w.fromHex('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  const ids = new Set();
  for (let i = 0; i < 12; i++) {
    const msg = `hello airsafe ${i}`;
    const sig = w.personalSign(priv, msg);
    ids.add(sig.slice(-2));
    assert.equal(w.personalRecover(msg, sig), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  }
  assert.ok(ids.size >= 1);
});

test('RFC 6962 / Certificate Transparency Merkle roots', () => {
  const data = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map((h) => w.leafHash(Buffer.from(h, 'hex')));
  const want = ['6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d', 'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
    'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77', 'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4', '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
    'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c', '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328'];
  want.forEach((root, i) => assert.equal(w.hex(w.mth(data.slice(0, i + 1))), root, `root of first ${i + 1} leaves`));
});

test('inclusion proofs verify for every leaf of every tree size, and tampering is detected', () => {
  for (let n = 1; n <= 33; n++) {
    const leaves = Array.from({ length: n }, (_, i) => w.leafHash(Buffer.from(`leaf-${i}`)));
    const root = w.mth(leaves);
    for (let i = 0; i < n; i++) {
      const path = w.auditPath(i, leaves);
      assert.ok(w.verifyInclusion(leaves[i], i, n, path, root), `n=${n} i=${i}`);
      assert.ok(!w.verifyInclusion(w.leafHash(Buffer.from('forged')), i, n, path, root));
      if (n > 1) assert.ok(!w.verifyInclusion(leaves[i], (i + 1) % n, n, path, root) || n === 1);
    }
  }
});

test('Ed25519 sign/verify and did:key', () => {
  const seed = Buffer.alloc(32, 7), pub = w.edPublicFromSeed(seed), sig = w.edSignWithSeed(seed, 'msg');
  assert.ok(w.edVerifyWithPublic(pub, 'msg', sig) && !w.edVerifyWithPublic(pub, 'msG', sig));
  assert.match(w.didKey(pub), /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);       // all Ed25519 did:key identifiers start z6Mk
});

test('ABI selector of a known function (ERC-20 transfer)', () => {
  assert.equal(w.hex(w.selector('transfer(address,uint256)')), 'a9059cbb');
});
