//! File-name patterns used by game profiles.
//!
//! A pattern is a save-relative path with `/` separators and at most one
//! `*`. The `*` stands for one or more characters inside a single path
//! segment (it never crosses a `/`), which is all a profile needs to say
//! "every character slot": `data00*Slot.bin`. Whatever the `*` captured on
//! the source side is substituted into the destination pattern.
//!
//! Matching is ASCII case-insensitive: PC saves live on case-insensitive
//! file systems and get renamed by hand, so `DATA000.BIN` must still be
//! recognised. The captured text keeps its original case.

use anyhow::{bail, Result};

/// Reject anything that isn't a plain relative path. Profiles are bundled
/// with the app rather than user-supplied, but a typo here would otherwise
/// turn into a write outside the output folder, so the check is strict.
pub(crate) fn validate(pattern: &str) -> Result<()> {
    if pattern.is_empty() {
        bail!("empty file pattern");
    }
    if pattern.contains('\\') {
        bail!("file pattern {pattern:?} must use '/' separators");
    }
    if pattern.starts_with('/') || pattern.contains(':') {
        bail!("file pattern {pattern:?} must be a relative path");
    }
    for segment in pattern.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            bail!("file pattern {pattern:?} has an invalid path segment");
        }
    }
    if pattern.matches('*').count() > 1 {
        bail!("file pattern {pattern:?} may contain at most one '*'");
    }
    Ok(())
}

pub(crate) fn has_wildcard(pattern: &str) -> bool {
    pattern.contains('*')
}

/// Match `name` against `pattern`. Returns the text the `*` captured, or an
/// empty string when the pattern has no wildcard. `None` means no match.
pub(crate) fn capture(pattern: &str, name: &str) -> Option<String> {
    let Some(star) = pattern.find('*') else {
        return pattern.eq_ignore_ascii_case(name).then(String::new);
    };
    let prefix = &pattern[..star];
    let suffix = &pattern[star + 1..];
    // `+ 1`: the wildcard must capture at least one character, so
    // `data00*Slot.bin` doesn't also swallow a bare `data00Slot.bin`.
    if name.len() < prefix.len() + suffix.len() + 1 {
        return None;
    }
    // `get` (not slicing) so a non-ASCII name whose byte offsets fall
    // inside a multi-byte character is a clean non-match, not a panic.
    let head = name.get(..prefix.len())?;
    let tail = name.get(name.len() - suffix.len()..)?;
    let middle = name.get(prefix.len()..name.len() - suffix.len())?;
    if !head.eq_ignore_ascii_case(prefix) || !tail.eq_ignore_ascii_case(suffix) {
        return None;
    }
    if middle.contains('/') {
        return None;
    }
    Some(middle.to_string())
}

/// How two patterns of one profile relate, for the checks that keep a
/// profile unambiguous.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Clash {
    /// No path can involve both.
    None,
    /// Some file name matches both patterns.
    SameFile,
    /// One pattern's file is a folder on the other pattern's path.
    FileAndFolder,
}

/// Compare two (already validated) patterns.
pub(crate) fn clash(a: &str, b: &str) -> Clash {
    let (a, b): (Vec<&str>, Vec<&str>) = (a.split('/').collect(), b.split('/').collect());
    let shared = a.len().min(b.len());
    if !a[..shared]
        .iter()
        .zip(&b[..shared])
        .all(|(x, y)| segments_overlap(x, y))
    {
        return Clash::None;
    }
    if a.len() == b.len() {
        Clash::SameFile
    } else {
        Clash::FileAndFolder
    }
}

