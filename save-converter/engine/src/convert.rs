//! Converting one save file between PS5 and PC, platform-neutral.
//!
//! This is the whole job for a single file: open the container on one side,
//! re-lay the object stream out for the other side's alignment base, reset the
//! per-account online identity (the save is moving to a different account), and
//! close the container on the other side.

use crate::container;
use crate::container::{FLAG_DEFLATE, FLAG_MANDARIN};
use crate::error::DsssError;
use crate::games::Game;
use crate::mandarin::{MandarinKey, STEAM_ID64_BASE};
use crate::stream::{name_hash, rebase_with, StringField};

/// Which way a save is being converted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// A decrypted PS5 save becomes a PC (Steam) save.
    Ps5ToPc,
    /// A PC (Steam) save becomes a decrypted PS5 save.
    PcToPs5,
}

/// A converted file plus whether its online identity was reset.
pub struct Converted {
    pub data: Vec<u8>,
    /// How many online-identity fields were reset to the fresh-hunter value.
    pub identity_reset: u32,
}

/// The value the game writes for a hunter that has never been online; setting an
/// id to this makes the game issue a fresh one. Verified to be every slot's
/// value in a brand-new save: eight U+002D (`"--------"`).
const FRESH_IDENTITY: &str = "--------";

/// The Mandarin key for a game keyed on `!SteamID64` (Monster Hunter Wilds).
fn key_for(game: &Game, steam_id64: u64) -> MandarinKey {
    MandarinKey {
        enc_seed: game.enc_seed,
        rsa_seed: game.rsa_seed,
        key64: !steam_id64,
    }
}

/// Convert one file.
///
/// `steam_id64` is the account the result is keyed to: for `Ps5ToPc` the PC
/// account that will play it, for `PcToPs5` the account that made the PC input
/// (needed to open it). It is ignored for the side that is not encrypted, but
/// both calls take it so the caller always supplies the one that matters.
pub fn convert(
    game: &Game,
    direction: Direction,
    steam_id64: u64,
    input: &[u8],
) -> Result<Converted, DsssError> {
    let (stream, from_base, to_base) = match direction {
        Direction::Ps5ToPc => {
            let decoded = container::decode(input, None)?;
            (
                decoded.stream,
                decoded.stream_base,
                container::stream_base(FLAG_DEFLATE | FLAG_MANDARIN),
            )
        }
        Direction::PcToPs5 => {
            let key = key_for(game, steam_id64);
            let decoded = container::decode(input, Some(&key))?;
            (
                decoded.stream,
                decoded.stream_base,
                container::stream_base(FLAG_DEFLATE),
            )
        }
    };

    let reset: Vec<u32> = game
        .reset_identity_fields
        .iter()
        .map(|name| name_hash(name))
        .collect();
    let fresh: Vec<u8> = FRESH_IDENTITY
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut identity_reset = 0u32;
    let out_stream = {
        let mut edit = |field: &StringField<'_>| -> Option<Vec<u8>> {
            if reset.contains(&field.name_hash) && field.units != fresh.as_slice() {
                identity_reset += 1;
                Some(fresh.clone())
            } else {
                None
            }
        };
        rebase_with(&stream, from_base, to_base, &mut edit)
            .map_err(|e| DsssError::corrupt(e.to_string()))?
    };

    let data = match direction {
        Direction::Ps5ToPc => {
            let key = key_for(game, steam_id64);
            container::encode(&out_stream, FLAG_DEFLATE | FLAG_MANDARIN, Some(&key))?
        }
        Direction::PcToPs5 => container::encode(&out_stream, FLAG_DEFLATE, None)?,
    };

    Ok(Converted {
        data,
        identity_reset,
    })
}

/// The SteamID64 stored in a Wilds in-game-photo file (`SS1_*`), or `None` when
/// the bytes are not one. Those files carry the account id in clear, so the
/// owner's Steam id can be read from them without decrypting anything.
///
/// Layout: a DSSS v2 file with the HAS_ID flag (`0x02`); after the 12-byte
/// header, aligned up to 8 (so offset 16), a u64 holds the 32-bit account id.
pub fn steam_id_from_photo(file: &[u8]) -> Option<u64> {
    if file.len() < 24 || &file[..4] != b"DSSS" {
        return None;
    }
    let version = u32::from_le_bytes(file[4..8].try_into().ok()?);
    let flags = u32::from_le_bytes(file[8..12].try_into().ok()?);
    const HAS_ID: u32 = 0x02;
    if version != 2 || flags & HAS_ID == 0 {
        return None;
    }
    let id = u64::from_le_bytes(file[16..24].try_into().ok()?);
    if id == 0 {
        None
    } else if id < (1 << 32) {
        Some(STEAM_ID64_BASE + id)
    } else {
        // Already a full id (some files may store it whole).
        Some(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games;

    #[test]
    fn fresh_identity_is_eight_dashes() {
        let units: Vec<u16> = FRESH_IDENTITY.encode_utf16().collect();
        assert_eq!(units, [0x002d; 8]);
    }

    #[test]
    fn photo_id_reads_the_account_and_rejects_other_files() {
        // A minimal HAS_ID header carrying account id 1003123.
        let mut photo = b"DSSS\x02\0\0\0\x02\0\0\0".to_vec(); // magic, v2, flags 0x02 (12 bytes)
        photo.extend_from_slice(&[0u8; 4]); // pad to the 8-aligned id slot at offset 16
        photo.extend_from_slice(&1_003_123u64.to_le_bytes()); // id at offset 16
        photo.extend_from_slice(&[0u8; 8]);
        assert_eq!(
            steam_id_from_photo(&photo),
            Some(STEAM_ID64_BASE + 1_003_123)
        );
        // A deflate-only (PS5) header has no id.
        let ps5 = b"DSSS\x02\0\0\0\x08\0\0\0________________".to_vec();
        assert_eq!(steam_id_from_photo(&ps5), None);
        assert_eq!(steam_id_from_photo(b"not a save"), None);
    }

    #[test]
    fn wilds_game_is_registered() {
        let game = games::by_id("monster-hunter-wilds").expect("wilds present");
        assert_eq!(game.enc_seed, 0x7A36_9552_5526_6CED);
        assert_eq!(game.reset_identity_fields, &["HunterId", "HunterShortId"]);
    }
}
