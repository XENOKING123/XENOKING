//! The two non-cryptographic hashes the DSSS container relies on.
//!
//! * [`murmur3_x86_32`] — MurmurHash3 (x86, 32-bit). With seed `0xFFFF_FFFF`
//!   it is the checksum in the last four bytes of every DSSS file, and the
//!   hash of type and field names inside the object stream.
//! * [`cityhash64`] — CityHash64 as of CityHash v1.1, unseeded. Every Mandarin
//!   block stores the CityHash64 of its plaintext.
//!
//! Both are written from the published algorithm descriptions and checked
//! against an independent Python implementation for every input length from
//! 0 to 300 bytes plus a number of large inputs (see the tests below and
//! `scripts/gen_expected.py`).

/// MurmurHash3, x86 32-bit variant.
///
/// The length that is mixed into the hash is the input length modulo 2^32,
/// exactly as in the reference implementation.
pub fn murmur3_x86_32(data: &[u8], seed: u32) -> u32 {
    const C1: u32 = 0xCC9E_2D51;
    const C2: u32 = 0x1B87_3593;

    fn scramble(k: u32) -> u32 {
        k.wrapping_mul(C1).rotate_left(15).wrapping_mul(C2)
    }

    let mut hash = seed;
    let mut words = data.chunks_exact(4);
    for word in &mut words {
        let k = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        hash ^= scramble(k);
        hash = hash
            .rotate_left(13)
            .wrapping_mul(5)
            .wrapping_add(0xE654_6B64);
    }

    let tail = words.remainder();
    if !tail.is_empty() {
        let mut k = 0u32;
        for (index, &byte) in tail.iter().enumerate() {
            k |= u32::from(byte) << (8 * index);
        }
        hash ^= scramble(k);
    }

    hash ^= data.len() as u32;
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85EB_CA6B);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xC2B2_AE35);
    hash ^ (hash >> 16)
}

const K0: u64 = 0xC3A5_C85C_97CB_3127;
const K1: u64 = 0xB492_B66F_BE98_F273;
const K2: u64 = 0x9AE1_6A3B_2F90_404F;
const K_MUL: u64 = 0x9DDF_EA08_EB38_2D69;

/// Little-endian u64 at `offset`. Callers guarantee `offset + 8 <= s.len()`.
fn read64(s: &[u8], offset: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&s[offset..offset + 8]);
    u64::from_le_bytes(bytes)
}

/// Little-endian u32 at `offset`, widened. Callers guarantee `offset + 4 <= s.len()`.
fn read32(s: &[u8], offset: usize) -> u64 {
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&s[offset..offset + 4]);
    u64::from(u32::from_le_bytes(bytes))
}

fn shift_mix(value: u64) -> u64 {
    value ^ (value >> 47)
}

fn hash16_mul(u: u64, v: u64, mul: u64) -> u64 {
    let mut a = (u ^ v).wrapping_mul(mul);
    a ^= a >> 47;
    let mut b = (v ^ a).wrapping_mul(mul);
    b ^= b >> 47;
    b.wrapping_mul(mul)
}

fn hash16(u: u64, v: u64) -> u64 {
    hash16_mul(u, v, K_MUL)
}

fn city_0_to_16(s: &[u8]) -> u64 {
    let len = s.len();
    let n = len as u64;
    if len >= 8 {
        let mul = K2.wrapping_add(n.wrapping_mul(2));
        let a = read64(s, 0).wrapping_add(K2);
        let b = read64(s, len - 8);
        let c = b.rotate_right(37).wrapping_mul(mul).wrapping_add(a);
        let d = a.rotate_right(25).wrapping_add(b).wrapping_mul(mul);
        return hash16_mul(c, d, mul);
    }
    if len >= 4 {
        let mul = K2.wrapping_add(n.wrapping_mul(2));
        let a = read32(s, 0);
        return hash16_mul(n.wrapping_add(a << 3), read32(s, len - 4), mul);
    }
    if len > 0 {
        let a = u32::from(s[0]);
        let b = u32::from(s[len >> 1]);
        let c = u32::from(s[len - 1]);
        let y = u64::from(a.wrapping_add(b << 8));
        let z = u64::from((len as u32).wrapping_add(c << 2));
        return shift_mix(y.wrapping_mul(K2) ^ z.wrapping_mul(K0)).wrapping_mul(K2);
    }
    K2
}

