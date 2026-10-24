//! RFC 6962 Merkle tree (as used by Certificate Transparency): leaf prefix 0x00, node prefix 0x01,
//! the tree splits at the largest power of two below n. Inclusion verification follows RFC 9162 section 2.1.3.2.
use crate::crypto::sha256;

pub type Hash = [u8; 32];

pub fn leaf_hash(data: &[u8]) -> Hash {
    let mut v = Vec::with_capacity(data.len() + 1);
    v.push(0u8);
    v.extend_from_slice(data);
    sha256(&v)
}

pub fn node_hash(left: &Hash, right: &Hash) -> Hash {
    let mut v = [0u8; 65];
    v[0] = 1;
    v[1..33].copy_from_slice(left);
    v[33..].copy_from_slice(right);
    sha256(&v)
}

fn split_point(n: usize) -> usize {
    let mut k = 1usize;
    while k * 2 < n {
        k *= 2;
    }
    k
}

/// Merkle tree hash over leaf hashes.
pub fn root(leaves: &[Hash]) -> Hash {
    match leaves.len() {
        0 => sha256(&[]),
        1 => leaves[0],
        n => {
            let k = split_point(n);
            node_hash(&root(&leaves[..k]), &root(&leaves[k..]))
        }
    }
}

/// Audit path (inclusion proof) for leaf `m`.
pub fn audit_path(m: usize, leaves: &[Hash]) -> Vec<Hash> {
    if leaves.len() <= 1 {
        return Vec::new();
    }
    let k = split_point(leaves.len());
    if m < k {
        let mut path = audit_path(m, &leaves[..k]);
        path.push(root(&leaves[k..]));
        path
    } else {
        let mut path = audit_path(m - k, &leaves[k..]);
        path.push(root(&leaves[..k]));
        path
    }
}

pub fn verify_inclusion(leaf: &Hash, index: usize, size: usize, path: &[Hash], expected: &Hash) -> bool {
    if index >= size {
        return false;
    }
    let mut fnum = index;
    let mut sn = size - 1;
    let mut r = *leaf;
    for p in path {
        if sn == 0 {
            return false;
        }
        if fnum & 1 == 1 || fnum == sn {
            r = node_hash(p, &r);
            if fnum & 1 == 0 {
                while fnum & 1 == 0 && fnum != 0 {
                    fnum >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            r = node_hash(&r, p);
        }
        fnum >>= 1;
        sn >>= 1;
    }
    sn == 0 && &r == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_leaf_of_every_size_verifies_and_forgeries_fail() {
        for n in 1..=33usize {
            let leaves: Vec<Hash> = (0..n).map(|i| leaf_hash(format!("leaf-{i}").as_bytes())).collect();
            let r = root(&leaves);
            for i in 0..n {
                let path = audit_path(i, &leaves);
                assert!(verify_inclusion(&leaves[i], i, n, &path, &r), "n={n} i={i}");
                assert!(!verify_inclusion(&leaf_hash(b"forged"), i, n, &path, &r));
            }
        }
    }

    #[test]
    fn empty_tree_is_sha256_of_nothing() {
        assert_eq!(hex::encode(root(&[])), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
