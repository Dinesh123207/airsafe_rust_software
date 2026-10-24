//! Cross-language checks: every value in fixtures/web3_vectors.json was produced by the independent JavaScript
//! reference implementation (tools/lib/web3ref.mjs), itself validated against published vectors (Keccak, EIP-155,
//! RFC 6962 / Certificate Transparency). If this file passes, Rust and JavaScript agree byte for byte.
use airsafe_api::{crypto, evm, merkle, wallet};
use ed25519_dalek::SigningKey;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../fixtures/web3_vectors.json")).unwrap()
}
fn h32(s: &str) -> [u8; 32] {
    <[u8; 32]>::try_from(hex::decode(s.trim_start_matches("0x")).unwrap().as_slice()).unwrap()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}

#[test]
fn keccak_and_addresses() {
    let v = vectors();
    for k in v["keccak"].as_array().unwrap() {
        assert_eq!(hex::encode(wallet::keccak256(&hex::decode(s(k, "input_hex")).unwrap())), s(k, "hash"));
    }
    for a in v["addresses"].as_array().unwrap() {
        let key = evm::signing_key(&h32(s(a, "private_key"))).unwrap();
        assert_eq!(wallet::checksum_address(&evm::address_of(&key)), s(a, "address"));
    }
}

#[test]
fn personal_sign_recovers_the_signer() {
    for p in vectors()["personal_sign"].as_array().unwrap() {
        let signer = wallet::recover_address(s(p, "message").as_bytes(), s(p, "signature")).unwrap();
        assert_eq!(wallet::checksum_address(&signer), s(p, "address"));
        // a different message must not recover the same address
        let other = wallet::recover_address(b"tampered", s(p, "signature"));
        assert!(other.map(|a| wallet::checksum_address(&a) != s(p, "address")).unwrap_or(true));
    }
}

fn check_tx(t: &Value, data: Vec<u8>) {
    let key = evm::signing_key(&h32(s(t, "private_key"))).unwrap();
    let to_str = t["to"].as_str().or_else(|| t["contract"].as_str()).expect("vector has a destination");
    let to = wallet::parse_address(to_str).expect("valid destination address");
    let tx = evm::LegacyTx {
        nonce: t["nonce"].as_u64().unwrap(),
        gas_price: s(t, "gas_price").parse().unwrap(),
        gas_limit: t["gas_limit"].as_u64().unwrap(),
        to,
        value: t["value"].as_str().map(|v| v.parse().unwrap()).unwrap_or(0),
        data,
        chain_id: t["chain_id"].as_u64().unwrap(),
    };
    let signed = evm::sign_legacy(&tx, &key).unwrap();
    assert_eq!(hex::encode(signed.signing_hash), s(t, "signing_hash"));
    assert_eq!(evm::hex0x(&signed.raw), s(t, "raw"));
    assert_eq!(evm::hex0x(&signed.hash), s(t, "tx_hash"));
}

#[test]
fn eip155_specification_example() {
    let v = vectors();
    let t = &v["eip155"];
    check_tx(t, Vec::new());
}

#[test]
fn anchor_transaction_and_calldata() {
    let v = vectors();
    let t = &v["anchor_tx"];
    assert_eq!(hex::encode(evm::anchor_selector()), s(t, "selector"));
    let data = evm::encode_anchor_call(
        &h32(s(t, "root")),
        t["batch_id"].as_u64().unwrap(),
        t["leaf_count"].as_u64().unwrap(),
        t["from_ms"].as_u64().unwrap(),
        t["to_ms"].as_u64().unwrap(),
    );
    assert_eq!(evm::hex0x(&data), s(t, "calldata"));
    check_tx(t, data);
}

#[test]
fn certificate_transparency_roots() {
    let v = vectors();
    let leaves: Vec<merkle::Hash> = v["ct_leaves"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| merkle::leaf_hash(&hex::decode(l.as_str().unwrap()).unwrap()))
        .collect();
    for (i, want) in v["ct_roots"].as_array().unwrap().iter().enumerate() {
        assert_eq!(hex::encode(merkle::root(&leaves[..=i])), want.as_str().unwrap(), "first {} leaves", i + 1);
    }
}