fn city_17_to_32(s: &[u8]) -> u64 {
    let len = s.len();
    let mul = K2.wrapping_add((len as u64).wrapping_mul(2));
    let a = read64(s, 0).wrapping_mul(K1);
    let b = read64(s, 8);
    let c = read64(s, len - 8).wrapping_mul(mul);
    let d = read64(s, len - 16).wrapping_mul(K2);
    hash16_mul(
        a.wrapping_add(b)
            .rotate_right(43)
            .wrapping_add(c.rotate_right(30))
            .wrapping_add(d),
        a.wrapping_add(b.wrapping_add(K2).rotate_right(18))
            .wrapping_add(c),
        mul,
    )
}

fn city_33_to_64(s: &[u8]) -> u64 {
    let len = s.len();
    let mul = K2.wrapping_add((len as u64).wrapping_mul(2));
    let a = read64(s, 0).wrapping_mul(K2);
    let b = read64(s, 8);
    let c = read64(s, len - 24);
    let d = read64(s, len - 32);
    let e = read64(s, 16).wrapping_mul(K2);
    let f = read64(s, 24).wrapping_mul(9);
    let g = read64(s, len - 8);
    let h = read64(s, len - 16).wrapping_mul(mul);

    let u = a
        .wrapping_add(g)
        .rotate_right(43)
        .wrapping_add(b.rotate_right(30).wrapping_add(c).wrapping_mul(9));
    let v = (a.wrapping_add(g) ^ d).wrapping_add(f).wrapping_add(1);
    let w = u
        .wrapping_add(v)
        .wrapping_mul(mul)
        .swap_bytes()
        .wrapping_add(h);
    let x = e.wrapping_add(f).rotate_right(42).wrapping_add(c);
    let y = v
        .wrapping_add(w)
        .wrapping_mul(mul)
        .swap_bytes()
        .wrapping_add(g)
        .wrapping_mul(mul);
    let z = e.wrapping_add(f).wrapping_add(c);
    let a = x
        .wrapping_add(z)
        .wrapping_mul(mul)
        .wrapping_add(y)
        .swap_bytes()
        .wrapping_add(b);
    let b = shift_mix(
        z.wrapping_add(a)
            .wrapping_mul(mul)
            .wrapping_add(d)
            .wrapping_add(h),
    )
    .wrapping_mul(mul);
    b.wrapping_add(x)
}

/// Mixes the 32 bytes at `offset` with two seeds; returns the pair of results.
fn weak_hash_32(s: &[u8], offset: usize, a: u64, b: u64) -> (u64, u64) {
    let w = read64(s, offset);
    let x = read64(s, offset + 8);
    let y = read64(s, offset + 16);
    let z = read64(s, offset + 24);

    let a = a.wrapping_add(w);
    let b = b.wrapping_add(a).wrapping_add(z).rotate_right(21);
    let c = a;
    let a = a.wrapping_add(x).wrapping_add(y);
    let b = b.wrapping_add(a.rotate_right(44));
    (a.wrapping_add(z), b.wrapping_add(c))
}

/// CityHash64 (CityHash v1.1), without a seed.
pub fn cityhash64(data: &[u8]) -> u64 {
    let len = data.len();
    if len <= 16 {
        return city_0_to_16(data);
    }
    if len <= 32 {
        return city_17_to_32(data);
    }
    if len <= 64 {
        return city_33_to_64(data);
    }

    let n = len as u64;
    let mut x = read64(data, len - 40);
    let mut y = read64(data, len - 16).wrapping_add(read64(data, len - 56));
    let mut z = hash16(
        read64(data, len - 48).wrapping_add(n),
        read64(data, len - 24),
    );
    let mut v = weak_hash_32(data, len - 64, n, z);
    let mut w = weak_hash_32(data, len - 32, y.wrapping_add(K1), x);
    x = x.wrapping_mul(K1).wrapping_add(read64(data, 0));

    // The main loop walks whole 64-byte chunks from the start; the last
    // (possibly partial) chunk was already folded in through the tail reads
    // above. `len > 64`, so there is always at least one chunk to process.
    let whole = (len - 1) & !63;
    for chunk in data[..whole].chunks_exact(64) {
        x = x
            .wrapping_add(y)
            .wrapping_add(v.0)
            .wrapping_add(read64(chunk, 8))
            .rotate_right(37)
            .wrapping_mul(K1);
        y = y
            .wrapping_add(v.1)
            .wrapping_add(read64(chunk, 48))
            .rotate_right(42)
            .wrapping_mul(K1);
        x ^= w.1;
        y = y.wrapping_add(v.0).wrapping_add(read64(chunk, 40));
        z = z.wrapping_add(w.0).rotate_right(33).wrapping_mul(K1);
        v = weak_hash_32(chunk, 0, v.1.wrapping_mul(K1), x.wrapping_add(w.0));
        w = weak_hash_32(
            chunk,
            32,
            z.wrapping_add(w.1),
            y.wrapping_add(read64(chunk, 16)),
        );
        std::mem::swap(&mut z, &mut x);
    }

    hash16(
        hash16(v.0, w.0)
            .wrapping_add(shift_mix(y).wrapping_mul(K1))
            .wrapping_add(z),
        hash16(v.1, w.1).wrapping_add(x),
    )
}

