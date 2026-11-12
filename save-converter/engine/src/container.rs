//! The DSSS container, version 2, as Monster Hunter Wilds writes it.
//!
//! Layouts follow kvasszn/ree-save-editor (`src/save/mod.rs`) and
//! mi5hmash/MandarinJuice (`MandarinFile.cs`); the code here is original.
//!
//! ```text
//! PC (Steam), flags 0x18 = Deflate | Mandarin
//!   0x00  "DSSS", u32 2, u32 0x18, u32 0      16-byte header
//!   0x10  Mandarin blocks + 0x80-byte trailer  plaintext = compression header + raw deflate
//!   -12   u64 length of that plaintext
//!   -4    u32 murmur3 of everything before it (seed 0xFFFFFFFF)
//!
//! PS5, flags 0x08 = Deflate only
//!   0x00  "DSSS", u32 2, u32 0x08              12-byte header
//!   0x0C  4 leftover bytes                     gap up to a multiple of 8
//!   0x10  compression header + raw deflate
//!         0..=3 leftover bytes                 so that the file length is a multiple of 4
//!   -4    u32 murmur3 of everything before it (seed 0xFFFFFFFF)
//!
//! "Leftover": the game serialises the object stream into its buffer at
//! offset 12 and then writes the compression header and the compressed data
//! over it from offset 16. The bytes it does not overwrite — the 4 at 0x0C
//! and the ones that round the length up — still hold the uncompressed
//! stream's bytes for those offsets. A game-written PS5 save rebuilds to its
//! exact bytes that way (with zlib at level 5, which is what the game uses
//! on both platforms), so [`encode`] fills the gaps the same way, and
//! [`decode`] accepts anything in them.
//!
//! compression header (24 bytes)
//!   u64 compressed size + 0x10, u32 1, u32 compressed size, u64 uncompressed size
//! ```
//!
//! The decompressed bytes are the object stream. Its internal alignment is
//! computed as if it started at file offset [`stream_base`]: 16 on PC, 12 on
//! PS5. Converting between the platforms therefore means laying the stream
//! out again, which is not this module's job — [`encode`] takes a stream that
//! is already laid out for the target.
//!
//! Besides the two Wilds layouts, [`decode`] also reads files with flags
//! `0x10` (Mandarin without compression), since that is the same code path.
//!
//! # What the reader does not check
//!
//! [`decode`] is strict about everything it can know for certain (see its
//! documentation). It skips, like both reference readers do, the four bytes
//! at offset 0x0C, and inside the encryption layer the three things listed in
//! [`crate::mandarin::decrypt`]. All of these are covered by the file checksum.

use crate::error::DsssError;
use crate::hash::murmur3_x86_32;
use crate::mandarin::{self, MandarinKey};
use flate2::write::DeflateEncoder;
use flate2::{Compression, Decompress, FlushDecompress, Status};
use std::fmt;
use std::io::Write;

/// The payload is a raw DEFLATE stream behind a 24-byte compression header.
pub const FLAG_DEFLATE: u32 = 0x08;
/// The payload is Mandarin-encrypted for one account.
pub const FLAG_MANDARIN: u32 = 0x10;

/// Largest object stream [`decode`] returns and [`encode`] accepts: 256 MiB.
/// Real streams are around 16 MiB.
pub const MAX_STREAM_LEN: usize = 256 << 20;

/// Largest file [`decode`] looks at. Everything [`encode`] can produce from a
/// stream of [`MAX_STREAM_LEN`] bytes fits.
pub const MAX_FILE_LEN: usize = ENCRYPTED_HEADER_LEN + mandarin::MAX_BODY_LEN + 8 + 4;

/// The DEFLATE levels [`encode`] tries, in this order. The first one is used
/// unless the encrypted layout forbids the resulting length (see [`encode`]).
pub const COMPRESSION_LEVELS: [u32; 9] = [5, 6, 7, 8, 9, 4, 3, 2, 1];

const MAGIC: &[u8; 4] = b"DSSS";
const VERSION: u32 = 2;
const CHECKSUM_SEED: u32 = 0xFFFF_FFFF;
/// Magic, version and flags.
const PLAIN_HEADER_LEN: usize = 12;
/// The header is padded to 16 bytes when the payload is encrypted. For
/// Deflate-only files the payload is aligned to 8 instead, which also lands
/// on 16.
const ENCRYPTED_HEADER_LEN: usize = 16;
const PAYLOAD_AT: usize = 16;
const COMPRESSION_HEADER_LEN: usize = 24;
/// The value of the u32 that follows the first length in the compression header.
const COMPRESSION_KIND: u32 = 1;
/// A non-final stored DEFLATE block without content: valid in front of any
/// DEFLATE stream and inflates to nothing.
const EMPTY_STORED_BLOCK: [u8; 5] = [0x00, 0x00, 0x00, 0xFF, 0xFF];
/// No DEFLATE stream expands by more than this factor (258 bytes per 2 bits).
const MAX_DEFLATE_RATIO: usize = 1032;

/// The result of [`decode`].
#[derive(Clone, PartialEq, Eq)]
pub struct Decoded {
    /// The flags found in the file header.
    pub flags: u32,
    /// The inner object stream.
    pub stream: Vec<u8>,
    /// The file offset the stream's alignment refers to: [`stream_base`]`(flags)`.
    pub stream_base: usize,
}

impl fmt::Debug for Decoded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The stream is megabytes long; show its size, not its bytes.
        f.debug_struct("Decoded")
            .field("flags", &format_args!("{:#04x}", self.flags))
            .field("stream_len", &self.stream.len())
            .field("stream_base", &self.stream_base)
            .finish()
    }
}

/// The file offset the object stream's alignment is relative to: 12 for
/// Deflate-only files (PS5), otherwise 16.
pub fn stream_base(flags: u32) -> usize {
    if flags == FLAG_DEFLATE {
        PLAIN_HEADER_LEN
    } else {
        ENCRYPTED_HEADER_LEN
    }
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    let mut word = [0u8; 4];
    word.copy_from_slice(&bytes[at..at + 4]);
    u32::from_le_bytes(word)
}

