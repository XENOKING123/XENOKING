//! Monster Hunter Wilds (and, over time, other RE Engine games) save converter
//! — the engine, compiled to WebAssembly and driven by the local web page.
//!
//! The format library ([`container`], [`mandarin`], [`stream`], [`hash`]) is
//! the same code, byte-for-byte verified against real game saves, that the
//! investigation produced; [`convert`] and [`games`] sit on top of it. This
//! file adds only a thin C ABI so the page's JavaScript can pass bytes in and
//! out of WebAssembly linear memory.
//!
//! # ABI
//!
//! The page owns its input bytes, copies them into memory allocated by
//! [`xeno_alloc`], and calls one entry point. Each entry point returns a
//! pointer to a *result buffer* laid out little-endian as:
//!
//! ```text
//!   0  i32 status   0 = ok, 1 = ok-but-empty (no account found), < 0 = error
//!   4  u32 len      length of the payload that follows the 16-byte header
//!   8  u64 value    op-specific (file flags, a SteamID64, or a reset count)
//!  16  .. payload   the converted file, or a UTF-8 error message
//! ```
//!
//! The page reads the header and payload straight out of memory, then frees the
//! result with [`xeno_result_free`] and the input with [`xeno_free`]. Nothing
//! here keeps state between calls.

// The format library keeps its full, tested surface; the ABI below reaches
// only part of it.
#![allow(dead_code)]

mod container;
mod convert;
mod error;
mod games;
mod hash;
mod mandarin;
mod stream;

#[cfg(test)]
mod expected;

#[cfg(test)]
mod real_files_test;

use convert::Direction;
use error::DsssError;

// ── memory the page writes input into / reads results out of ───────────────

/// Reserve `len` bytes in WebAssembly memory and hand back a pointer to them.
#[no_mangle]
pub extern "C" fn xeno_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Release a buffer from [`xeno_alloc`] (`len` must be the value passed to it).
///
/// # Safety
/// `ptr`/`len` must name a live [`xeno_alloc`] buffer that is not freed twice.
#[no_mangle]
pub unsafe extern "C" fn xeno_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

const HEADER_LEN: usize = 16;

/// Pack a result buffer the page can read, as described in the ABI docs.
fn make_result(status: i32, value: u64, payload: &[u8]) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(HEADER_LEN + payload.len());
    buf.extend_from_slice(&status.to_le_bytes());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(&value.to_le_bytes());
    buf.extend_from_slice(payload);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

fn ok(value: u64, payload: &[u8]) -> *mut u8 {
    make_result(0, value, payload)
}

fn empty(value: u64) -> *mut u8 {
    make_result(1, value, &[])
}

fn fail(message: impl std::fmt::Display) -> *mut u8 {
    make_result(-1, 0, message.to_string().as_bytes())
}

/// Free a result buffer returned by an entry point.
///
/// # Safety
/// `ptr` must be a result buffer from this module, freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn xeno_result_free(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(std::slice::from_raw_parts(ptr.add(4), 4));
    let len = u32::from_le_bytes(len_bytes) as usize;
    drop(Vec::from_raw_parts(ptr, 0, HEADER_LEN + len));
}

// ── helpers ────────────────────────────────────────────────────────────────

/// # Safety
/// `ptr`/`len` must name readable memory for the length of the call.
unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

unsafe fn game_by_id(ptr: *const u8, len: usize) -> Result<&'static games::Game, DsssError> {
    let id = std::str::from_utf8(bytes(ptr, len))
        .ok()
        .and_then(games::by_id);
    id.ok_or_else(|| DsssError::corrupt("unknown game"))
}

// ── entry points ───────────────────────────────────────────────────────────

/// The container flags of a save, without a key — enough to tell a PC save
/// (`0x18`) from a PS5 save (`0x08`). `value` carries the flags; errors say why
/// the bytes are not a readable save.
///
/// # Safety
/// `in_ptr`/`in_len` must name readable input bytes.
#[no_mangle]
pub unsafe extern "C" fn xeno_peek_flags(in_ptr: *const u8, in_len: usize) -> *mut u8 {
    match container::peek_flags(bytes(in_ptr, in_len)) {
        Ok(flags) => ok(u64::from(flags), &[]),
        Err(e) => fail(e),
    }
}

