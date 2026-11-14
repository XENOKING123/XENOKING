//! The Save Converter codec for Monster Hunter Wilds (and, later, other RE
//! Engine games that seal PC saves the same way).
//!
//! It ties the pieces in [`super`] together. For one file:
//!
//! 1. open the container — a PS5 save (`flags 0x08`, no key) or a PC save
//!    (`flags 0x18`, encrypted for the account that made it);
//! 2. lay the object stream out again for the other platform's base;
//! 3. on the character-data file, reset the hunter's online identity so the
//!    game issues a fresh one, since the save is moving to another account;
//! 4. close the container for the other platform — a PC save needs the key of
//!    the account that will play it, a PS5 save needs none.
//!
//! The Steam account id:
//!
//! * PS5 → PC needs the account that will *play* the save on PC. Only the
//!   player knows it, so it is a required input.
//! * PC → PS5 needs the account that *made* the PC save, to open it. The
//!   player can give it, or leave it blank and have it found from the file
//!   (every PC save names its account, recoverable by trying account ids
//!   against the encryption — see [`super::mandarin::find_steam_id64`]).

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use super::stream::{name_hash, rebase_with, StreamError, StringField};
use super::{container, mandarin, DsssError, MandarinKey, FLAG_DEFLATE, FLAG_MANDARIN};
use crate::save_convert::codec::{Codec, CodecCtx, Converted};
use crate::save_convert::db::{parse_steam_id64, Direction, FileMap, GameProfile};

/// The option both directions read the Steam account id from.
pub(crate) const STEAM_ID_OPTION: &str = "steam_id64";

/// A game whose PC saves use RE Engine's "Mandarin" container keyed on the
/// Steam ID. `codec` id: `"re-engine-dsss"`.
pub(crate) struct ReEngineDsss;

/// The `codec_params` of a [`ReEngineDsss`] profile.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    /// Per-game constant that seeds the block-size generator, as a hex string
    /// (the value does not fit a JSON number safely). Wilds: `"0x7A36955255266CED"`.
    enc_seed: String,
    /// Per-game constant for the encrypted trailer, as a hex string.
    rsa_seed: String,
    /// Names of the string fields holding a per-account online identity. On a
    /// transfer between accounts each is reset to the value the game writes
    /// for a fresh hunter, so the game issues a new one. Absent fields (e.g.
    /// in the system-data file) are simply not found.
    #[serde(default)]
    reset_identity_fields: Vec<String>,
}

impl Params {
    fn parse(value: &serde_json::Value) -> Result<Self> {
        let params: Params =
            serde_json::from_value(value.clone()).context("re-engine-dsss codec_params")?;
        parse_hex_u64(&params.enc_seed).context("enc_seed")?;
        parse_hex_u64(&params.rsa_seed).context("rsa_seed")?;
        Ok(params)
    }

    fn seeds(&self) -> (u64, u64) {
        // Already validated in `parse`.
        (
            parse_hex_u64(&self.enc_seed).unwrap(),
            parse_hex_u64(&self.rsa_seed).unwrap(),
        )
    }
}

fn parse_hex_u64(text: &str) -> Result<u64> {
    let trimmed = text.trim();
    let digits = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("{text:?} is not a 64-bit hex value");
    }
    u64::from_str_radix(digits, 16).map_err(|e| anyhow!("{text:?}: {e}"))
}

/// What the game writes for a hunter that has never been online: the key under
/// which the game regenerates the id. Verified to be the value every slot of a
/// brand-new save carries (`"--------"`, eight U+002D).
const FRESH_IDENTITY: &str = "--------";