fn read_u64(bytes: &[u8], at: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(word)
}

/// The checks every reader starts with: size, magic, version, a supported
/// flag combination and the checksum. Returns the flags and the file without
/// its trailing checksum.
fn checked_content(file: &[u8]) -> Result<(u32, &[u8]), DsssError> {
    if file.len() > MAX_FILE_LEN {
        return Err(DsssError::TooLarge);
    }
    if file.len() < MAGIC.len() || &file[..MAGIC.len()] != MAGIC {
        return Err(DsssError::NotDsss);
    }
    if file.len() < PLAIN_HEADER_LEN {
        return Err(DsssError::corrupt("the file ends inside its header"));
    }
    let version = read_u32(file, 4);
    if version != VERSION {
        return Err(DsssError::UnsupportedVersion(version));
    }
    let flags = read_u32(file, 8);
    if flags == 0 || flags & !(FLAG_DEFLATE | FLAG_MANDARIN) != 0 {
        return Err(DsssError::UnsupportedFlags(flags));
    }

    if file.len() < PAYLOAD_AT + 4 {
        return Err(DsssError::corrupt("the file ends right after its header"));
    }
    let (content, stored) = file.split_at(file.len() - 4);
    if murmur3_x86_32(content, CHECKSUM_SEED) != read_u32(stored, 0) {
        return Err(DsssError::corrupt(
            "the checksum at the end of the file does not match its contents",
        ));
    }
    Ok((flags, content))
}

/// The flags of a valid DSSS v2 save — enough to tell a PC save (Mandarin)
/// from a PS5 save (Deflate only) without a key. Fails exactly where
/// [`decode`] would fail before it needs the key.
pub fn peek_flags(file: &[u8]) -> Result<u32, DsssError> {
    checked_content(file).map(|(flags, _)| flags)
}

/// For a Mandarin-encrypted file: the encrypted body and the recorded length
/// of its plaintext, in the shape [`mandarin::decrypt`] and
/// [`mandarin::find_steam_id64`] take. Used to find the account a PC save
/// belongs to before decoding it.
pub fn encrypted_parts(file: &[u8]) -> Result<(&[u8], u64), DsssError> {
    let (flags, content) = checked_content(file)?;
    if flags & FLAG_MANDARIN == 0 {
        return Err(DsssError::UnsupportedFlags(flags));
    }
    if content.len() < ENCRYPTED_HEADER_LEN + 8 {
        return Err(DsssError::corrupt(
            "the file ends before the encrypted data",
        ));
    }
    let (body, length) =
        content[ENCRYPTED_HEADER_LEN..].split_at(content.len() - ENCRYPTED_HEADER_LEN - 8);
    Ok((body, read_u64(length, 0)))
}

/// Reads a save file: verifies the checksum at its end, removes the Mandarin
/// encryption (which needs `key`) and the compression, and returns the inner
/// object stream.
///
/// `key` is ignored for files that are not encrypted.
///
/// Every one of these is an error, never a warning:
/// * a wrong checksum at the end of the file;
/// * an encrypted block that fails its key check or its CityHash64, or
///   encrypted data whose size does not match the recorded length;
/// * a compression header that is inconsistent, compressed data that does not
///   inflate to exactly the recorded size, or that ends early;
/// * anything after the compressed data other than the bytes that round the
///   file length up to a multiple of four (their content is not checked: the
///   game leaves leftover bytes there).
///
/// A first block that does not decode with `key` is [`DsssError::WrongKey`].
pub fn decode(file: &[u8], key: Option<&MandarinKey>) -> Result<Decoded, DsssError> {
    let (flags, content) = checked_content(file)?;

    let stream = if flags & FLAG_MANDARIN != 0 {
        let key = key.ok_or(DsssError::KeyRequired)?;
        if content.len() < ENCRYPTED_HEADER_LEN + 8 {
            return Err(DsssError::corrupt(
                "the file ends before the encrypted data",
            ));
        }
        let (body, length) =
            content[ENCRYPTED_HEADER_LEN..].split_at(content.len() - ENCRYPTED_HEADER_LEN - 8);
        let plain_len = read_u64(length, 0);
        if flags & FLAG_DEFLATE == 0 && plain_len > MAX_STREAM_LEN as u64 {
            return Err(DsssError::TooLarge);
        }
        let plain = mandarin::decrypt(body, plain_len, key)?;
        if flags & FLAG_DEFLATE != 0 {
            unpack(&plain, Slack::None)?
        } else {
            plain
        }
    } else {
        unpack(&content[PAYLOAD_AT..], Slack::ToMultipleOfFour)?
    };

    Ok(Decoded {
        flags,
        stream,
        stream_base: stream_base(flags),
    })
}

