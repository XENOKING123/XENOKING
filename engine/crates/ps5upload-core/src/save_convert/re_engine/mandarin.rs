//! "Mandarin": the per-account encryption layer of RE Engine DSSS saves
//! (container flag `0x10`).
//!
//! The format was worked out by the authors of two open-source tools, and this
//! module is an original implementation of the algorithm they document in
//! code:
//!
//! * kvasszn/ree-save-editor (GPL-3.0) — `src/save/crypto/mandarin.rs`, `util.rs`
//! * mi5hmash/MandarinJuice (MIT) — `MandarinDeencryptor.cs`
//!
//! # Layout
//!
//! The plaintext is cut into blocks. A block holds `n * 0x4000` bytes with
//! `n` in `1..=8` chosen by a SplitMix64-style generator seeded with a
//! per-game constant (`enc_seed`). Every block is stored as
//!
//! ```text
//! 0x000  4 x { X0 (64 bytes) ; ct_i (64 bytes) }   the AES key and IV, wrapped for the account
//! 0x200  u64  CityHash64 of the block's plaintext
//! 0x208  u64  "tail" (see below)
//! 0x210  AES-128-OFB ciphertext, n * 0x4000 bytes
//! ```
//!
//! with the first 0x210 bytes additionally XOR-ed with generator output. An
//! 0x80-byte trailer follows the last block.
//!
//! The AES key and IV come out of the generator, which is seeded from
//! `enc_seed`, the plaintext length and the account key — so the data can be
//! decrypted without any big-integer arithmetic. The wrapped copy in the
//! block header (`ct_i = X1 * word_i`, an ElGamal-like construction over a
//! 253-bit prime) is still written and, when reading, verified.
//!
//! # Where the two reference tools disagree
//!
//! Checked against game-written PC saves (a character save and a system
//! save of one account): the block headers and the data rebuild to the
//! game's exact bytes; the three items below do not follow either tool and
//! differ between the game's own files, so nothing can be reading them back.
//!
//! | Topic | The game | This module |
//! |:--|:--|:--|
//! | `tail` | 0 in every block of the character save; an arbitrary value in the system save | writes 0 (as ree-save-editor does; MandarinJuice writes `step(bytes left)`). Ignored when reading. |
//! | 0x80 trailer | differs per file; matches neither tool | writes ree-save-editor's deterministic value (MandarinJuice writes random bytes). Ignored when reading. |
//! | padding of the last block | zeros in the character save, leftover bytes in the system save | zeros before encryption. Ignored when reading. |
//! | plaintext length an exact multiple of 0x4000 | the tools run the generator a different number of times. [`decrypt`] accepts both; [`encrypt`] uses ree-save-editor's count, and `container::encode` never produces such a length. |

use crate::save_convert::re_engine::error::DsssError;
use crate::save_convert::re_engine::hash::cityhash64;
use aes::cipher::{BlockCipherEncrypt, KeyInit};
use aes::{Aes128Enc, Block};
use num_bigint::BigUint;

/// `enc_seed` of Monster Hunter Wilds.
pub const WILDS_ENC_SEED: u64 = 0x7A36_9552_5526_6CED;
/// `rsa_seed` of Monster Hunter Wilds.
pub const WILDS_RSA_SEED: u64 = 0xBFAC_F76C_3F96;

/// Largest plaintext [`encrypt`] and [`decrypt`] handle: 256 MiB of save data
/// plus room for compression framing.
pub const MAX_PLAIN_LEN: usize = (256 << 20) + (1 << 20);

/// Largest encrypted body (all blocks plus the trailer) [`decrypt`] handles:
/// what [`encrypt`] can produce at most for [`MAX_PLAIN_LEN`] bytes.
pub const MAX_BODY_LEN: usize =
    MAX_PLAIN_LEN + (MAX_PLAIN_LEN / BLOCK_UNIT + 1) * HEADER_LEN + 8 * BLOCK_UNIT + TRAILER_LEN;

/// Blocks are a multiple of this many bytes.
pub(crate) const BLOCK_UNIT: usize = 0x4000;
/// Bytes in front of the ciphertext of every block.
const HEADER_LEN: usize = 0x210;
/// The wrapped key and IV: four pairs of 64-byte numbers.
const WRAP_LEN: usize = 0x200;
const PAIR_LEN: usize = 0x80;
const HALF_LEN: usize = 0x40;
/// Offset of the CityHash64 inside the block header.
const CHECKSUM_AT: usize = 0x200;
/// Offset of the `tail` value inside the block header.
const TAIL_AT: usize = 0x208;
/// Bytes after the last block.
const TRAILER_LEN: usize = 0x80;

const GOLDEN_GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;

/// Prime modulus of the key wrap, little-endian.
const P_LE: [u8; 32] = hex("f33b6fb972a0b72515e45c391829e182ad8a9bdc0a64d3444d79c810ab863717");
/// Order used to reduce the account key, little-endian.
const Q_LE: [u8; 32] = hex("f99db75c39d0db920a72ae1c8c9470c156c54d6e05b269a2a63c648855c39b0b");
/// Generator of the key wrap, little-endian.
const R_LE: [u8; 32] = hex("e66f544afcce68c5ef07b9a07b277585344a1db61376e831f73b9fbd5f44f715");
/// Fixed exponent of the key wrap.
const E: u32 = 0x14;
/// `R^E mod P`, as the 64 little-endian bytes that open every block header.
/// (Checked against the big-integer computation in the tests.)
const X0_LE: [u8; HALF_LEN] = widen(hex(
    "bb39c81702d5495b671844d2f5ee2b77b811eb6e076b236e41ee7ce342f51612",
));