impl Codec for ReEngineDsss {
    fn id(&self) -> &'static str {
        "re-engine-dsss"
    }

    fn validate_params(&self, params: &serde_json::Value) -> Result<()> {
        Params::parse(params).map(|_| ())
    }

    fn checks_sources(&self) -> bool {
        true
    }

    /// Reject a file that is the wrong platform before the player fills in the
    /// rest of the form — the clearest moment to catch "this is a PC save, not
    /// a PS5 one". Judges only what the bytes show; the account is not known
    /// here.
    fn check_source(
        &self,
        _game: &GameProfile,
        direction: Direction,
        _file: &FileMap,
        input: &[u8],
    ) -> Result<()> {
        let flags = container::peek_flags(input).map_err(describe)?;
        let encrypted = flags & FLAG_MANDARIN != 0;
        match direction {
            // A PS5 save is deflate-only; an encrypted file here is a PC save.
            Direction::Ps5ToPc if encrypted => {
                bail!("this looks like a PC save, not a PS5 one — it's locked to a Steam account")
            }
            // A PC save is encrypted; a deflate-only file here is a PS5 save.
            Direction::PcToPs5 if !encrypted => {
                bail!("this looks like a PS5 save, not a PC one")
            }
            _ => Ok(()),
        }
    }

    fn convert_file(&self, ctx: &CodecCtx<'_>, _file: &FileMap, input: &[u8]) -> Result<Converted> {
        let params = Params::parse(&ctx.game.codec_params)?;
        let (enc_seed, rsa_seed) = params.seeds();

        let (stream, from_base) = match ctx.direction {
            Direction::Ps5ToPc => {
                let decoded = container::decode(input, None).map_err(describe)?;
                (decoded.stream, decoded.stream_base)
            }
            Direction::PcToPs5 => {
                let key = source_key(ctx, enc_seed, rsa_seed, input)?;
                let decoded = container::decode(input, Some(&key)).map_err(describe)?;
                (decoded.stream, decoded.stream_base)
            }
        };

        let to_base = match ctx.direction {
            Direction::Ps5ToPc => container::stream_base(FLAG_DEFLATE | FLAG_MANDARIN),
            Direction::PcToPs5 => container::stream_base(FLAG_DEFLATE),
        };

        // Re-lay the stream out for the target platform, resetting the online
        // identity fields on the way (none in the system-data file).
        let reset: Vec<u32> = params
            .reset_identity_fields
            .iter()
            .map(|name| name_hash(name))
            .collect();
        let fresh: Vec<u8> = FRESH_IDENTITY
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let mut reset_count = 0usize;
        let edit = |field: &StringField<'_>| -> Option<Vec<u8>> {
            if reset.contains(&field.name_hash) && field.units != fresh.as_slice() {
                reset_count += 1;
                Some(fresh.clone())
            } else {
                None
            }
        };
        let stream = {
            let mut edit = edit;
            rebase_with(&stream, from_base, to_base, &mut edit).map_err(describe_stream)?
        };

        let out = match ctx.direction {
            Direction::Ps5ToPc => {
                let key = target_key(ctx, enc_seed, rsa_seed)?;
                container::encode(&stream, FLAG_DEFLATE | FLAG_MANDARIN, Some(&key))
            }
            Direction::PcToPs5 => container::encode(&stream, FLAG_DEFLATE, None),
        }
        .map_err(describe)?;

        let mut converted = Converted::clean(out);
        if reset_count > 0 {
            converted.warnings.push(format!(
                "reset the online hunter identity ({reset_count} field{}) so the game issues a new \
                 one — online friends, followers and squads tied to the old account won't carry over",
                if reset_count == 1 { "" } else { "s" }
            ));
        }
        Ok(converted)
    }
}

/// The key that opens a PC save: the account that made it, taken from the
/// player's input or, failing that, found from the file.
fn source_key(
    ctx: &CodecCtx<'_>,
    enc_seed: u64,
    rsa_seed: u64,
    input: &[u8],
) -> Result<MandarinKey> {
    if let Some(id) = steam_id_option(ctx)? {
        return Ok(wilds_key(id, enc_seed, rsa_seed));
    }
    // No id given — recover it from the file itself.
    let (body, plain_len) = container::encrypted_parts(input).map_err(describe)?;
    let id = mandarin::find_steam_id64(body, plain_len, enc_seed).ok_or_else(|| {
        anyhow!(
            "couldn't work out which Steam account this save belongs to. Enter the 17-digit \
             SteamID64 of the account that made it."
        )
    })?;
    Ok(wilds_key(id, enc_seed, rsa_seed))
}

/// The key a PC save must be sealed with: the account that will play it. The
/// player must supply it; there is nothing in a PS5 save to take it from.
fn target_key(ctx: &CodecCtx<'_>, enc_seed: u64, rsa_seed: u64) -> Result<MandarinKey> {
    let id = steam_id_option(ctx)?.ok_or_else(|| {
        anyhow!("enter the 17-digit SteamID64 of the Steam account that will play this save")
    })?;
    Ok(wilds_key(id, enc_seed, rsa_seed))
}