/// Builds a complete save file around an object stream.
///
/// `stream` must already be laid out for [`stream_base`]`(flags)`. `flags`
/// must be `0x08` (PS5 layout; `key` is ignored) or `0x18` (PC layout; `key`
/// is required). The result is fully determined by the arguments.
///
/// [`decode`] of the result returns `stream` unchanged. The file is not
/// byte-identical to one the game or another tool wrote from the same stream,
/// because DEFLATE output differs between compressors.
///
/// For the PC layout the length of the encrypted plaintext (compression
/// header + compressed data) is never an exact multiple of 0x4000: for those
/// lengths the two known implementations of the encryption disagree. If the
/// first compression level lands on such a length the next level in
/// [`COMPRESSION_LEVELS`] is tried, and if every level does, an empty stored
/// DEFLATE block (5 bytes that inflate to nothing) is put in front of the
/// compressed data.
pub fn encode(stream: &[u8], flags: u32, key: Option<&MandarinKey>) -> Result<Vec<u8>, DsssError> {
    let encrypted = match flags {
        FLAG_DEFLATE => false,
        f if f == FLAG_DEFLATE | FLAG_MANDARIN => true,
        _ => return Err(DsssError::UnsupportedFlags(flags)),
    };
    let key = match (encrypted, key) {
        (true, None) => return Err(DsssError::KeyRequired),
        (true, Some(key)) => Some(key),
        (false, _) => None,
    };
    if stream.len() > MAX_STREAM_LEN {
        return Err(DsssError::TooLarge);
    }

    let payload = pack(stream, &COMPRESSION_LEVELS, encrypted)?;
    let mut file;
    if let Some(key) = key {
        let body = mandarin::encrypt(&payload, key)?;
        file = Vec::with_capacity(ENCRYPTED_HEADER_LEN + body.len() + 12);
        write_header(&mut file, flags);
        file.resize(ENCRYPTED_HEADER_LEN, 0);
        file.extend_from_slice(&body);
        file.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        // Header, block headers, blocks, trailer and length are all multiples
        // of four bytes, so the checksum is word-aligned without padding.
        debug_assert_eq!(file.len() % 4, 0);
    } else {
        // The gaps hold what the game's buffer holds there: the bytes of
        // the uncompressed stream, which it serialised at offset 12 before
        // compressing over it (see the module documentation).
        let leftover = |file_offset: usize| {
            stream
                .get(file_offset - PLAIN_HEADER_LEN)
                .copied()
                .unwrap_or(0)
        };
        file = Vec::with_capacity(PAYLOAD_AT + payload.len() + 8);
        write_header(&mut file, flags);
        file.extend((PLAIN_HEADER_LEN..PAYLOAD_AT).map(leftover));
        file.extend_from_slice(&payload);
        let padded = file.len().next_multiple_of(4);
        file.extend((file.len()..padded).map(leftover));
    }
    let checksum = murmur3_x86_32(&file, CHECKSUM_SEED);
    file.extend_from_slice(&checksum.to_le_bytes());
    Ok(file)
}

fn write_header(file: &mut Vec<u8>, flags: u32) {
    file.extend_from_slice(MAGIC);
    file.extend_from_slice(&VERSION.to_le_bytes());
    file.extend_from_slice(&flags.to_le_bytes());
}

/// True if a Mandarin plaintext made of the compression header and
/// `deflated_len` bytes would be an exact multiple of the block unit.
fn lands_on_block_unit(deflated_len: usize) -> bool {
    (COMPRESSION_HEADER_LEN + deflated_len).is_multiple_of(mandarin::BLOCK_UNIT)
}

/// Compresses `stream` and puts the compression header in front.
///
/// With `avoid_block_units` the total length is never a multiple of 0x4000:
/// the levels are tried in order, and as a last resort an empty stored block
/// is prepended to the first level's output.
fn pack(stream: &[u8], levels: &[u32], avoid_block_units: bool) -> Result<Vec<u8>, DsssError> {
    let mut first = None;
    for &level in levels {
        let deflated = deflate_raw(stream, level)?;
        if !(avoid_block_units && lands_on_block_unit(deflated.len())) {
            return frame(stream.len(), &[], &deflated);
        }
        if first.is_none() {
            first = Some(deflated);
        }
    }
    let deflated = match first {
        Some(deflated) => deflated,
        None => deflate_raw(stream, COMPRESSION_LEVELS[0])?,
    };
    if avoid_block_units && lands_on_block_unit(deflated.len()) {
        // Five more bytes cannot land on a multiple of 0x4000 again.
        frame(stream.len(), &EMPTY_STORED_BLOCK, &deflated)
    } else {
        frame(stream.len(), &[], &deflated)
    }
}

/// Writes the compression header followed by `prefix` and `deflated`.
fn frame(stream_len: usize, prefix: &[u8], deflated: &[u8]) -> Result<Vec<u8>, DsssError> {
    let compressed_len = prefix.len() + deflated.len();
    let compressed_u32 = u32::try_from(compressed_len).map_err(|_| DsssError::TooLarge)?;
    let mut out = Vec::with_capacity(COMPRESSION_HEADER_LEN + compressed_len);
    out.extend_from_slice(&(u64::from(compressed_u32) + 0x10).to_le_bytes());
    out.extend_from_slice(&COMPRESSION_KIND.to_le_bytes());
    out.extend_from_slice(&compressed_u32.to_le_bytes());
    out.extend_from_slice(&(stream_len as u64).to_le_bytes());
    out.extend_from_slice(prefix);
    out.extend_from_slice(deflated);
    Ok(out)
}

/// Raw DEFLATE (no zlib or gzip wrapper) at the given level.
fn deflate_raw(data: &[u8], level: u32) -> Result<Vec<u8>, DsssError> {
    // Writing into a Vec cannot fail; the mapping exists only so that no
    // error is ever swallowed or turned into a panic.
    let failed = |error: std::io::Error| {
        DsssError::corrupt(format!("the save data could not be compressed ({error})"))
    };
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
    encoder.write_all(data).map_err(failed)?;
    encoder.finish().map_err(failed)
}

/// What may follow the compressed data inside the payload.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slack {
    /// Nothing: the payload ends with the compressed data (PC layout).
    None,
    /// Bytes of any value up to the next multiple of four (PS5 layout,
    /// where the payload starts at a multiple of four in the file).
    ToMultipleOfFour,
}

