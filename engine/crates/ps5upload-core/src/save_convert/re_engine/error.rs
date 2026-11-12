//! The error type shared by the container and the Mandarin layer.
//!
//! `Display` is written for the person holding the save file, not for the
//! programmer: every message says what is wrong and what to try next.

use std::fmt;

/// Everything that can go wrong while reading or writing a DSSS save.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DsssError {
    /// The file does not start with the `DSSS` marker.
    NotDsss,
    /// The container version is not 2.
    UnsupportedVersion(u32),
    /// A flag combination other than Deflate (`0x08`) and/or Mandarin (`0x10`).
    UnsupportedFlags(u32),
    /// The file is Mandarin-encrypted but no key was supplied.
    KeyRequired,
    /// The first block header does not decode with this key: the save belongs
    /// to a different account.
    WrongKey,
    /// A checksum, the CityHash of a block, the compressed data or the file
    /// structure is wrong. The text says which check failed.
    Corrupt(String),
    /// The file or its contents exceed the size limits.
    TooLarge,
}

impl DsssError {
    /// Shorthand used throughout the crate.
    pub(crate) fn corrupt(what: impl Into<String>) -> Self {
        DsssError::Corrupt(what.into())
    }
}

impl fmt::Display for DsssError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DsssError::NotDsss => f.write_str(
                "This is not a game save file (it does not start with the \"DSSS\" marker). \
                 Choose the save file itself, for example data001Slot.bin.",
            ),
            DsssError::UnsupportedVersion(version) => write!(
                f,
                "This save uses format version {version}, but only version 2 is supported. \
                 The game may have changed its save format; check for an update of this tool."
            ),
            DsssError::UnsupportedFlags(flags) => write!(
                f,
                "This save is stored in a way this tool cannot read or write (storage flags \
                 0x{flags:02X}). Only Monster Hunter Wilds saves from PC (Steam) and PS5 are \
                 supported; make sure the file comes from that game."
            ),
            DsssError::KeyRequired => f.write_str(
                "This save is locked to a Steam account. Enter the 17-digit Steam ID of the \
                 account the save belongs to and try again.",
            ),
            DsssError::WrongKey => f.write_str(
                "This save belongs to a different Steam account than the one entered. Check \
                 the 17-digit Steam ID: it must be the account that created the save.",
            ),
            DsssError::Corrupt(what) => write!(
                f,
                "The save file is damaged or incomplete: {what}. Copy the file again from its \
                 original location, or use a backup."
            ),
            DsssError::TooLarge => f.write_str(
                "The save is far larger than any real save (the limit is 256 MiB of save \
                 data), so it was not processed. Make sure the right file was chosen.",
            ),
        }
    }
}

impl std::error::Error for DsssError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_plain_sentences() {
        let all = [
            DsssError::NotDsss,
            DsssError::UnsupportedVersion(3),
            DsssError::UnsupportedFlags(0x1C),
            DsssError::KeyRequired,
            DsssError::WrongKey,
            DsssError::corrupt("the checksum at the end of the file does not match"),
            DsssError::TooLarge,
        ];
        for error in all {
            let text = error.to_string();
            assert!(text.ends_with('.'), "{text}");
            assert!(text.len() > 40, "{text}");
            assert!(!text.contains("Err("), "{text}");
            assert!(!text.contains("unwrap"), "{text}");
            assert!(!text.contains("  "), "double space in: {text}");
        }
        assert!(DsssError::UnsupportedVersion(3).to_string().contains('3'));
        assert!(DsssError::UnsupportedFlags(0x1C)
            .to_string()
            .contains("0x1C"));
        assert!(DsssError::corrupt("xyz").to_string().contains("xyz"));
    }

    #[test]
    fn is_a_std_error() {
        fn assert_error<E: std::error::Error + Send + Sync + 'static>(_: &E) {}
        assert_error(&DsssError::WrongKey);
    }
}