/// Modulus of the trailer value, little-endian (from ree-save-editor).
const N_LE: [u8; TRAILER_LEN] = hex(concat!(
    "4fa448364f5b3507e945075cc21994bdedef96962c74d53159d50a5c62ed5086",
    "4885ddfe79705dfad0b638220ca2299fccae152164590cc89d33698452a8f641",
    "6107a6952f126bb21ee3e332d2285db728c09bfa8cbd4c3b13b358b9838dea7c",
    "f39dc12e37066a09cf7809a0d0ea06c3bbaa14776400f403f863ed83b5bdd3c2",
));
const TRAILER_EXPONENT: u32 = 65_537;

/// Compile-time hex decoding, so the constants above read like the sources
/// they were taken from. Only ever evaluated by the compiler.
const fn hex<const N: usize>(text: &str) -> [u8; N] {
    const fn digit(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("not a lowercase hex digit"),
        }
    }
    let text = text.as_bytes();
    assert!(text.len() == 2 * N, "wrong number of hex digits");
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = (digit(text[2 * i]) << 4) | digit(text[2 * i + 1]);
        i += 1;
    }
    out
}

/// Zero-extends a 32-byte little-endian number to 64 bytes.
const fn widen(value: [u8; 32]) -> [u8; HALF_LEN] {
    let mut out = [0u8; HALF_LEN];
    let mut i = 0;
    while i < 32 {
        out[i] = value[i];
        i += 1;
    }
    out
}

/// Everything needed to encrypt or decrypt for one account of one game.
#[derive(Clone, Copy, Debug)]
pub struct MandarinKey {
    /// Per-game seed of the generator that drives block sizes, keys and masks.
    pub enc_seed: u64,
    /// Per-game seed that only feeds the 0x80-byte trailer.
    pub rsa_seed: u64,
    /// The account key. For Steam it is the bitwise NOT of the 64-bit Steam ID.
    pub key64: u64,
}

impl MandarinKey {
    /// The key of a Monster Hunter Wilds save owned by the given 64-bit Steam ID
    /// (the 17-digit number, e.g. `76561198000000000`).
    pub fn wilds(steam_id64: u64) -> Self {
        MandarinKey {
            enc_seed: WILDS_ENC_SEED,
            rsa_seed: WILDS_RSA_SEED,
            key64: !steam_id64,
        }
    }
}