/// Checks the compression header and inflates the data behind it.
fn unpack(payload: &[u8], slack: Slack) -> Result<Vec<u8>, DsssError> {
    if payload.len() < COMPRESSION_HEADER_LEN {
        return Err(DsssError::corrupt(
            "the file ends before the compressed save data",
        ));
    }
    let framed_len = read_u64(payload, 0);
    let kind = read_u32(payload, 8);
    let compressed_len = read_u32(payload, 12);
    let stream_len = read_u64(payload, 16);

    if kind != COMPRESSION_KIND || framed_len != u64::from(compressed_len) + 0x10 {
        return Err(DsssError::corrupt(
            "the header of the compressed save data is not valid",
        ));
    }
    if stream_len > MAX_STREAM_LEN as u64 {
        return Err(DsssError::TooLarge);
    }
    let stream_len = usize::try_from(stream_len).map_err(|_| DsssError::TooLarge)?;
    let compressed_len = usize::try_from(compressed_len).map_err(|_| DsssError::TooLarge)?;

    let rest = &payload[COMPRESSION_HEADER_LEN..];
    if compressed_len > rest.len() {
        return Err(DsssError::corrupt(
            "the compressed save data is shorter than its recorded size (the file is cut off)",
        ));
    }
    let (compressed, after) = rest.split_at(compressed_len);
    let padding = match slack {
        Slack::None => 0,
        Slack::ToMultipleOfFour => compressed_len.next_multiple_of(4) - compressed_len,
    };
    if after.len() != padding {
        return Err(DsssError::corrupt(
            "there is unexpected extra data after the compressed save data",
        ));
    }
    if stream_len > compressed_len.saturating_mul(MAX_DEFLATE_RATIO) {
        return Err(DsssError::corrupt(
            "the recorded size of the save data is impossible for the amount of compressed data",
        ));
    }
    inflate_exact(compressed, stream_len)
}

