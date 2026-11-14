//! Save codecs — the byte-level transforms behind each game profile.
//!
//! A codec is written per save *format*, not per game: most games built on
//! the same engine share one container/encryption scheme, so a single
//! codec plus a few `codec_params` in the game file covers all of them.
//! Profiles refer to codecs by id.
//!
//! Codecs are pure functions over bytes: they get the whole source file in
//! memory (saves are small) and return the whole converted file. All file
//! system work stays in `convert.rs`, which keeps every codec trivially
//! unit-testable against captured samples.

use std::collections::BTreeMap;

use anyhow::{bail, Result};

use super::db::{Direction, FileMap, GameProfile};

/// Everything a codec may consult besides the bytes themselves.
pub struct CodecCtx<'a> {
    pub game: &'a GameProfile,
    pub direction: Direction,
    /// Validated user-supplied values for this direction, keyed by
    /// `OptionSpec::key`. Options the user left blank are absent.
    pub options: &'a BTreeMap<String, String>,
}

/// One converted file plus anything the user should be told about it.
pub struct Converted {
    pub data: Vec<u8>,
    pub warnings: Vec<String>,
}

impl Converted {
    pub fn clean(data: Vec<u8>) -> Self {
        Self {
            data,
            warnings: Vec::new(),
        }
    }
}

pub trait Codec: Sync {
    /// The id game profiles use in their `codec` field.
    fn id(&self) -> &'static str;

    /// Check a profile's `codec_params` when the database loads, so a bad
    /// game file is caught by the tests instead of mid-conversion.
    fn validate_params(&self, params: &serde_json::Value) -> Result<()>;

    /// Rewrite one file for the other platform. `file` is the profile
    /// entry the source file matched.
    fn convert_file(&self, ctx: &CodecCtx<'_>, file: &FileMap, input: &[u8]) -> Result<Converted>;

    /// Whether `check_source` should be shown each source file during the
    /// folder preview. Off by default, in which case the preview never
    /// reads file contents at all.
    fn checks_sources(&self) -> bool {
        false
    }

    /// An early look at one source file, so a problem the bytes alone
    /// reveal — "this is a PC save, not a PS5 one", "this file is damaged"
    /// — shows up in the preview instead of after the user has filled in
    /// the rest of the form. It runs before any option is known, so it
    /// can't judge anything that needs one (e.g. whether an account id
    /// matches). `Err` carries a plain-language reason.
    fn check_source(
        &self,
        _game: &GameProfile,
        _direction: Direction,
        _file: &FileMap,
        _input: &[u8],
    ) -> Result<()> {
        Ok(())
    }
}

/// Every codec the app knows. Add new ones here.
static CODECS: &[&dyn Codec] = &[
    &Passthrough,
    &super::re_engine::ReEngineDsss,
    #[cfg(test)]
    &test_codecs::Reverse,
];

pub fn by_id(id: &str) -> Option<&'static dyn Codec> {
    CODECS.iter().copied().find(|codec| codec.id() == id)
}

/// For games whose save bytes are identical on both platforms and only the
/// file names/locations differ. The profile's file map does all the work.
struct Passthrough;

impl Codec for Passthrough {
    fn id(&self) -> &'static str {
        "passthrough"
    }

    fn validate_params(&self, params: &serde_json::Value) -> Result<()> {
        let empty = params.is_null() || params.as_object().is_some_and(|o| o.is_empty());
        if !empty {
            bail!("the passthrough codec takes no parameters");
        }
        Ok(())
    }

    fn convert_file(&self, _: &CodecCtx<'_>, _: &FileMap, input: &[u8]) -> Result<Converted> {
        Ok(Converted::clean(input.to_vec()))
    }
}

#[cfg(test)]
mod test_codecs {
    use super::*;

    /// Test-only codec: reverses the bytes (so tests can tell the codec
    /// really ran), fails on a file whose content is `FAIL`, panics on
    /// `PANIC`, warns on an empty file, and its source check refuses
    /// content starting `WRONG`.
    pub(super) struct Reverse;

    impl Codec for Reverse {
        fn id(&self) -> &'static str {
            "test-reverse"
        }

        fn validate_params(&self, _: &serde_json::Value) -> Result<()> {
            Ok(())
        }

        fn convert_file(&self, _: &CodecCtx<'_>, _: &FileMap, input: &[u8]) -> Result<Converted> {
            if input == b"FAIL" {
                bail!("this save is corrupt");
            }
            assert!(input != b"PANIC", "test codec asked to panic");
            let mut out = Converted::clean(input.iter().rev().copied().collect());
            if input.is_empty() {
                out.warnings.push("file is empty".into());
            }
            Ok(out)
        }

        fn checks_sources(&self) -> bool {
            true
        }

        fn check_source(
            &self,
            _: &GameProfile,
            direction: Direction,
            _: &FileMap,
            input: &[u8],
        ) -> Result<()> {
            if input.starts_with(b"WRONG") {
                bail!("this isn't a {} save", direction.source_name());
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_are_unique_and_resolvable() {
        let mut ids: Vec<&str> = CODECS.iter().map(|c| c.id()).collect();
        for id in &ids {
            assert_eq!(by_id(id).unwrap().id(), *id);
        }
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "two codecs share an id");
        assert!(by_id("no-such-codec").is_none());
    }
}