/// The validated Steam id the player entered for this direction, if any.
fn steam_id_option(ctx: &CodecCtx<'_>) -> Result<Option<u64>> {
    match ctx.options.get(STEAM_ID_OPTION) {
        Some(value) => parse_steam_id64(value).map(Some),
        None => Ok(None),
    }
}

/// The Mandarin key for a game keyed on `!SteamID64` (Monster Hunter Wilds).
fn wilds_key(steam_id64: u64, enc_seed: u64, rsa_seed: u64) -> MandarinKey {
    MandarinKey {
        enc_seed,
        rsa_seed,
        key64: !steam_id64,
    }
}

/// Turn a container error into a player-facing message. The `DsssError`
/// `Display` text is already written for players, so it is kept as-is.
fn describe(error: DsssError) -> anyhow::Error {
    anyhow!("{error}")
}

/// Same, for an object-stream error.
fn describe_stream(error: StreamError) -> anyhow::Error {
    anyhow!("{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_seeds_parse() {
        assert_eq!(
            parse_hex_u64("0x7A36955255266CED").unwrap(),
            0x7A36_9552_5526_6CED
        );
        assert_eq!(parse_hex_u64("BFACF76C3F96").unwrap(), 0xBFAC_F76C_3F96);
        assert_eq!(parse_hex_u64("0").unwrap(), 0);
        for bad in [
            "",
            "0x",
            "0xg",
            "12345678901234567",
            "0x12345678901234567",
            " 0x1 2",
        ] {
            assert!(parse_hex_u64(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn params_round_trip_and_reject_unknown_fields() {
        let ok = serde_json::json!({
            "enc_seed": "0x7A36955255266CED",
            "rsa_seed": "0xBFACF76C3F96",
            "reset_identity_fields": ["HunterId", "HunterShortId"]
        });
        let params = Params::parse(&ok).unwrap();
        assert_eq!(params.seeds(), (0x7A36_9552_5526_6CED, 0xBFAC_F76C_3F96));
        assert_eq!(params.reset_identity_fields.len(), 2);

        assert!(Params::parse(&serde_json::json!({ "enc_seed": "0x1" })).is_err());
        assert!(Params::parse(&serde_json::json!({
            "enc_seed": "0x1", "rsa_seed": "0x2", "typo": 1
        }))
        .is_err());
        assert!(Params::parse(&serde_json::json!({
            "enc_seed": "nothex", "rsa_seed": "0x2"
        }))
        .is_err());
    }

    #[test]
    fn the_fresh_identity_is_eight_dashes() {
        let units: Vec<u16> = FRESH_IDENTITY.encode_utf16().collect();
        assert_eq!(units, [0x002d; 8]);
    }
}

/// End-to-end checks against real game-written save files. These run only
/// when `XENO_SAVE_VECTORS` points at the directory that holds them (the
/// files are third-party and not in the repository); otherwise the test
/// prints a note and passes, so the suite stays self-contained.
#[cfg(test)]
mod real_files {
    use super::*;
    use crate::save_convert::codec::Codec;
    use crate::save_convert::db;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    const CHARACTER: &FileMap = &FileMap {
        ps5: String::new(),
        pc: String::new(),
        label: String::new(),
        required: true,
    };

    fn vectors() -> Option<PathBuf> {
        match std::env::var_os("XENO_SAVE_VECTORS") {
            Some(dir) => Some(PathBuf::from(dir)),
            None => {
                eprintln!("skipping: set XENO_SAVE_VECTORS to the sample directory to run");
                None
            }
        }
    }

    fn profile() -> &'static GameProfile {
        db::find_game("monster-hunter-wilds").expect("the Wilds profile loads")
    }

    fn run(direction: Direction, options: &[(&str, &str)], input: &[u8]) -> Converted {
        let options: BTreeMap<String, String> = options
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let ctx = CodecCtx {
            game: profile(),
            direction,
            options: &options,
        };
        ReEngineDsss
            .convert_file(&ctx, CHARACTER, input)
            .expect("conversion succeeds")
    }

    /// The object stream inside a file, for comparing the data two files hold
    /// regardless of platform layout. Normalised to base 16.
    fn stream_at_16(file: &[u8], key: Option<&MandarinKey>) -> Vec<u8> {
        let decoded = container::decode(file, key).expect("decode");
        rebase_with(
            &decoded.stream,
            decoded.stream_base,
            16,
            &mut |_: &StringField<'_>| None,
        )
        .expect("rebase to 16")
    }

    // A real PS5 system-data save (flags 0x08). Has no identity fields.
    #[test]
    fn ps5_system_data_round_trips_through_pc() {
        let Some(root) = vectors() else { return };
        let ps5 = std::fs::read(root.join("samples/ps5/data00-1.bin")).unwrap();

        // Pick any valid account as the PC target.
        let target = "76561198012345678";
        let pc = run(Direction::Ps5ToPc, &[("steam_id64", target)], &ps5).data;

        // The PC output is a real PC save of that account, holding the same data.
        let key = MandarinKey::wilds(target.parse().unwrap());
        assert_eq!(container::peek_flags(&pc).unwrap(), 0x18);
        assert_eq!(stream_at_16(&pc, Some(&key)), stream_at_16(&ps5, None));

        // Back to PS5: a valid PS5 save holding the original data. It is not
        // byte-identical to the game's file — our DEFLATE compressor is not
        // the game's, so the compressed bytes differ — but it decodes to the
        // same object stream, which is what the game reads. Supplying the
        // account id keeps this step fast.
        let back = run(Direction::PcToPs5, &[("steam_id64", target)], &pc).data;
        assert_eq!(container::peek_flags(&back).unwrap(), 0x08);
        assert_eq!(stream_at_16(&back, None), stream_at_16(&ps5, None));
        // Converting an already-converted file is stable.
        let again = run(Direction::Ps5ToPc, &[("steam_id64", target)], &back).data;
        assert_eq!(stream_at_16(&again, Some(&key)), stream_at_16(&ps5, None));
    }

    // The real PC character save (flags 0x18) the player sent. The active
    // hunter's online id is a GUID; a transfer must reset it.
    #[test]
    fn pc_character_data_converts_to_ps5_and_resets_identity() {
        let Some(root) = vectors() else { return };
        let pc =
            std::fs::read(root.join("samples/pc_wilds/2246340/remote/win64_save/data001Slot.bin"))
                .unwrap();

        // The account is found from the file, no id supplied.
        let converted = run(Direction::PcToPs5, &[], &pc);
        let ps5 = &converted.data;
        assert_eq!(container::peek_flags(ps5).unwrap(), 0x08);
        assert!(
            converted
                .warnings
                .iter()
                .any(|w| w.contains("online hunter identity")),
            "a transfer should warn that the identity was reset: {:?}",
            converted.warnings
        );

        // Every HunterId/HunterShortId in the PS5 output is the fresh value.
        let hashes = [name_hash("HunterId"), name_hash("HunterShortId")];
        let fresh: Vec<u8> = FRESH_IDENTITY
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let mut checked = 0;
        rebase_with(
            &container::decode(ps5, None).unwrap().stream,
            12,
            12,
            &mut |f: &StringField<'_>| {
                if hashes.contains(&f.name_hash) {
                    assert_eq!(f.units, fresh.as_slice(), "identity field not reset");
                    checked += 1;
                }
                None
            },
        )
        .unwrap();
        assert!(checked >= 2, "expected the hunter id fields to be present");

        // Apart from the identity, the data is unchanged: forcing the same
        // reset on the original PC stream gives the PS5 output's stream.
        let want = {
            let decoded = container::decode(&pc, Some(&source_key_for_test(&root))).unwrap();
            rebase_with(&decoded.stream, 16, 16, &mut |f: &StringField<'_>| {
                hashes.contains(&f.name_hash).then(|| fresh.clone())
            })
            .unwrap()
        };
        assert_eq!(stream_at_16(ps5, None), want);
    }

    fn source_key_for_test(root: &std::path::Path) -> MandarinKey {
        // Recover the account the sample belongs to, the same way the codec
        // does, so the test needs no hard-coded id.
        let pc =
            std::fs::read(root.join("samples/pc_wilds/2246340/remote/win64_save/data001Slot.bin"))
                .unwrap();
        let (body, len) = container::encrypted_parts(&pc).unwrap();
        let id =
            mandarin::find_steam_id64(body, len, 0x7A36_9552_5526_6CED).expect("account found");
        MandarinKey::wilds(id)
    }
}