/// Inflates a raw DEFLATE stream that must end exactly at the end of
/// `compressed` and produce exactly `expected_len` bytes.
///
/// `expected_len` has been checked against [`MAX_STREAM_LEN`] and against
/// what `compressed` could possibly expand to, so the buffer allocated here
/// is bounded by the size of the input.
fn inflate_exact(compressed: &[u8], expected_len: usize) -> Result<Vec<u8>, DsssError> {
    let mut out = Vec::new();
    out.try_reserve_exact(expected_len)
        .map_err(|_| DsssError::TooLarge)?;
    out.resize(expected_len, 0);

    let mut inflater = Decompress::new(false);
    let status = inflater
        .decompress(compressed, &mut out, FlushDecompress::Finish)
        .map_err(|_| {
            DsssError::corrupt("the compressed save data is damaged and cannot be unpacked")
        })?;
    let consumed = inflater.total_in();
    let produced = inflater.total_out();

    if status != Status::StreamEnd {
        // Either the output did not fit (more data than recorded) or the
        // input ran out before the stream ended.
        return Err(DsssError::corrupt(
            "the compressed save data does not match its recorded size",
        ));
    }
    if produced != expected_len as u64 {
        return Err(DsssError::corrupt(
            "the compressed save data does not match its recorded size",
        ));
    }
    if consumed != compressed.len() as u64 {
        return Err(DsssError::corrupt(
            "there is unexpected extra data after the compressed save data",
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::cityhash64;

    const PC: u32 = FLAG_DEFLATE | FLAG_MANDARIN;
    const PS5: u32 = FLAG_DEFLATE;

    /// Deterministic noise (xorshift64*), incompressible.
    fn noise(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state ^= state >> 12;
                state ^= state << 25;
                state ^= state >> 27;
                (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 56) as u8
            })
            .collect()
    }

    /// Something shaped like save data: records with a few varying fields,
    /// compressible to a degree that depends on the effort spent.
    fn records(len: usize, seed: u64) -> Vec<u8> {
        let mut out = Vec::with_capacity(len + 64);
        let words = noise(4096, seed);
        let mut i = 0usize;
        while out.len() < len {
            let a = words[i % words.len()] as usize;
            let b = words[(i * 7 + 3) % words.len()] as usize;
            out.extend_from_slice(&(i as u32).to_le_bytes());
            out.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, 0x11, 0, 0, 0]);
            out.extend_from_slice(&words[a..a + (b % 23)]);
            out.extend_from_slice(&[0u8; 12][..(a % 13)]);
            out.extend_from_slice(&(b as u32 * 0x0101_0101).to_le_bytes());
            i += 1;
        }
        out.truncate(len);
        out
    }

    fn key() -> MandarinKey {
        MandarinKey::wilds(76_561_198_012_345_678)
    }

    /// A key whose first block is the smallest possible, for small test files.
    fn small_key() -> MandarinKey {
        MandarinKey {
            enc_seed: 0x1000,
            rsa_seed: 0x1234,
            key64: !76_561_198_012_345_678,
        }
    }

    /// Replaces the checksum at the end so that only deeper checks can object.
    fn reseal(file: &mut [u8]) {
        let at = file.len() - 4;
        let checksum = murmur3_x86_32(&file[..at], CHECKSUM_SEED);
        file[at..].copy_from_slice(&checksum.to_le_bytes());
    }

    fn is_corrupt<T>(result: &Result<T, DsssError>) -> bool {
        matches!(result, Err(DsssError::Corrupt(_)))
    }

    fn plain_len_of(pc_file: &[u8]) -> usize {
        read_u64(pc_file, pc_file.len() - 12) as usize
    }

    #[test]
    fn stream_base_is_12_only_for_deflate_alone() {
        assert_eq!(stream_base(FLAG_DEFLATE), 12);
        assert_eq!(stream_base(FLAG_DEFLATE | FLAG_MANDARIN), 16);
        assert_eq!(stream_base(FLAG_MANDARIN), 16);
        assert_eq!(stream_base(0), 16);
    }

    #[test]
    fn ps5_layout_offsets() {
        let mut paddings_seen = [false; 4];
        for len in 0..200usize {
            let stream = noise(len, 99);
            let file = encode(&stream, PS5, None).unwrap();

            assert_eq!(&file[0x00..0x04], b"DSSS");
            assert_eq!(read_u32(&file, 0x04), 2);
            assert_eq!(read_u32(&file, 0x08), 0x08);
            // The gaps hold the uncompressed stream's bytes for those
            // file offsets (the stream sits at offset 12), zero past its end.
            let leftover = |offset: usize| stream.get(offset - 12).copied().unwrap_or(0);
            for (offset, &byte) in file.iter().enumerate().take(0x10).skip(0x0C) {
                assert_eq!(byte, leftover(offset), "len {len}, offset {offset}");
            }
            let compressed_len = read_u32(&file, 0x1C) as usize;
            assert_eq!(read_u64(&file, 0x10), compressed_len as u64 + 0x10);
            assert_eq!(read_u32(&file, 0x18), 1);
            assert_eq!(read_u64(&file, 0x20), len as u64);
            let data_end = 0x28 + compressed_len;
            let padding = (4 - data_end % 4) % 4;
            paddings_seen[padding] = true;
            assert_eq!(file.len(), data_end + padding + 4);
            assert_eq!(file.len() % 4, 0);
            for (offset, &byte) in file
                .iter()
                .enumerate()
                .take(data_end + padding)
                .skip(data_end)
            {
                assert_eq!(byte, leftover(offset), "len {len}, offset {offset}");
            }
            assert_eq!(
                read_u32(&file, file.len() - 4),
                murmur3_x86_32(&file[..file.len() - 4], 0xFFFF_FFFF)
            );
            assert_eq!(
                inflate_exact(&file[0x28..data_end], len).unwrap(),
                stream,
                "raw deflate at 0x28"
            );

            let decoded = decode(&file, None).unwrap();
            assert_eq!(decoded.flags, 0x08);
            assert_eq!(decoded.stream_base, 12);
            assert_eq!(decoded.stream, stream);
            // a key that is not needed is ignored
            assert_eq!(decode(&file, Some(&key())).unwrap(), decoded);
        }
        assert_eq!(
            paddings_seen, [true; 4],
            "all four padding amounts exercised"
        );
    }

    #[test]
    fn pc_layout_offsets() {
        let key = key();
        let stream = records(50_000, 5);
        let file = encode(&stream, PC, Some(&key)).unwrap();

        assert_eq!(&file[0x00..0x04], b"DSSS");
        assert_eq!(read_u32(&file, 0x04), 2);
        assert_eq!(read_u32(&file, 0x08), 0x18);
        assert_eq!(read_u32(&file, 0x0C), 0);
        assert_eq!(file.len() % 4, 0);
        assert_eq!(
            read_u32(&file, file.len() - 4),
            murmur3_x86_32(&file[..file.len() - 4], 0xFFFF_FFFF)
        );
        let plain_len = read_u64(&file, file.len() - 12);
        let body = &file[0x10..file.len() - 12];
        let plain = mandarin::decrypt(body, plain_len, &key).unwrap();
        assert_eq!(plain.len() as u64, plain_len);
        assert_ne!(plain.len() % 0x4000, 0);
        let compressed_len = read_u32(&plain, 12) as usize;
        assert_eq!(read_u64(&plain, 0), compressed_len as u64 + 0x10);
        assert_eq!(read_u32(&plain, 8), 1);
        assert_eq!(read_u64(&plain, 16), stream.len() as u64);
        assert_eq!(plain.len(), 24 + compressed_len);
        assert_eq!(inflate_exact(&plain[24..], stream.len()).unwrap(), stream);

        let decoded = decode(&file, Some(&key)).unwrap();
        assert_eq!(decoded.flags, 0x18);
        assert_eq!(decoded.stream_base, 16);
        assert_eq!(decoded.stream, stream);
    }

    #[test]
    fn round_trips_both_layouts() {
        let key = key();
        let streams: Vec<Vec<u8>> = vec![
            Vec::new(),
            vec![0x42],
            b"hello, hunter".to_vec(),
            vec![0u8; 100_000],
            noise(70_000, 1),
            records(300_000, 2),
            [records(40_000, 3), noise(40_000, 4), vec![0u8; 40_000]].concat(),
        ];
        for stream in &streams {
            let pc = encode(stream, PC, Some(&key)).unwrap();
            let decoded = decode(&pc, Some(&key)).unwrap();
            assert_eq!(decoded.stream, *stream);
            assert_eq!((decoded.flags, decoded.stream_base), (0x18, 16));
            assert_ne!(plain_len_of(&pc) % 0x4000, 0);

            let ps5 = encode(stream, PS5, None).unwrap();
            let decoded = decode(&ps5, None).unwrap();
            assert_eq!(decoded.stream, *stream);
            assert_eq!((decoded.flags, decoded.stream_base), (0x08, 12));

            // same input, same file
            assert_eq!(encode(stream, PC, Some(&key)).unwrap(), pc);
            assert_eq!(encode(stream, PS5, None).unwrap(), ps5);
        }
    }

    #[test]
    fn mandarin_without_deflate_decodes() {
        // flags 0x10: the plaintext is the stream itself (what MandarinJuice's sample uses)
        let key = small_key();
        let stream = records(5000, 8);
        let mut file = Vec::new();
        write_header(&mut file, FLAG_MANDARIN);
        file.resize(16, 0);
        file.extend_from_slice(&mandarin::encrypt(&stream, &key).unwrap());
        file.extend_from_slice(&(stream.len() as u64).to_le_bytes());
        file.extend_from_slice(&[0; 4]);
        reseal(&mut file);

        let decoded = decode(&file, Some(&key)).unwrap();
        assert_eq!(decoded.flags, 0x10);
        assert_eq!(decoded.stream_base, 16);
        assert_eq!(decoded.stream, stream);
        assert_eq!(decode(&file, None).unwrap_err(), DsssError::KeyRequired);
        // but it is not a layout this crate writes
        assert_eq!(
            encode(&stream, FLAG_MANDARIN, Some(&key)).unwrap_err(),
            DsssError::UnsupportedFlags(0x10)
        );
    }

    #[test]
    fn header_errors() {
        let stream = b"some stream".to_vec();
        let file = encode(&stream, PS5, None).unwrap();

        assert_eq!(decode(&[], None).unwrap_err(), DsssError::NotDsss);
        assert_eq!(decode(b"DSS", None).unwrap_err(), DsssError::NotDsss);
        assert_eq!(
            decode(b"RIFF\x02\0\0\0\x08\0\0\0", None).unwrap_err(),
            DsssError::NotDsss
        );
        assert_eq!(
            decode(b"dsss\x02\0\0\0\x08\0\0\0", None).unwrap_err(),
            DsssError::NotDsss
        );
        assert!(is_corrupt(&decode(b"DSSS", None)));
        assert!(is_corrupt(&decode(b"DSSS\x02\0\0\0\x08\0\0", None)));
        assert!(is_corrupt(&decode(b"DSSS\x02\0\0\0\x08\0\0\0", None)));

        for version in [0u32, 1, 3, 0x0200_0000, u32::MAX] {
            let mut changed = file.clone();
            changed[4..8].copy_from_slice(&version.to_le_bytes());
            reseal(&mut changed);
            assert_eq!(
                decode(&changed, None).unwrap_err(),
                DsssError::UnsupportedVersion(version)
            );
        }
        for flags in [
            0u32,
            0x01,
            0x02,
            0x04,
            0x09,
            0x0A,
            0x0C,
            0x1C,
            0x20,
            0x28,
            0x118,
            u32::MAX,
        ] {
            let mut changed = file.clone();
            changed[8..12].copy_from_slice(&flags.to_le_bytes());
            reseal(&mut changed);
            assert_eq!(
                decode(&changed, Some(&key())).unwrap_err(),
                DsssError::UnsupportedFlags(flags),
                "decode flags {flags:#x}"
            );
        }
        for flags in [
            0u32,
            0x01,
            0x02,
            0x04,
            0x10,
            0x09,
            0x19,
            0x1C,
            0x20,
            0x38,
            u32::MAX,
        ] {
            assert_eq!(
                encode(&stream, flags, Some(&key())).unwrap_err(),
                DsssError::UnsupportedFlags(flags),
                "encode flags {flags:#x}"
            );
        }
    }

    #[test]
    fn key_errors() {
        let key = key();
        let stream = records(2000, 1);
        assert_eq!(
            encode(&stream, PC, None).unwrap_err(),
            DsssError::KeyRequired
        );
        let file = encode(&stream, PC, Some(&key)).unwrap();
        assert_eq!(decode(&file, None).unwrap_err(), DsssError::KeyRequired);
        let other = MandarinKey::wilds(76_561_198_012_345_679);
        assert_eq!(
            decode(&file, Some(&other)).unwrap_err(),
            DsssError::WrongKey
        );
        // a damaged file is reported as damaged before a key is asked for
        let mut damaged = file.clone();
        damaged[100] ^= 1;
        assert!(is_corrupt(&decode(&damaged, None)));
    }

    #[test]
    fn checksum_is_enforced() {
        let file = encode(b"abc", PS5, None).unwrap();
        for at in 0..file.len() {
            let mut changed = file.clone();
            changed[at] ^= 0x01;
            let result = decode(&changed, None);
            if at < 4 {
                assert_eq!(result.unwrap_err(), DsssError::NotDsss);
            } else if at < 8 {
                assert!(matches!(result, Err(DsssError::UnsupportedVersion(_))));
            } else if at < 12 {
                assert!(matches!(result, Err(DsssError::UnsupportedFlags(_))));
            } else {
                assert!(is_corrupt(&result), "offset {at}");
            }
        }
    }

    #[test]
    fn size_limits() {
        // encode: a stream over the limit (never touched, so this costs no real memory)
        let huge = vec![0u8; MAX_STREAM_LEN + 1];
        assert_eq!(encode(&huge, PS5, None).unwrap_err(), DsssError::TooLarge);
        assert_eq!(
            encode(&huge, PC, Some(&key())).unwrap_err(),
            DsssError::TooLarge
        );
        drop(huge);

        // decode: a header that claims more than the limit
        let mut file = encode(b"abc", PS5, None).unwrap();
        file[0x20..0x28].copy_from_slice(&(MAX_STREAM_LEN as u64 + 1).to_le_bytes());
        reseal(&mut file);
        assert_eq!(decode(&file, None).unwrap_err(), DsssError::TooLarge);
        file[0x20..0x28].copy_from_slice(&u64::MAX.to_le_bytes());
        reseal(&mut file);
        assert_eq!(decode(&file, None).unwrap_err(), DsssError::TooLarge);
        // a size within the limit but impossible for this little data: no big allocation, just an error
        file[0x20..0x28].copy_from_slice(&(MAX_STREAM_LEN as u64).to_le_bytes());
        reseal(&mut file);
        assert!(is_corrupt(&decode(&file, None)));

        // everything encode can produce must be readable again
        let worst_payload = COMPRESSION_HEADER_LEN + MAX_STREAM_LEN + MAX_STREAM_LEN / 1000 + 4096;
        assert!(worst_payload <= mandarin::MAX_PLAIN_LEN);
        assert!(PAYLOAD_AT + worst_payload + 3 + 4 <= MAX_FILE_LEN);
    }

    /// Changes a PS5-layout file and reseals it.
    fn ps5_variant(file: &[u8], edit: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let mut changed = file[..file.len() - 4].to_vec();
        edit(&mut changed);
        changed.extend_from_slice(&[0; 4]);
        reseal(&mut changed);
        changed
    }

    #[test]
    fn compression_header_is_enforced() {
        let stream = records(3000, 7);
        let file = encode(&stream, PS5, None).unwrap();
        assert_eq!(decode(&file, None).unwrap().stream, stream);
        let compressed_len = read_u32(&file, 0x1C);

        let cases: Vec<(&str, Vec<u8>)> = vec![
            (
                "first length off by one",
                ps5_variant(&file, |f| f[0x10] ^= 1),
            ),
            (
                "first length high bits",
                ps5_variant(&file, |f| f[0x17] = 0x80),
            ),
            ("kind 0", ps5_variant(&file, |f| f[0x18] = 0)),
            ("kind 2", ps5_variant(&file, |f| f[0x18] = 2)),
            ("kind high bits", ps5_variant(&file, |f| f[0x1B] = 1)),
            (
                "compressed size one less",
                ps5_variant(&file, |f| {
                    f[0x1C..0x20].copy_from_slice(&(compressed_len - 1).to_le_bytes());
                    f[0x10..0x18]
                        .copy_from_slice(&(u64::from(compressed_len) - 1 + 16).to_le_bytes());
                }),
            ),
            (
                "compressed size one more",
                ps5_variant(&file, |f| {
                    f[0x1C..0x20].copy_from_slice(&(compressed_len + 1).to_le_bytes());
                    f[0x10..0x18]
                        .copy_from_slice(&(u64::from(compressed_len) + 1 + 16).to_le_bytes());
                }),
            ),
            (
                "compressed size absurd",
                ps5_variant(&file, |f| {
                    f[0x1C..0x20].copy_from_slice(&u32::MAX.to_le_bytes());
                    f[0x10..0x18].copy_from_slice(&(u64::from(u32::MAX) + 16).to_le_bytes());
                }),
            ),
            (
                "stream size one less",
                ps5_variant(&file, |f| {
                    f[0x20..0x28].copy_from_slice(&2999u64.to_le_bytes())
                }),
            ),
            (
                "stream size one more",
                ps5_variant(&file, |f| {
                    f[0x20..0x28].copy_from_slice(&3001u64.to_le_bytes())
                }),
            ),
            (
                "stream size zero",
                ps5_variant(&file, |f| {
                    f[0x20..0x28].copy_from_slice(&0u64.to_le_bytes())
                }),
            ),
            (
                "deflate data damaged",
                ps5_variant(&file, |f| f[0x30] ^= 0xFF),
            ),
            (
                "four more zero bytes",
                ps5_variant(&file, |f| f.extend_from_slice(&[0; 4])),
            ),
            (
                "eight more zero bytes",
                ps5_variant(&file, |f| f.extend_from_slice(&[0; 8])),
            ),
            (
                "payload cut",
                ps5_variant(&file, |f| f.truncate(f.len() - 8)),
            ),
            ("header cut", ps5_variant(&file, |f| f.truncate(0x20))),
            ("no payload", ps5_variant(&file, |f| f.truncate(0x10))),
        ];
        for (name, changed) in &cases {
            assert!(
                is_corrupt(&decode(changed, None)),
                "{name}: {:?}",
                decode(changed, None)
            );
        }
    }

    #[test]
    fn ps5_padding_may_hold_anything_but_must_be_minimal() {
        // find streams whose compressed size leaves 1, 2 and 3 bytes of padding
        let mut seen = [false; 4];
        for len in 0..64usize {
            let stream = noise(len, 3);
            let file = encode(&stream, PS5, None).unwrap();
            let data_end = 0x28 + read_u32(&file, 0x1C) as usize;
            let padding = file.len() - 4 - data_end;
            seen[padding] = true;
            // The game leaves leftover bytes in the padding and in the gap
            // at 0x0C, so any value there must be accepted.
            for at in (data_end..file.len() - 4).chain(0x0C..0x10) {
                let changed = ps5_variant(&file, |f| f[at] ^= 0xA5);
                assert_eq!(
                    decode(&changed, None).map(|d| d.stream).ok().as_deref(),
                    Some(&stream[..]),
                    "a different filler byte at {at} must not matter"
                );
            }
            // one byte of padding too few / too many
            if padding > 0 {
                let changed = ps5_variant(&file, |f| f.truncate(f.len() - 1));
                assert!(is_corrupt(&decode(&changed, None)));
            }
            let changed = ps5_variant(&file, |f| f.push(0));
            assert!(is_corrupt(&decode(&changed, None)));
        }
        assert_eq!(seen, [true; 4]);
    }

    #[test]
    fn data_after_the_deflate_stream_is_refused() {
        let stream = records(3000, 7);
        let deflated = deflate_raw(&stream, 6).unwrap();

        // one extra byte inside the compressed region, sizes made consistent
        let mut longer = deflated.clone();
        longer.push(0);
        let payload = frame(stream.len(), &[], &longer).unwrap();
        assert!(is_corrupt(&unpack(&payload, Slack::None)));

        // PC layout: the plaintext is longer than header + compressed data
        let key = small_key();
        let mut payload = frame(stream.len(), &[], &deflated).unwrap();
        assert_eq!(unpack(&payload, Slack::None).unwrap(), stream);
        payload.push(0);
        let mut file = Vec::new();
        write_header(&mut file, PC);
        file.resize(16, 0);
        file.extend_from_slice(&mandarin::encrypt(&payload, &key).unwrap());
        file.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        file.extend_from_slice(&[0; 4]);
        reseal(&mut file);
        assert!(is_corrupt(&decode(&file, Some(&key))));

        // a stream cut off before its final block
        let payload = frame(stream.len(), &[], &deflated[..deflated.len() - 1]).unwrap();
        assert!(is_corrupt(&unpack(&payload, Slack::None)));
    }

    #[test]
    fn empty_stored_block_prefix_is_valid_deflate() {
        let stream = records(1000, 4);
        let deflated = deflate_raw(&stream, 6).unwrap();
        let payload = frame(stream.len(), &EMPTY_STORED_BLOCK, &deflated).unwrap();
        assert_eq!(payload.len(), 24 + 5 + deflated.len());
        assert_eq!(unpack(&payload, Slack::None).unwrap(), stream);
    }

    /// Finds a stream whose level-`level` output makes the payload length an
    /// exact multiple of 0x4000, by adjusting the length of an incompressible
    /// tail behind `head` until the compressed size hits the target.
    ///
    /// One more byte of noise costs one or two more compressed bytes, so a
    /// given tail can step over the target; another noise sequence is tried
    /// then.
    fn stream_landing_on_block_unit(head: &[u8], level: u32, units: usize) -> Vec<u8> {
        let target = units * 0x4000 - COMPRESSION_HEADER_LEN;
        let base = deflate_raw(head, level).unwrap().len();
        assert!(base < target, "head is too large for {units} unit(s)");
        for attempt in 0..64u64 {
            let tail = noise(target + 4096, 0xABCD + 2 * attempt);
            let build = |tail_len: usize| [head, &tail[..tail_len]].concat();
            let mut tail_len = target - base;
            let mut tried = Vec::new();
            while tail_len <= tail.len() && !tried.contains(&tail_len) {
                tried.push(tail_len);
                let got = deflate_raw(&build(tail_len), level).unwrap().len();
                if got == target {
                    return build(tail_len);
                }
                tail_len = if got < target {
                    tail_len + (target - got)
                } else {
                    tail_len.saturating_sub(got - target)
                };
            }
        }
        panic!("no stream found whose compressed size lands on a block unit");
    }

    #[test]
    fn retries_with_the_next_level_when_the_length_is_a_multiple_of_0x4000() {
        // Head: compressible data whose compressed size depends on the level.
        let head = records(120_000, 6);
        let stream = stream_landing_on_block_unit(&head, COMPRESSION_LEVELS[0], 2);
        let sizes: Vec<usize> = COMPRESSION_LEVELS
            .iter()
            .map(|&level| COMPRESSION_HEADER_LEN + deflate_raw(&stream, level).unwrap().len())
            .collect();
        assert_eq!(
            sizes[0], 0x8000,
            "the first level lands exactly on two units"
        );
        let chosen = sizes
            .iter()
            .position(|size| !size.is_multiple_of(0x4000))
            .expect("this test needs a level with a different size");
        assert!(chosen > 0);

        // internal view
        let payload = pack(&stream, &COMPRESSION_LEVELS, true).unwrap();
        assert_eq!(payload.len(), sizes[chosen]);
        assert_ne!(payload.len() % 0x4000, 0);
        assert_eq!(unpack(&payload, Slack::None).unwrap(), stream);
        // without the rule the first level is used as is
        assert_eq!(
            pack(&stream, &COMPRESSION_LEVELS, false).unwrap().len(),
            0x8000
        );

        // public view
        let key = key();
        let file = encode(&stream, PC, Some(&key)).unwrap();
        assert_eq!(plain_len_of(&file), sizes[chosen]);
        assert_eq!(decode(&file, Some(&key)).unwrap().stream, stream);
        // the PS5 layout has no such rule
        let ps5 = encode(&stream, PS5, None).unwrap();
        assert_eq!(read_u32(&ps5, 0x1C) as usize + 24, 0x8000);
        assert_eq!(decode(&ps5, None).unwrap().stream, stream);
    }

    #[test]
    fn falls_back_to_an_empty_stored_block_when_every_level_lands_on_0x4000() {
        let head = records(20_000, 9);
        let level = COMPRESSION_LEVELS[0];
        let stream = stream_landing_on_block_unit(&head, level, 1);
        let natural = COMPRESSION_HEADER_LEN + deflate_raw(&stream, level).unwrap().len();
        assert_eq!(natural, 0x4000);

        // With a single level to choose from there is nothing to retry with.
        let payload = pack(&stream, &[level], true).unwrap();
        assert_eq!(payload.len(), 0x4000 + EMPTY_STORED_BLOCK.len());
        assert_eq!(&payload[24..29], &EMPTY_STORED_BLOCK);
        assert_eq!(read_u32(&payload, 12) as usize, payload.len() - 24);
        assert_eq!(read_u64(&payload, 0), payload.len() as u64 - 24 + 16);
        assert_eq!(unpack(&payload, Slack::None).unwrap(), stream);

        // No level at all behaves like the first level alone.
        assert_eq!(pack(&stream, &[], true).unwrap(), payload);
        assert_eq!(pack(&stream, &[], false).unwrap().len(), 0x4000);

        // And the whole file still reads back.
        let key = small_key();
        let mut file = Vec::new();
        write_header(&mut file, PC);
        file.resize(16, 0);
        file.extend_from_slice(&mandarin::encrypt(&payload, &key).unwrap());
        file.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        file.extend_from_slice(&[0; 4]);
        reseal(&mut file);
        assert_eq!(decode(&file, Some(&key)).unwrap().stream, stream);
    }

    #[test]
    fn incompressible_stream_on_a_block_boundary_never_yields_an_aligned_plaintext() {
        // Pure noise: every level stores it, so the sizes barely differ between levels.
        for units in [1usize, 2, 6] {
            let stream = stream_landing_on_block_unit(&[], COMPRESSION_LEVELS[0], units);
            let key = key();
            let file = encode(&stream, PC, Some(&key)).unwrap();
            let plain_len = plain_len_of(&file);
            assert_ne!(plain_len % 0x4000, 0, "{units} unit(s)");
            assert_eq!(decode(&file, Some(&key)).unwrap().stream, stream);
        }
    }

    #[test]
    fn debug_output_stays_small() {
        let decoded = Decoded {
            flags: 0x18,
            stream: vec![7; 1 << 20],
            stream_base: 16,
        };
        let text = format!("{decoded:?}");
        assert!(text.len() < 100, "{text}");
        assert!(text.contains("1048576"));
    }

    #[test]
    fn encode_is_deterministic_and_content_sensitive() {
        let key = key();
        let a = encode(&records(10_000, 1), PC, Some(&key)).unwrap();
        let b = encode(&records(10_000, 1), PC, Some(&key)).unwrap();
        let c = encode(&records(10_000, 2), PC, Some(&key)).unwrap();
        assert_eq!(cityhash64(&a), cityhash64(&b));
        assert_ne!(cityhash64(&a), cityhash64(&c));
    }
}