#[test]
fn inclusion_proofs_match_javascript() {
    for p in vectors()["proofs"].as_array().unwrap() {
        let size = p["size"].as_u64().unwrap() as usize;
        let index = p["index"].as_u64().unwrap() as usize;
        let leaves: Vec<merkle::Hash> = (0..size).map(|i| merkle::leaf_hash(format!("leaf-{i}").as_bytes())).collect();
        assert_eq!(hex::encode(leaves[index]), s(p, "leaf_hash"));
        assert_eq!(hex::encode(merkle::root(&leaves)), s(p, "root"));
        let path = merkle::audit_path(index, &leaves);
        let want: Vec<String> = p["path"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(path.iter().map(hex::encode).collect::<Vec<_>>(), want);
        assert!(merkle::verify_inclusion(&leaves[index], index, size, &path, &h32(s(p, "root"))));
    }
}

#[test]
fn protocol_example_end_to_end() {
    let v = vectors();
    let p = &v["protocol"];
    let device_id = s(p, "device_id");

    let dev_key = SigningKey::from_bytes(&h32(s(p, "device_seed")));
    let dev_pub = crypto::public_key_of(&dev_key);
    assert_eq!(hex::encode(dev_pub), s(p, "device_public_key"));
    assert_eq!(crypto::did_key(&dev_pub), s(p, "device_did"));
    assert_eq!(crypto::parse_public_key(s(p, "device_did")).unwrap(), dev_pub);

    let srv_key = SigningKey::from_bytes(&h32(s(p, "server_seed")));
    assert_eq!(crypto::did_key(&crypto::public_key_of(&srv_key)), s(p, "server_did"));

    let mut leaves: Vec<merkle::Hash> = Vec::new();
    for (i, r) in p["readings"].as_array().unwrap().iter().enumerate() {
        let body = s(r, "body");
        let msg = crypto::reading_sig_message(device_id, body.as_bytes());
        if i == 0 {
            assert_eq!(hex::encode(&msg), s(p, "reading_sig_message_hex"));
        }
        let sig = crypto::b64u_decode(s(r, "signature")).unwrap();
        assert!(crypto::verify_ed25519(&dev_pub, &msg, &sig), "device signature of reading {i}");
        assert_eq!(crypto::b64u(&crypto::sign_ed25519(&dev_key, &msg)), s(r, "signature"), "Ed25519 is deterministic");
        assert!(!crypto::verify_ed25519(&dev_pub, &crypto::reading_sig_message(device_id, b"{}"), &sig));

        let input = crypto::leaf_input(device_id, r["reading_ms"].as_i64().unwrap(), body.as_bytes(), Some(s(r, "signature")));
        assert_eq!(String::from_utf8(input.clone()).unwrap(), s(r, "leaf_input"));
        let leaf = merkle::leaf_hash(&input);
        assert_eq!(hex::encode(leaf), s(r, "leaf_hash"));
        let unsigned = crypto::leaf_input(device_id, r["reading_ms"].as_i64().unwrap(), body.as_bytes(), None);
        assert_eq!(String::from_utf8(unsigned).unwrap(), s(r, "unsigned_leaf_input"));
        leaves.push(leaf);
    }

    let root = merkle::root(&leaves);
    assert_eq!(hex::encode(root), s(p, "root"));
    let idx = p["proof_index"].as_u64().unwrap() as usize;
    let path = merkle::audit_path(idx, &leaves);
    let want: Vec<&str> = p["audit_path"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(path.iter().map(hex::encode).collect::<Vec<_>>(), want);
    assert!(merkle::verify_inclusion(&leaves[idx], idx, leaves.len(), &path, &root));

    let b = &p["batch"];
    let msg = crypto::checkpoint_message(
        b["id"].as_i64().unwrap(),
        &hex::encode(root),
        b["leaf_count"].as_i64().unwrap(),
        b["from_ms"].as_i64().unwrap(),
        b["to_ms"].as_i64().unwrap(),
    );
    assert_eq!(String::from_utf8(msg.clone()).unwrap(), s(p, "checkpoint_message"));
    assert_eq!(crypto::b64u(&crypto::sign_ed25519(&srv_key, &msg)), s(p, "checkpoint_signature"));
}