/// The seed every name hash in a save uses (and the file checksum).
const NAME_SEED: u32 = 0xFFFF_FFFF;

/// The hash under which a field or type name appears in the object stream:
/// MurmurHash3 (x86, 32-bit, seed `0xFFFF_FFFF`) of the name's UTF-8 bytes.
///
/// `name_hash("app.savedata.cUserSaveData")` is `0x827F_CCDC`, the class hash
/// of the first object in a Monster Hunter Wilds character save, and
/// `name_hash("_Data")` is `0x695A_3627`, the hash of its first field — both
/// read out of game-written saves.
pub fn name_hash(name: &str) -> u32 {
    murmur3_x86_32(name.as_bytes(), NAME_SEED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_convert::re_engine::expected;

    /// The byte sequence the expected values were computed over; the same
    /// generator is implemented in `scripts/gen_expected.py`.
    fn sample_bytes(len: usize) -> Vec<u8> {
        let mut state = 0x1234_5678u32;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn murmur3_published_vectors() {
        // Widely published MurmurHash3_x86_32 test values.
        assert_eq!(murmur3_x86_32(b"", 0), 0);
        assert_eq!(murmur3_x86_32(b"", 1), 0x514E_28B7);
        assert_eq!(murmur3_x86_32(b"", 0xFFFF_FFFF), 0x81F1_6F39);
        assert_eq!(murmur3_x86_32(&[0, 0, 0, 0], 0), 0x2362_F9DE);
        assert_eq!(murmur3_x86_32(b"Hello, world!", 0x9747_B28C), 0x2488_4CBA);
        assert_eq!(
            murmur3_x86_32(b"The quick brown fox jumps over the lazy dog", 0x9747_B28C),
            0x2FA8_26CD
        );
    }

    #[test]
    fn murmur3_every_length_up_to_300() {
        let data = sample_bytes(300);
        assert_eq!(expected::MURMUR3_SEED_FFFFFFFF.len(), 301);
        assert_eq!(expected::MURMUR3_SEED_0.len(), 301);
        for len in 0..=300 {
            assert_eq!(
                murmur3_x86_32(&data[..len], 0xFFFF_FFFF),
                expected::MURMUR3_SEED_FFFFFFFF[len],
                "murmur3 seed 0xFFFFFFFF, length {len}"
            );
            assert_eq!(
                murmur3_x86_32(&data[..len], 0),
                expected::MURMUR3_SEED_0[len],
                "murmur3 seed 0, length {len}"
            );
        }
    }

    #[test]
    fn cityhash64_every_length_up_to_300() {
        let data = sample_bytes(300);
        assert_eq!(expected::CITYHASH64.len(), 301);
        for len in 0..=300 {
            assert_eq!(
                cityhash64(&data[..len]),
                expected::CITYHASH64[len],
                "cityhash64, length {len}"
            );
        }
    }

    #[test]
    fn large_inputs() {
        let longest = expected::LARGE.iter().map(|entry| entry.0).max().unwrap();
        let data = sample_bytes(longest);
        for &(len, city, murmur) in expected::LARGE {
            assert_eq!(cityhash64(&data[..len]), city, "cityhash64, length {len}");
            assert_eq!(
                murmur3_x86_32(&data[..len], 0xFFFF_FFFF),
                murmur,
                "murmur3, length {len}"
            );
        }
    }

    #[test]
    fn cityhash64_of_nothing_is_k2() {
        assert_eq!(cityhash64(b""), K2);
    }
}
