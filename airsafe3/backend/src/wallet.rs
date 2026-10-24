//! Ethereum wallet primitives: Keccak-256, EIP-191 `personal_sign` recovery, EIP-55 addresses and the
//! EIP-4361 (Sign-In with Ethereum) message. Verified against published vectors and tools/lib/web3ref.mjs.
#[allow(unused_imports)]
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Hash that `personal_sign` signs: keccak256("\x19Ethereum Signed Message:\n" + len + message).
pub fn eip191_hash(msg: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(format!("\x19Ethereum Signed Message:\n{}", msg.len()).as_bytes());
    h.update(msg);
    h.finalize().into()
}

/// Ethereum address of an uncompressed SEC1 public key (0x04 || X || Y).
pub fn address_from_pubkey(uncompressed: &[u8]) -> [u8; 20] {
    let h = keccak256(&uncompressed[1..]);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}

/// Recover the signer of an EIP-191 message from a 65-byte `r || s || v` signature (hex, 0x optional).
pub fn recover_address(msg: &[u8], sig_hex: &str) -> Result<[u8; 20], String> {
    let sig = hex::decode(sig_hex.trim().trim_start_matches("0x")).map_err(|_| "signature is not hex".to_string())?;
    if sig.len() != 65 {
        return Err("signature must be 65 bytes".to_string());
    }
    let v = if sig[64] >= 27 { sig[64] - 27 } else { sig[64] };
    let rec = RecoveryId::try_from(v).map_err(|_| "invalid recovery id".to_string())?;
    let signature = Signature::from_slice(&sig[..64]).map_err(|_| "invalid signature".to_string())?;
    let vk = VerifyingKey::recover_from_prehash(&eip191_hash(msg), &signature, rec)
        .map_err(|_| "cannot recover signer".to_string())?;
    let point = vk.to_encoded_point(false);
    Ok(address_from_pubkey(point.as_bytes()))
}

/// EIP-55 mixed-case checksum address.
pub fn checksum_address(addr: &[u8; 20]) -> String {
    let lower = hex::encode(addr);
    let hash = hex::encode(keccak256(lower.as_bytes()));
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (c, h) in lower.chars().zip(hash.chars()) {
        if c.is_ascii_alphabetic() && h.to_digit(16).unwrap_or(0) >= 8 {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
    }
    out
}

pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let body = s.trim().strip_prefix("0x").or_else(|| s.trim().strip_prefix("0X"))?;
    let bytes = hex::decode(body).ok()?;
    <[u8; 20]>::try_from(bytes.as_slice()).ok()
}

pub struct SiweParams<'a> {
    pub domain: &'a str,
    pub address: &'a str, // EIP-55 checksum form
    pub statement: &'a str,
    pub uri: &'a str,
    pub chain_id: u64,
    pub nonce: &'a str,
    pub issued_at: &'a str,
    pub expiration: &'a str,
}

/// EIP-4361 message. The server builds it, stores it with the nonce, and later verifies the signature against the
/// STORED text, so a client can never get a different message signed than the one the server issued.
pub fn siwe_message(p: &SiweParams) -> String {
    format!(
        "{} wants you to sign in with your Ethereum account:\n{}\n\n{}\n\nURI: {}\nVersion: 1\nChain ID: {}\nNonce: {}\nIssued At: {}\nExpiration Time: {}",
        p.domain, p.address, p.statement, p.uri, p.chain_id, p.nonce, p.issued_at, p.expiration
    )
}