/// One generator step. Unlike textbook SplitMix64 the mixed output replaces
/// the state.
fn step(state: u64) -> u64 {
    let mut z = state.wrapping_add(GOLDEN_GAMMA);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// How a plaintext of a given length is cut into blocks.
struct Plan {
    /// Size in bytes of every block that is present, in file order.
    blocks: Vec<usize>,
    /// Generator state after the plan was drawn (before the account key is added).
    state: u64,
}

impl Plan {
    /// Total size of all blocks with their headers, plus the trailer.
    fn body_len(&self) -> usize {
        self.blocks
            .iter()
            .fold(TRAILER_LEN, |sum, &size| sum + HEADER_LEN + size)
    }
}

/// Draws the block plan. The generator is stepped once per "lap"; a lap is a
/// started 0x4000-byte unit of plaintext, so the plan depends on nothing but
/// the seed and the length.
fn block_plan(enc_seed: u64, plain_len: usize) -> Plan {
    let laps = (plain_len / BLOCK_UNIT) + usize::from(!plain_len.is_multiple_of(BLOCK_UNIT));
    let mut state = enc_seed;
    let mut left = plain_len;
    let mut blocks = Vec::new();
    for _ in 0..laps {
        if left > 0 {
            let size = (((state & 7) as usize) + 1) * BLOCK_UNIT;
            blocks.push(size);
            left = left.saturating_sub(size);
        }
        state = step(state);
    }
    Plan { blocks, state }
}

/// The AES key and IV of the next block: sixteen steps, the lowest byte of
/// each state goes to the key and the second-lowest to the IV.
fn next_key_iv(state: &mut u64) -> ([u8; 16], [u8; 16]) {
    let mut key = [0u8; 16];
    let mut iv = [0u8; 16];
    for (k, v) in key.iter_mut().zip(iv.iter_mut()) {
        *state = step(*state);
        *k = *state as u8;
        *v = (*state >> 8) as u8;
    }
    (key, iv)
}

/// Masks or unmasks a block header with generator output.
fn mask_header(state: &mut u64, header: &mut [u8; HEADER_LEN]) {
    for byte in header.iter_mut() {
        *state = step(*state);
        *byte ^= *state as u8;
    }
}

/// True if the first block header, unmasked with the generator at `state`
/// (the state before that block's key and IV are drawn), starts with X0.
fn first_header_opens(mut state: u64, body: &[u8]) -> bool {
    for _ in 0..16 {
        state = step(state);
    }
    body.iter().zip(X0_LE.iter()).all(|(&masked, &want)| {
        state = step(state);
        masked ^ (state as u8) == want
    })
}

/// SteamID64 of an individual account = this base + its 32-bit account id.
pub const STEAM_ID64_BASE: u64 = 0x0110_0001_0000_0000;

/// Finds which Steam account a save was sealed for, for games whose key is
/// `!SteamID64` (Monster Hunter Wilds). This saves the owner from looking the
/// number up by hand before converting their own save.
///
/// `body` and `plain_len` are as for [`decrypt`]. Each block header starts
/// with a fixed value once it is unmasked with the right account's key
/// stream, so every possible 32-bit account id can be tried with a handful of
/// generator steps and no decryption. All cores share the work, each sweeping
/// its own slice of the ids upward, so the time scales with the account id:
/// usually a few seconds, about a minute at worst on a slow machine. Returns
/// `None` when no account matches (the file is not a save of this game, or it
/// is damaged).
///
/// A match is confirmed on 64 bytes, so it is not a coincidence; damage
/// beyond the first header is still reported by [`decrypt`].
pub fn find_steam_id64(body: &[u8], plain_len: u64, enc_seed: u64) -> Option<u64> {
    let plain_len = usize::try_from(plain_len).ok()?;
    if plain_len == 0 || plain_len > MAX_PLAIN_LEN || body.len() < HEADER_LEN {
        return None;
    }
    let plan = block_plan(enc_seed, plain_len);
    // A length that is an exact multiple of the block unit has two readings
    // (see the module documentation); try both.
    let mut starts = vec![plan.state];
    if plain_len.is_multiple_of(BLOCK_UNIT) {
        starts.push(step(plan.state));
    }
    let header = &body[..HALF_LEN];

    const ACCOUNTS: u64 = 1 << 32;
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(64) as u64;
    let found = std::sync::atomic::AtomicU64::new(0);
    std::thread::scope(|scope| {
        for worker in 0..workers {
            let (found, starts) = (&found, &starts);
            scope.spawn(move || {
                // Worker w takes the ids w, w + workers, w + 2*workers, ...
                let mut account = worker;
                let mut since_check = 0u32;
                while account < ACCOUNTS {
                    // Account id 0 does not exist.
                    if account != 0 {
                        let key64 = !(STEAM_ID64_BASE + account);
                        if starts
                            .iter()
                            .any(|&start| first_header_opens(start.wrapping_add(key64), header))
                        {
                            found.store(
                                STEAM_ID64_BASE + account,
                                std::sync::atomic::Ordering::Relaxed,
                            );
                            return;
                        }
                    }
                    // Look at the shared flag now and then, not per candidate.
                    since_check += 1;
                    if since_check == 1 << 16 {
                        since_check = 0;
                        if found.load(std::sync::atomic::Ordering::Relaxed) != 0 {
                            return;
                        }
                    }
                    account += workers;
                }
            });
        }
    });
    match found.load(std::sync::atomic::Ordering::Relaxed) {
        0 => None,
        id => Some(id),
    }
}

fn read_u64(bytes: &[u8]) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[..8]);
    u64::from_le_bytes(word)
}

/// The key and IV as the four 64-bit words that get wrapped.
fn key_words(key: &[u8; 16], iv: &[u8; 16]) -> [u64; 4] {
    [
        read_u64(&key[..8]),
        read_u64(&key[8..]),
        read_u64(&iv[..8]),
        read_u64(&iv[8..]),
    ]
}

/// AES-128 in output-feedback mode: the keystream is the IV encrypted over
/// and over; encryption and decryption are the same operation.
fn aes128_ofb(key: &[u8; 16], iv: &[u8; 16], data: &mut [u8]) {
    let cipher = Aes128Enc::new(&Block::from(*key));
    let mut feedback = Block::from(*iv);
    for chunk in data.chunks_mut(16) {
        cipher.encrypt_block(&mut feedback);
        for (byte, pad) in chunk.iter_mut().zip(feedback.iter()) {
            *byte ^= *pad;
        }
    }
}

/// The account-specific half of the key wrap.
///
/// With `u = key64 mod Q` and `S = R^u mod P`, a writer stores each word `w`
/// as the pair `(X0, X1 * w)` where `X0 = R^E mod P` and `X1 = S^E mod P`; the
/// product is a plain integer product without reduction. A reader recovers
/// `x = X0^u mod P` — which is `X1` again — and divides.
struct KeyWrap {
    x1: BigUint,
}

impl KeyWrap {
    fn new(key64: u64) -> Self {
        let p = BigUint::from_bytes_le(&P_LE);
        let q = BigUint::from_bytes_le(&Q_LE);
        let r = BigUint::from_bytes_le(&R_LE);
        let u = BigUint::from(key64) % q;
        let s = r.modpow(&u, &p);
        KeyWrap {
            x1: s.modpow(&BigUint::from(E), &p),
        }
    }

    /// Writes the four `(X0, X1 * word)` pairs into `out` (0x200 bytes).
    fn wrap(&self, words: &[u64; 4], out: &mut [u8]) {
        for (pair, &word) in out.chunks_exact_mut(PAIR_LEN).zip(words) {
            let (x0, ct) = pair.split_at_mut(HALF_LEN);
            x0.copy_from_slice(&X0_LE);
            ct.fill(0);
            // X1 < 2^253 and word < 2^64, so the product needs at most 40 bytes.
            let product = (&self.x1 * word).to_bytes_le();
            let len = product.len().min(HALF_LEN);
            ct[..len].copy_from_slice(&product[..len]);
        }
    }

