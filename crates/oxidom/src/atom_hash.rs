//! The atom hash: one fast multiplicative hash shared by build.rs (which lays out the static atom table)
//! and the runtime interner (which probes that table and its dynamic table with the SAME hash value, so a
//! lookup hashes the name exactly once). Deterministic and platform-independent (explicit u64 math).

/// Hash of `s` (FxHash-style word-at-a-time mixing plus a final avalanche of the high bits).
#[inline]
pub fn atom_hash(s: &[u8]) -> u64 {
    const K: u64 = 0xf135_7aea_2e62_a9c5;
    let mut h = (s.len() as u64).wrapping_mul(K);
    let mut chunks = s.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]);
        h = (h.rotate_left(26) ^ w).wrapping_mul(K);
    }
    let rest = chunks.remainder();
    if !rest.is_empty() {
        let mut buf = [0u8; 8];
        buf[..rest.len()].copy_from_slice(rest);
        h = (h.rotate_left(26) ^ u64::from_le_bytes(buf)).wrapping_mul(K);
    }
    h ^ (h >> 29)
}

/// Home slot of hash `h` in a power-of-two table with `bits` index bits (uses the well-mixed high bits).
#[inline(always)]
pub fn slot(h: u64, bits: u32) -> usize {
    (h.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> (64 - bits)) as usize
}