/// The SteamID64 stored in an in-game-photo file (`SS1_*`), so the account can
/// be read without decrypting anything. `value` is the id, or `status` is 1
/// (ok-but-empty) when the bytes are not such a file.
///
/// # Safety
/// `in_ptr`/`in_len` must name readable input bytes.
#[no_mangle]
pub unsafe extern "C" fn xeno_account_from_photo(in_ptr: *const u8, in_len: usize) -> *mut u8 {
    match convert::steam_id_from_photo(bytes(in_ptr, in_len)) {
        Some(id) => ok(id, &[]),
        None => empty(0),
    }
}

/// Try the account ids `start .. start + count` against a PC save; `value` is
/// the matching SteamID64, or `status` is 1 when none in this slice matched
/// (keep searching). The page runs several of these across workers in parallel.
///
/// # Safety
/// The pointer pairs must name readable bytes.
#[no_mangle]
pub unsafe extern "C" fn xeno_find_account(
    game_ptr: *const u8,
    game_len: usize,
    in_ptr: *const u8,
    in_len: usize,
    start: u64,
    count: u64,
) -> *mut u8 {
    let game = match game_by_id(game_ptr, game_len) {
        Ok(game) => game,
        Err(e) => return fail(e),
    };
    let (body, plain_len) = match container::encrypted_parts(bytes(in_ptr, in_len)) {
        Ok(parts) => parts,
        Err(e) => return fail(e),
    };
    match mandarin::find_account_in_range(body, plain_len, game.enc_seed, start, count) {
        Some(id) => ok(id, &[]),
        None => empty(0),
    }
}

/// Convert one file. `direction` is 0 for PS5→PC, 1 for PC→PS5; `steam_id64` is
/// the account the result is keyed to (the PC account that will play it, or the
/// account that made a PC input). On success the payload is the converted file
/// and `value` is how many online-identity fields were reset.
///
/// # Safety
/// The pointer pairs must name readable bytes.
#[no_mangle]
pub unsafe extern "C" fn xeno_convert(
    game_ptr: *const u8,
    game_len: usize,
    direction: i32,
    steam_id64: u64,
    in_ptr: *const u8,
    in_len: usize,
) -> *mut u8 {
    let game = match game_by_id(game_ptr, game_len) {
        Ok(game) => game,
        Err(e) => return fail(e),
    };
    let direction = match direction {
        0 => Direction::Ps5ToPc,
        1 => Direction::PcToPs5,
        _ => return fail("unknown direction"),
    };
    match convert::convert(game, direction, steam_id64, bytes(in_ptr, in_len)) {
        Ok(converted) => ok(u64::from(converted.identity_reset), &converted.data),
        Err(e) => fail(e),
    }
}

/// Merge: convert a PC save to PS5 while keeping a genuine PS5 hunter's online
/// identity (from `ref`, a decrypted PS5 save registered online on the target
/// account) instead of resetting it. `steam_id64` opens the PC input. On
/// success the payload is the merged PS5 file and `value` is how many slots
/// received a genuine identity.
///
/// # Safety
/// The pointer pairs must name readable bytes.
#[no_mangle]
pub unsafe extern "C" fn xeno_merge(
    game_ptr: *const u8,
    game_len: usize,
    steam_id64: u64,
    pc_ptr: *const u8,
    pc_len: usize,
    ref_ptr: *const u8,
    ref_len: usize,
) -> *mut u8 {
    let game = match game_by_id(game_ptr, game_len) {
        Ok(game) => game,
        Err(e) => return fail(e),
    };
    match convert::merge_pc_to_ps5(
        game,
        steam_id64,
        bytes(pc_ptr, pc_len),
        bytes(ref_ptr, ref_len),
    ) {
        Ok(converted) => ok(u64::from(converted.identity_reset), &converted.data),
        Err(e) => fail(e),
    }
}