    /// Recovers the four words from 0x200 wrapped bytes whose X0 fields have
    /// already been checked. `None` if a division is not exact or the result
    /// does not fit a word — a header no writer would produce.
    fn unwrap(&self, wrapped: &[u8]) -> Option<[u64; 4]> {
        if self.x1.bits() == 0 {
            return None; // cannot happen: P is prime and R is not a multiple of it
        }
        let mut words = [0u64; 4];
        for (pair, word) in wrapped.chunks_exact(PAIR_LEN).zip(words.iter_mut()) {
            let ct = BigUint::from_bytes_le(&pair[HALF_LEN..]);
            let quotient = &ct / &self.x1;
            if &quotient * &self.x1 != ct {
                return None;
            }
            *word = u64::try_from(&quotient).ok()?;
        }
        Some(words)
    }
}

/// The 0x80 bytes after the last block, as ree-save-editor writes them:
/// `m^65537 mod N`, where `m` is 32 little-endian bytes — the account key
/// followed by 24 bytes derived from `rsa_seed`.
///
/// Those 24 bytes are the low bytes of `rsa_seed + (i + 1) * 0x9E3779B97F4A7C15`
/// for `i` in `8..32`: the reference tool advances the generator's counter but
/// does not keep the mixed output in this one place. This is reproduced as is
/// (and matches the tool's sample file bit for bit); whether the game checks
/// the trailer at all is unknown.
fn trailer(key: &MandarinKey) -> [u8; TRAILER_LEN] {
    let mut message = [0u8; 32];
    let mut counter = key.rsa_seed;
    for byte in message.iter_mut() {
        counter = counter.wrapping_add(GOLDEN_GAMMA);
        *byte = counter as u8;
    }
    message[..8].copy_from_slice(&key.key64.to_le_bytes());

    let n = BigUint::from_bytes_le(&N_LE);
    let value = BigUint::from_bytes_le(&message).modpow(&BigUint::from(TRAILER_EXPONENT), &n);
    let bytes = value.to_bytes_le();
    let mut out = [0u8; TRAILER_LEN];
    let len = bytes.len().min(TRAILER_LEN); // value < N < 2^1024, so it always fits
    out[..len].copy_from_slice(&bytes[..len]);
    out
}

/// Encrypts `plain` and returns all blocks followed by the 0x80-byte trailer.
///
/// The output depends only on the arguments: no randomness, no clock.
///
/// If `plain.len()` is an exact multiple of 0x4000 the two reference tools
/// would produce different ciphertexts (see the module documentation); this
/// function then follows ree-save-editor. [`decrypt`] reads either form, but
/// which one the game expects is unknown, so callers should avoid such
/// lengths — `container::encode` does.
pub fn encrypt(plain: &[u8], key: &MandarinKey) -> Result<Vec<u8>, DsssError> {
    encrypt_with_laps(plain, key, false)
}

/// [`encrypt`], optionally with MandarinJuice's lap count for lengths that
/// are a multiple of 0x4000 (one more generator step before the first block).
fn encrypt_with_laps(
    plain: &[u8],
    key: &MandarinKey,
    extra_lap_when_aligned: bool,
) -> Result<Vec<u8>, DsssError> {
    if plain.len() > MAX_PLAIN_LEN {
        return Err(DsssError::TooLarge);
    }
    let plan = block_plan(key.enc_seed, plain.len());
    let mut state = plan.state;
    if extra_lap_when_aligned && plain.len().is_multiple_of(BLOCK_UNIT) {
        state = step(state);
    }
    state = state.wrapping_add(key.key64);

    let wrap = KeyWrap::new(key.key64);
    let mut out = Vec::with_capacity(plan.body_len());
    let mut done = 0;
    for &size in &plan.blocks {
        let left = plain.len() - done;
        let take = left.min(size);
        let chunk = &plain[done..done + take];

        let (aes_key, iv) = next_key_iv(&mut state);
        let mut header = [0u8; HEADER_LEN];
        wrap.wrap(&key_words(&aes_key, &iv), &mut header[..WRAP_LEN]);
        header[CHECKSUM_AT..TAIL_AT].copy_from_slice(&cityhash64(chunk).to_le_bytes());
        // The tail stays zero, as in the game's own character saves.
        mask_header(&mut state, &mut header);
        out.extend_from_slice(&header);

        let start = out.len();
        out.extend_from_slice(chunk);
        out.resize(start + size, 0);
        aes128_ofb(&aes_key, &iv, &mut out[start..]);

        done += take;
    }
    out.extend_from_slice(&trailer(key));
    Ok(out)
}