/// True when some single path segment matches both `x` and `y`.
fn segments_overlap(x: &str, y: &str) -> bool {
    match (x.find('*'), y.find('*')) {
        (None, None) => x.eq_ignore_ascii_case(y),
        (Some(_), None) => capture(x, y).is_some(),
        (None, Some(_)) => capture(y, x).is_some(),
        (Some(i), Some(j)) => {
            // Both wildcards: a common match exists exactly when one
            // prefix continues the other and one suffix continues the
            // other (the `*`s soak up the difference).
            let (x_head, x_tail) = (&x[..i], &x[i + 1..]);
            let (y_head, y_tail) = (&y[..j], &y[j + 1..]);
            let heads =
                starts_with_ignore_case(x_head, y_head) || starts_with_ignore_case(y_head, x_head);
            let tails =
                ends_with_ignore_case(x_tail, y_tail) || ends_with_ignore_case(y_tail, x_tail);
            heads && tails
        }
    }
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn ends_with_ignore_case(text: &str, suffix: &str) -> bool {
    text.len() >= suffix.len()
        && text
            .get(text.len() - suffix.len()..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
}

/// Substitute `captured` for the `*` in `pattern` (no-op without one).
pub(crate) fn fill(pattern: &str, captured: &str) -> String {
    pattern.replacen('*', captured, 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_patterns_match_case_insensitively() {
        assert_eq!(capture("data000.bin", "data000.bin"), Some(String::new()));
        assert_eq!(capture("data000.bin", "DATA000.BIN"), Some(String::new()));
        assert_eq!(capture("data000.bin", "data001.bin"), None);
        assert_eq!(capture("data000.bin", "xdata000.bin"), None);
    }

    #[test]
    fn wildcard_captures_one_segment_and_keeps_case() {
        assert_eq!(
            capture("data00*Slot.bin", "data001Slot.bin"),
            Some("1".to_string())
        );
        assert_eq!(
            capture("save/*.sav", "SAVE/Hunter.sav"),
            Some("Hunter".to_string())
        );
        // Needs at least one character.
        assert_eq!(capture("data00*Slot.bin", "data00Slot.bin"), None);
        // Never crosses a directory boundary.
        assert_eq!(capture("save/*.sav", "save/a/b.sav"), None);
    }

    #[test]
    fn non_ascii_names_never_panic() {
        assert_eq!(capture("ab*cd", "é"), None);
        assert_eq!(capture("*.sav", "héros.sav"), Some("héros".to_string()));
        assert_eq!(capture("data.bin", "dàta.bin"), None);
    }

    #[test]
    fn clash_detects_patterns_that_can_collide() {
        // Same file name reachable through both patterns.
        for (a, b) in [
            ("S*.DAT", "SLOT*.DAT"),
            ("slot_*.sav", "SLOT_*.SAV"),
            ("*.bin", "data*"),
            ("save/*.sav", "save/slot*.sav"),
            ("SYSTEM.DAT", "S*.DAT"),
            ("a.bin", "A.BIN"),
        ] {
            assert_eq!(clash(a, b), Clash::SameFile, "{a} vs {b}");
            assert_eq!(clash(b, a), Clash::SameFile, "{b} vs {a}");
        }
        // One pattern's file is the other's folder.
        for (a, b) in [("data", "data/slot_*.sav"), ("slot_*", "slot_1/data.bin")] {
            assert_eq!(clash(a, b), Clash::FileAndFolder, "{a} vs {b}");
            assert_eq!(clash(b, a), Clash::FileAndFolder, "{b} vs {a}");
        }
        // Unrelated.
        for (a, b) in [
            ("SYSTEM.DAT", "SLOT*.DAT"),
            ("slot_*.sav", "slot_*.bak"),
            ("a/x.bin", "b/x.bin"),
            ("data*.bin", "save*.bin"),
            ("data", "database/x.bin"),
            ("data00*Slot.bin", "data00-1.bin"),
        ] {
            assert_eq!(clash(a, b), Clash::None, "{a} vs {b}");
            assert_eq!(clash(b, a), Clash::None, "{b} vs {a}");
        }
    }

    #[test]
    fn fill_substitutes_the_capture() {
        assert_eq!(fill("slot_*.dat", "3"), "slot_3.dat");
        assert_eq!(fill("system.dat", "ignored"), "system.dat");
    }

    #[test]
    fn validate_rejects_escapes_and_malformed_paths() {
        for bad in [
            "",
            "/abs.bin",
            "..",
            "../up.bin",
            "a/../b.bin",
            "a//b.bin",
            "a\\b.bin",
            "C:/x.bin",
            "a*b*c",
            "dir/",
        ] {
            assert!(validate(bad).is_err(), "{bad:?} should be rejected");
        }
        for good in ["data000.bin", "save/slot_*.sav", "a/b/c.bin"] {
            assert!(validate(good).is_ok(), "{good:?} should be accepted");
        }
    }
}
