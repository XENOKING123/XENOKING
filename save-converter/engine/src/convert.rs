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

/// The class hash of `app.savedata.cUserSaveParam` — one hunter slot. The
/// online identity fields are only grafted/reset inside this class, never on
/// the `HunterId` of other players recorded elsewhere in the save.
fn user_save_param_hash() -> u32 {
    name_hash("app.savedata.cUserSaveParam")
}

/// The `HunterId` and `HunterShortId` of each hunter slot, in slot order, read
/// out of a decoded save stream. Used to carry a genuine PS5 hunter's online
/// identity onto a converted PC save (the "merge").
pub struct SlotIdentities {
    pub hunter_ids: Vec<Vec<u8>>,
    pub short_ids: Vec<Vec<u8>>,
}

pub fn collect_slot_identities(stream: &[u8], base: usize) -> Result<SlotIdentities, DsssError> {
    let slot = user_save_param_hash();
    let hid = name_hash("HunterId");
    let sid = name_hash("HunterShortId");
    let mut ids = SlotIdentities {
        hunter_ids: Vec::new(),
        short_ids: Vec::new(),
    };
    // rebase_with to the same base is a read-only walk when the edit never
    // substitutes; use it to observe every string field in order.
    rebase_with(stream, base, base, &mut |f: &StringField<'_>| {
        if f.class_hash == slot {
            if f.name_hash == hid {
                ids.hunter_ids.push(f.units.to_vec());
            } else if f.name_hash == sid {
                ids.short_ids.push(f.units.to_vec());
            }
        }
        None
    })
    .map_err(|e| DsssError::corrupt(e.to_string()))?;
    Ok(ids)
}

/// Merge: convert a PC save to PS5 **keeping a genuine PS5 hunter's online
/// identity** instead of resetting it, so the result is accepted online on the
/// PSN account that owns `ps5_reference`.
///
/// `pc_input` is the Steam save (opened with `pc_steam_id64`); `ps5_reference`
/// is a decrypted PS5 save of a hunter already registered online on the target
/// account. Each hunter slot of the output takes its progress from the PC save
/// and its `HunterId`/`HunterShortId` from the matching slot of the reference.
/// A PC slot with no genuine reference identity (the reference has fewer slots, or that
/// reference slot is an empty `"--------"`) keeps the PC progress but its
/// identity is reset, so it can't masquerade as a registered hunter.
pub fn merge_pc_to_ps5(
    game: &Game,
    pc_steam_id64: u64,
    pc_input: &[u8],
    ps5_reference: &[u8],
) -> Result<Converted, DsssError> {
    // The genuine identities to graft in, slot by slot.
    let ref_decoded = container::decode(ps5_reference, None)?;
    let donor = collect_slot_identities(&ref_decoded.stream, ref_decoded.stream_base)?;

    // The PC save's progress.
    let key = key_for(game, pc_steam_id64);
    let pc_decoded = container::decode(pc_input, Some(&key))?;
    let to_base = container::stream_base(FLAG_DEFLATE);

    let slot = user_save_param_hash();
    let hid = name_hash("HunterId");
    let sid = name_hash("HunterShortId");
    let fresh: Vec<u8> = "--------"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let is_blank = |u: &[u8]| u == fresh.as_slice();

    let (mut n_hid, mut n_sid, mut grafted) = (0usize, 0usize, 0u32);
    let out_stream = {
        let mut edit = |f: &StringField<'_>| -> Option<Vec<u8>> {
            if f.class_hash != slot {
                return None;
            }
            if f.name_hash == hid {
                let i = n_hid;
                n_hid += 1;
                return match donor.hunter_ids.get(i) {
                    Some(v) if !is_blank(v) => {
                        grafted += 1;
                        Some(v.clone())
                    }
                    // No genuine id for this slot: reset so it isn't a stale
                    // PC id the server would reject.
                    _ => Some(fresh.clone()),
                };
            }
            if f.name_hash == sid {
                let i = n_sid;
                n_sid += 1;
                return match donor.short_ids.get(i) {
                    Some(v) if !is_blank(v) => Some(v.clone()),
                    _ => Some(fresh.clone()),
                };
            }
            None
        };
        rebase_with(
            &pc_decoded.stream,
            pc_decoded.stream_base,
            to_base,
            &mut edit,
        )
        .map_err(|e| DsssError::corrupt(e.to_string()))?
    };

    let data = container::encode(&out_stream, FLAG_DEFLATE, None)?;
    Ok(Converted {
        data,
        // Report how many slots received a genuine identity.
        identity_reset: grafted,
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