/// Decrypts the encrypted part of a file.
///
/// `body` is every byte between the 16-byte file header and the trailing u64
/// plaintext length: all blocks plus the 0x80-byte trailer. `plain_len` is
/// that trailing length.
///
/// Errors:
/// * [`DsssError::WrongKey`] — the first block header does not decode with
///   this key (the save belongs to another account);
/// * [`DsssError::Corrupt`] — the size does not fit the recorded length, a
///   later header is wrong, the wrapped key does not match, or a block fails
///   its CityHash64;
/// * [`DsssError::TooLarge`] — beyond [`MAX_PLAIN_LEN`] / [`MAX_BODY_LEN`].
///
/// Not checked, because the tools that write these files disagree on them:
/// the `tail` value of each block header, the bytes that pad the last block,
/// and the content of the trailer.
pub fn decrypt(body: &[u8], plain_len: u64, key: &MandarinKey) -> Result<Vec<u8>, DsssError> {
    if body.len() > MAX_BODY_LEN || plain_len > MAX_PLAIN_LEN as u64 {
        return Err(DsssError::TooLarge);
    }
    let plain_len = usize::try_from(plain_len).map_err(|_| DsssError::TooLarge)?;
    // Ciphertext is never shorter than plaintext. Checking this first keeps
    // the work below proportional to the size of the input actually present.
    if body.len() < TRAILER_LEN || plain_len > body.len() - TRAILER_LEN {
        return Err(DsssError::corrupt(
            "the encrypted data is shorter than the length recorded for it (the file is cut off)",
        ));
    }

    let plan = block_plan(key.enc_seed, plain_len);
    let expected_len = plan.body_len();
    if body.len() < expected_len {
        return Err(DsssError::corrupt(
            "the encrypted data is shorter than the length recorded for it (the file is cut off)",
        ));
    }
    if body.len() > expected_len {
        return Err(DsssError::corrupt(
            "there is unexpected extra data after the encrypted save data",
        ));
    }
    if plan.blocks.is_empty() {
        return Ok(Vec::new()); // nothing but the trailer
    }

    // Position the generator in front of the first block. For lengths that
    // are a multiple of 0x4000 the writer may have stepped it once more.
    let mut state = plan.state.wrapping_add(key.key64);
    if !first_header_opens(state, body) {
        let alternative = step(plan.state).wrapping_add(key.key64);
        if plain_len.is_multiple_of(BLOCK_UNIT) && first_header_opens(alternative, body) {
            state = alternative;
        } else {
            return Err(DsssError::WrongKey);
        }
    }

    let wrap = KeyWrap::new(key.key64);
    let mut plain = Vec::with_capacity(plain_len);
    let mut at = 0;
    for (index, &size) in plan.blocks.iter().enumerate() {
        let number = index + 1;
        let take = (plain_len - plain.len()).min(size);

        let (aes_key, iv) = next_key_iv(&mut state);
        let mut header = [0u8; HEADER_LEN];
        header.copy_from_slice(&body[at..at + HEADER_LEN]);
        mask_header(&mut state, &mut header);

        let x0_everywhere = header[..WRAP_LEN]
            .chunks_exact(PAIR_LEN)
            .all(|pair| pair[..HALF_LEN] == X0_LE);
        if !x0_everywhere {
            return Err(DsssError::corrupt(format!(
                "the header of encrypted block {number} is not valid"
            )));
        }
        if wrap.unwrap(&header[..WRAP_LEN]) != Some(key_words(&aes_key, &iv)) {
            return Err(DsssError::corrupt(format!(
                "the key check of encrypted block {number} failed"
            )));
        }

        let data_at = at + HEADER_LEN;
        let start = plain.len();
        plain.extend_from_slice(&body[data_at..data_at + take]);
        aes128_ofb(&aes_key, &iv, &mut plain[start..]);

        let stored = read_u64(&header[CHECKSUM_AT..]);
        if cityhash64(&plain[start..]) != stored {
            return Err(DsssError::corrupt(format!(
                "the content check of encrypted block {number} failed"
            )));
        }
        at = data_at + size;
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save_convert::re_engine::expected;
    use crate::save_convert::re_engine::hash::murmur3_x86_32;

    fn unhex(text: &str) -> Vec<u8> {
        assert!(text.len().is_multiple_of(2));
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Same generator as in the hash tests and `scripts/gen_expected.py`.
    fn sample_bytes(len: usize) -> Vec<u8> {
        let mut state = 0x1234_5678u32;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 24) as u8
            })
            .collect()
    }

    const FAKE_STEAM_ID: u64 = 76_561_198_012_345_678;

    /// A key whose first block is the smallest possible (0x4000 bytes).
    fn small_key() -> MandarinKey {
        MandarinKey {
            enc_seed: 0x1000,
            rsa_seed: 0x1234,
            key64: !FAKE_STEAM_ID,
        }
    }

    #[test]
    fn step_matches_reference() {
        for &(state, next) in expected::STEP {
            assert_eq!(step(state), next, "step({state:#x})");
        }
    }

    #[test]
    fn constants_are_consistent() {
        let p = BigUint::from_bytes_le(&P_LE);
        let r = BigUint::from_bytes_le(&R_LE);
        let x0 = r.modpow(&BigUint::from(E), &p);
        assert_eq!(BigUint::from_bytes_le(&X0_LE), x0);
        assert_eq!(&X0_LE[..32], &unhex(expected::X0_HEX)[..]);
        assert!(X0_LE[32..].iter().all(|&b| b == 0));
        assert_eq!(p.bits(), 253);
        assert_eq!(BigUint::from_bytes_le(&N_LE).bits(), 1024);
        assert_eq!(HEADER_LEN, WRAP_LEN + 16);
    }

    #[test]
    fn wilds_key() {
        let key = MandarinKey::wilds(1);
        assert_eq!(key.key64, 0xFFFF_FFFF_FFFF_FFFE);
        assert_eq!(key.enc_seed, 0x7A36_9552_5526_6CED);
        assert_eq!(key.rsa_seed, 0xBFAC_F76C_3F96);
    }

    #[test]
    fn block_plan_matches_reference() {
        for case in expected::PLANS {
            let plan = block_plan(case.enc_seed, case.plain_len);
            let label = format!("seed {:#x}, length {:#x}", case.enc_seed, case.plain_len);
            assert_eq!(plan.blocks, case.blocks, "{label}");
            assert_eq!(plan.state, case.state, "{label}");
            if case.plain_len.is_multiple_of(BLOCK_UNIT) {
                assert_eq!(step(plan.state), case.state_extra_lap, "{label}");
            } else {
                assert_eq!(plan.state, case.state_extra_lap, "{label}");
            }
            let covered: usize = plan.blocks.iter().sum();
            assert!(covered >= case.plain_len, "{label}");
            if let Some(last) = plan.blocks.last() {
                assert!(
                    covered - last < case.plain_len,
                    "{label}: a block is not needed"
                );
            }
        }
    }

    #[test]
    fn x1_matches_reference() {
        for &(key64, x1_hex) in expected::X1 {
            let wrap = KeyWrap::new(key64);
            assert_eq!(
                wrap.x1,
                BigUint::from_bytes_le(&unhex(x1_hex)),
                "{key64:#x}"
            );
        }
    }

    #[test]
    fn wrap_matches_reference_and_unwraps() {
        let wrap = KeyWrap::new(expected::WRAP_KEY64);
        let mut wrapped = [0xAAu8; WRAP_LEN];
        wrap.wrap(&expected::WRAP_WORDS, &mut wrapped);
        assert_eq!(&wrapped[..], &unhex(expected::WRAP_HEX)[..]);
        assert_eq!(wrap.unwrap(&wrapped), Some(expected::WRAP_WORDS));
    }

    #[test]
    fn unwrap_rejects_anything_a_writer_would_not_produce() {
        let wrap = KeyWrap::new(expected::WRAP_KEY64);
        let mut wrapped = [0u8; WRAP_LEN];
        let words = [1, 2, 3, u64::MAX];
        wrap.wrap(&words, &mut wrapped);
        assert_eq!(wrap.unwrap(&wrapped), Some(words));
        // every single-bit change of a wrapped word is noticed
        for pair in 0..4 {
            for bit in 0..(HALF_LEN * 8) {
                let mut changed = wrapped;
                changed[pair * PAIR_LEN + HALF_LEN + bit / 8] ^= 1 << (bit % 8);
                assert_ne!(wrap.unwrap(&changed), Some(words), "pair {pair}, bit {bit}");
            }
        }
        // a different account unwraps to something else (or nothing)
        let other = KeyWrap::new(expected::WRAP_KEY64 ^ 1);
        assert_ne!(other.unwrap(&wrapped), Some(words));
    }

    #[test]
    fn aes_ofb_matches_nist_vector() {
        let key: [u8; 16] = unhex(expected::OFB_KEY_HEX).try_into().unwrap();
        let iv: [u8; 16] = unhex(expected::OFB_IV_HEX).try_into().unwrap();
        let mut data = unhex(expected::OFB_PLAIN_HEX);
        aes128_ofb(&key, &iv, &mut data);
        assert_eq!(data, unhex(expected::OFB_CIPHER_HEX));
        aes128_ofb(&key, &iv, &mut data);
        assert_eq!(data, unhex(expected::OFB_PLAIN_HEX));
    }

    #[test]
    fn aes_ofb_handles_a_partial_last_block() {
        let key: [u8; 16] = std::array::from_fn(|i| 0x10 + i as u8);
        let iv: [u8; 16] = std::array::from_fn(|i| 0xA0 + i as u8);
        let mut data = sample_bytes(37);
        aes128_ofb(&key, &iv, &mut data);
        assert_eq!(data, unhex(expected::OFB_PARTIAL_HEX));
        let mut nothing: [u8; 0] = [];
        aes128_ofb(&key, &iv, &mut nothing);
    }

    #[test]
    fn trailer_matches_reference() {
        for &(key64, rsa_seed, trailer_hex) in expected::TRAILERS {
            let key = MandarinKey {
                enc_seed: 0,
                rsa_seed,
                key64,
            };
            assert_eq!(&trailer(&key)[..], &unhex(trailer_hex)[..], "{key64:#x}");
        }
    }

    #[test]
    fn whole_messages_match_reference() {
        let longest = expected::CIPHER_CASES
            .iter()
            .map(|case| case.plain_len)
            .max()
            .unwrap();
        let all = sample_bytes(longest);
        for case in expected::CIPHER_CASES {
            let key = MandarinKey {
                enc_seed: case.enc_seed,
                rsa_seed: case.rsa_seed,
                key64: case.key64,
            };
            let plain = &all[..case.plain_len];
            let body = encrypt_with_laps(plain, &key, case.extra_lap).unwrap();
            assert_eq!(body.len(), case.out_len, "{}", case.name);
            let head = &body[..32.min(body.len())];
            assert_eq!(head, &unhex(case.head_hex)[..], "{}", case.name);
            assert_eq!(
                murmur3_x86_32(&body, 0xFFFF_FFFF),
                case.murmur3,
                "{}",
                case.name
            );
            assert_eq!(cityhash64(&body), case.cityhash64, "{}", case.name);
            // and both lap-count variants decrypt
            let back = decrypt(&body, case.plain_len as u64, &key).unwrap();
            assert_eq!(back, plain, "{}", case.name);
            if !case.extra_lap {
                assert_eq!(encrypt(plain, &key).unwrap(), body, "{}", case.name);
            }
        }
    }

    #[test]
    fn round_trips_at_block_boundaries() {
        let keys = [
            small_key(),
            MandarinKey::wilds(FAKE_STEAM_ID),
            MandarinKey {
                enc_seed: 0xEB9B_6740_CBC6_820F,
                rsa_seed: 0,
                key64: 0,
            },
            MandarinKey {
                enc_seed: u64::MAX,
                rsa_seed: u64::MAX,
                key64: u64::MAX,
            },
        ];
        let lengths = [
            0usize, 1, 15, 16, 17, 0x3FFF, 0x4000, 0x4001, 0x7FFF, 0x8000, 0x8001, 0x17FFF,
            0x18000, 0x18001, 0x20000, 0x2_3457, 0x5_0000,
        ];
        let all = sample_bytes(*lengths.iter().max().unwrap());
        for key in &keys {
            for &len in &lengths {
                let plain = &all[..len];
                let body = encrypt(plain, key).unwrap();
                assert_eq!(body.len(), block_plan(key.enc_seed, len).body_len());
                assert_eq!(body.len() % 4, 0);
                let back = decrypt(&body, len as u64, key).unwrap();
                assert_eq!(back, plain, "seed {:#x}, length {len:#x}", key.enc_seed);
                // encryption is deterministic
                assert_eq!(encrypt(plain, key).unwrap(), body);

                if len.is_multiple_of(BLOCK_UNIT) {
                    let other = encrypt_with_laps(plain, key, true).unwrap();
                    assert_eq!(decrypt(&other, len as u64, key).unwrap(), plain);
                    if len > 0 {
                        assert_ne!(other, body, "the two lap counts must differ");
                    }
                }
            }
        }
    }

    /// Unmasks the header of block `index` and decrypts the whole block,
    /// padding included, by replaying the generator.
    fn open_block(
        body: &[u8],
        plain_len: usize,
        key: &MandarinKey,
        index: usize,
    ) -> (Vec<u8>, Vec<u8>) {
        let plan = block_plan(key.enc_seed, plain_len);
        let mut state = plan.state.wrapping_add(key.key64);
        let mut at = 0;
        for (i, &size) in plan.blocks.iter().enumerate() {
            let (aes_key, iv) = next_key_iv(&mut state);
            let mut header = [0u8; HEADER_LEN];
            header.copy_from_slice(&body[at..at + HEADER_LEN]);
            mask_header(&mut state, &mut header);
            if i == index {
                let mut data = body[at + HEADER_LEN..at + HEADER_LEN + size].to_vec();
                aes128_ofb(&aes_key, &iv, &mut data);
                return (header.to_vec(), data);
            }
            at += HEADER_LEN + size;
        }
        panic!("no block {index}");
    }

    #[test]
    fn the_account_a_save_was_sealed_for_can_be_found() {
        // A low account id keeps the search short; the sweep is the same
        // for any id.
        let steam_id = STEAM_ID64_BASE + 123_457;
        let key = MandarinKey {
            key64: !steam_id,
            ..small_key()
        };
        for len in [1usize, 0x123, 0x4000, 0x4000 + 0x123] {
            let body = encrypt(&sample_bytes(len), &key).unwrap();
            assert_eq!(
                find_steam_id64(&body, len as u64, key.enc_seed),
                Some(steam_id),
                "len {len:#x}"
            );
        }
        // Nothing to find in bytes that are not a save of this game.
        // (Kept tiny: a miss has to try every account id.)
        assert_eq!(find_steam_id64(&[0u8; 16], 5, key.enc_seed), None);
        assert_eq!(find_steam_id64(&[], 0, key.enc_seed), None);
    }

    #[test]
    fn writer_choices_tail_padding_and_trailer() {
        let key = small_key();
        let len = 0x4000 + 0x123;
        let plain = sample_bytes(len);
        let body = encrypt(&plain, &key).unwrap();
        let plan = block_plan(key.enc_seed, len);
        assert_eq!(plan.blocks.len(), 2);

        // tail = 0, as in the game's own character saves
        let (header0, data0) = open_block(&body, len, &key, 0);
        assert_eq!(read_u64(&header0[TAIL_AT..]), 0);
        assert_eq!(data0, &plain[..0x4000]);
        let (header1, data1) = open_block(&body, len, &key, 1);
        assert_eq!(read_u64(&header1[TAIL_AT..]), 0);
        // checksum covers exactly the plaintext bytes of the block
        assert_eq!(
            read_u64(&header1[CHECKSUM_AT..]),
            cityhash64(&plain[0x4000..])
        );
        // the last block is padded with zeros before encryption
        assert_eq!(&data1[..0x123], &plain[0x4000..]);
        assert!(data1[0x123..].iter().all(|&b| b == 0));
        assert_eq!(data1.len(), plan.blocks[1]);
        // the trailer closes the body
        assert_eq!(&body[body.len() - TRAILER_LEN..], &trailer(&key)[..]);
    }

    #[test]
    fn reader_ignores_tail_padding_and_trailer() {
        let key = small_key();
        let plain = sample_bytes(300);
        let body = encrypt(&plain, &key).unwrap();
        let block_end = HEADER_LEN + 0x4000;
        assert_eq!(body.len(), block_end + TRAILER_LEN);

        // the tail field (masked, at 0x208..0x210), the padding and the trailer may hold anything
        for at in (TAIL_AT..HEADER_LEN)
            .chain(HEADER_LEN + 300..block_end)
            .chain(block_end..body.len())
            .step_by(7)
        {
            let mut changed = body.clone();
            changed[at] ^= 0x5A;
            assert_eq!(
                decrypt(&changed, 300, &key).unwrap(),
                plain,
                "offset {at:#x}"
            );
        }
    }

    #[test]
    fn wrong_account_is_reported_as_wrong_key() {
        let key = small_key();
        for len in [1usize, 300, 0x4000, 0x4001, 0x9000] {
            let body = encrypt(&sample_bytes(len), &key).unwrap();
            for other in [
                key.key64 ^ 1,
                !key.key64,
                0,
                key.key64.wrapping_add(1 << 40),
            ] {
                let wrong = MandarinKey {
                    key64: other,
                    ..key
                };
                assert_eq!(
                    decrypt(&body, len as u64, &wrong).unwrap_err(),
                    DsssError::WrongKey,
                    "length {len:#x}, key {other:#x}"
                );
            }
        }
    }

    #[test]
    fn damage_is_reported_as_corrupt() {
        let key = small_key();
        let len = 0x4000 + 50;
        let plain = sample_bytes(len);
        let body = encrypt(&plain, &key).unwrap();
        let second = HEADER_LEN + 0x4000;
        let is_corrupt =
            |result: Result<Vec<u8>, DsssError>| matches!(result, Err(DsssError::Corrupt(_)));

        // first X0 → wrong key; every other validated part → corrupt
        let mut changed = body.clone();
        changed[0] ^= 1;
        assert_eq!(
            decrypt(&changed, len as u64, &key).unwrap_err(),
            DsssError::WrongKey
        );
        for at in [
            PAIR_LEN,                     // X0 of the second pair
            HALF_LEN,                     // first wrapped word
            3 * PAIR_LEN + HALF_LEN + 39, // last significant byte of the last wrapped word
            3 * PAIR_LEN + HALF_LEN + 63, // its (zero) top byte
            CHECKSUM_AT,
            CHECKSUM_AT + 7,
            HEADER_LEN,        // first data byte
            second - 1,        // last data byte of block 1
            second,            // X0 of block 2
            second + HALF_LEN, // wrapped word of block 2
            second + CHECKSUM_AT,
            second + HEADER_LEN,      // first data byte of block 2
            second + HEADER_LEN + 49, // last data byte of block 2
        ] {
            let mut changed = body.clone();
            changed[at] ^= 0x80;
            assert!(
                is_corrupt(decrypt(&changed, len as u64, &key)),
                "offset {at:#x}"
            );
        }

        // wrong sizes
        assert!(is_corrupt(decrypt(
            &body[..body.len() - 1],
            len as u64,
            &key
        )));
        assert!(is_corrupt(decrypt(&body[..TRAILER_LEN - 1], 0, &key)));
        assert!(is_corrupt(decrypt(&[], 0, &key)));
        let mut longer = body.clone();
        longer.push(0);
        assert!(is_corrupt(decrypt(&longer, len as u64, &key)));
        // a length that implies a different number of blocks
        assert!(is_corrupt(decrypt(&body, 0, &key)));
        assert!(is_corrupt(decrypt(&body, 0x4000, &key)));
        assert!(is_corrupt(decrypt(&body, (len + 0x8000 * 8) as u64, &key)));
        // a length that keeps the block layout but not the content
        assert!(is_corrupt(decrypt(&body, (len + 1) as u64, &key)));
        assert!(is_corrupt(decrypt(&body, (len - 1) as u64, &key)));
    }

    #[test]
    fn absurd_sizes_are_refused_without_work() {
        let key = small_key();
        let body = encrypt(b"x", &key).unwrap();
        assert_eq!(
            decrypt(&body, u64::MAX, &key).unwrap_err(),
            DsssError::TooLarge
        );
        assert_eq!(
            decrypt(&body, MAX_PLAIN_LEN as u64 + 1, &key).unwrap_err(),
            DsssError::TooLarge
        );
        assert!(matches!(
            decrypt(&body, MAX_PLAIN_LEN as u64, &key),
            Err(DsssError::Corrupt(_))
        ));
        assert!(matches!(
            decrypt(&body, 1 << 40, &key),
            Err(DsssError::TooLarge)
        ));
    }

    #[test]
    fn empty_plaintext_is_just_the_trailer() {
        let key = small_key();
        let body = encrypt(&[], &key).unwrap();
        assert_eq!(body.len(), TRAILER_LEN);
        assert_eq!(decrypt(&body, 0, &key).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn size_limits_are_consistent() {
        // The largest plaintext must produce a body the reader accepts.
        let worst_blocks = MAX_PLAIN_LEN / BLOCK_UNIT + 1;
        let worst = MAX_PLAIN_LEN + worst_blocks * HEADER_LEN + (8 * BLOCK_UNIT - 1) + TRAILER_LEN;
        assert!(worst <= MAX_BODY_LEN);
    }
}
