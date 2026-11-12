//! The Save Converter game database.
//!
//! One JSON file per game lives in `games/` next to this file and is
//! embedded at compile time, so the database ships inside the app and
//! works offline. A profile is *data only*: names, IDs, where the save
//! lives on each platform, which file maps to which, and the id of the
//! codec that rewrites the bytes. Anything that needs real logic (crypto,
//! checksums, container formats) lives in a codec — see `codec.rs`.
//!
//! Every profile is validated on first load and by the unit tests below,
//! so a typo in a game file fails `cargo test` rather than a user's
//! conversion. The full field reference is in `docs/save-converter.md`.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::{codec, pattern};

/// Embedded game files: `(file stem, contents)`. The stem must equal the
/// profile's `id`. A unit test asserts that every `games/*.json` on disk is
/// listed here, so a new game can't be added and silently left out.
const GAME_FILES: &[(&str, &str)] = &[(
    "monster-hunter-wilds",
    include_str!("games/monster-hunter-wilds.json"),
)];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Ps5ToPc,
    PcToPs5,
}

impl Direction {
    /// Short platform name of the side being read.
    pub fn source_name(self) -> &'static str {
        match self {
            Direction::Ps5ToPc => "PS5",
            Direction::PcToPs5 => "PC",
        }
    }

    /// Short platform name of the side being written.
    pub fn target_name(self) -> &'static str {
        match self {
            Direction::Ps5ToPc => "PC",
            Direction::PcToPs5 => "PS5",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Verified both ways against real saves.
    Ready,
    /// Converts, but not yet confirmed in-game in both directions.
    Experimental,
    /// Listed so users can see it's coming; conversion is refused.
    Wip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GameProfile {
    /// Stable slug — lowercase letters, digits and single dashes. Also the
    /// file name (`games/<id>.json`) and the output folder prefix.
    pub id: String,
    pub name: String,
    pub status: Status,
    /// Extra search terms ("MHWilds", "MH Wilds").
    #[serde(default)]
    pub aliases: Vec<String>,
    pub ps5: Ps5Info,
    pub pc: PcInfo,
    pub files: Vec<FileMap>,
    /// Id of the codec in `codec.rs` that rewrites each file.
    pub codec: String,
    /// Codec-specific settings; checked by the codec's `validate_params`.
    #[serde(default)]
    pub codec_params: serde_json::Value,
    /// Values the user has to supply (e.g. their SteamID64).
    #[serde(default)]
    pub options: Vec<OptionSpec>,
    /// Things worth knowing before converting.
    #[serde(default)]
    pub notes: Vec<String>,
    /// What to do with the converted files, per direction.
    #[serde(default)]
    pub next_steps: NextSteps,
    /// Research and tools the profile/codec was built from.
    #[serde(default)]
    pub credits: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ps5Info {
    /// Every regional title ID this profile covers (`PPSA…`, or `CUSA…`
    /// for a PS4 version running on PS5).
    #[serde(default)]
    pub title_ids: Vec<String>,
    /// Where the files sit inside the decrypted save, in plain words.
    #[serde(default)]
    pub save_hint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PcInfo {
    #[serde(default)]
    pub steam_app_id: Option<u32>,
    /// Where the save folder lives on PC, shown verbatim to the user.
    #[serde(default)]
    pub save_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileMap {
    /// Path inside the decrypted PS5 save (see `pattern.rs` for syntax).
    pub ps5: String,
    /// Path inside the PC save folder.
    pub pc: String,
    /// What the file is ("System data", "Character slot").
    #[serde(default)]
    pub label: String,
    /// A required file that's absent blocks the conversion.
    #[serde(default = "default_true")]
    pub required: bool,
}

impl FileMap {
    pub fn source(&self, direction: Direction) -> &str {
        match direction {
            Direction::Ps5ToPc => &self.ps5,
            Direction::PcToPs5 => &self.pc,
        }
    }

    pub fn dest(&self, direction: Direction) -> &str {
        match direction {
            Direction::Ps5ToPc => &self.pc,
            Direction::PcToPs5 => &self.ps5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OptionKind {
    /// 17-digit Steam account id (`7656119…`).
    SteamId64,
    Text,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OptionSpec {
    /// Name the codec looks the value up by.
    pub key: String,
    pub label: String,
    pub kind: OptionKind,
    #[serde(default)]
    pub help: String,
    /// Directions that use this option. Empty means both.
    #[serde(default)]
    pub directions: Vec<Direction>,
    #[serde(default = "default_true")]
    pub required: bool,
}

impl OptionSpec {
    pub fn applies_to(&self, direction: Direction) -> bool {
        self.directions.is_empty() || self.directions.contains(&direction)
    }

    /// Check a (non-empty, trimmed) value the user typed for this option.
    pub fn check(&self, value: &str) -> Result<()> {
        match self.kind {
            OptionKind::SteamId64 => parse_steam_id64(value).map(|_| ()),
            OptionKind::Text => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NextSteps {
    #[serde(default)]
    pub ps5_to_pc: Vec<String>,
    #[serde(default)]
    pub pc_to_ps5: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// First and last SteamID64 of the "individual account, public universe"
/// range: `0x0110_0001_0000_0000 + account_id` for a 32-bit account id.
const STEAM_ID64_BASE: u64 = 0x0110_0001_0000_0000;

/// Parse a SteamID64 as shown on a Steam profile (17 digits). Rejects
/// anything outside the individual-account range, which catches the two
/// usual mistakes: pasting the short SteamID3/account id from the
/// `userdata` folder name, or a profile URL.
pub fn parse_steam_id64(value: &str) -> Result<u64> {
    let value = value.trim();
    if value.len() != 17 || !value.bytes().all(|b| b.is_ascii_digit()) {
        bail!("a SteamID64 is exactly 17 digits (it starts with 7656119…)");
    }
    let id: u64 = value.parse().context("not a valid SteamID64")?;
    if id <= STEAM_ID64_BASE || id > STEAM_ID64_BASE + u64::from(u32::MAX) {
        bail!("that number isn't a Steam account id (a SteamID64 starts with 7656119…)");
    }
    Ok(id)
}

impl GameProfile {
    /// Structural validation — everything that can be checked without a
    /// save in hand.
    pub fn validate(&self) -> Result<()> {
        if !is_slug(&self.id) {
            bail!(
                "id {:?} must be lowercase letters/digits separated by single dashes",
                self.id
            );
        }
        if self.name.trim().is_empty() {
            bail!("name is empty");
        }
        for title_id in &self.ps5.title_ids {
            if !is_title_id(title_id) {
                bail!("{title_id:?} isn't a PS5/PS4 title id (PPSA12345 / CUSA12345)");
            }
        }
        if has_duplicates(self.ps5.title_ids.iter().map(String::as_str)) {
            bail!("ps5.title_ids lists the same id twice");
        }

        if self.files.is_empty() {
            bail!("files is empty — a profile must map at least one file");
        }
        for file in &self.files {
            pattern::validate(&file.ps5).context("files[].ps5")?;
            pattern::validate(&file.pc).context("files[].pc")?;
            if pattern::has_wildcard(&file.ps5) != pattern::has_wildcard(&file.pc) {
                bail!(
                    "{:?} <-> {:?}: use '*' on both sides or neither",
                    file.ps5,
                    file.pc
                );
            }
        }
        if has_duplicates(self.files.iter().map(|f| f.ps5.as_str())) {
            bail!("two files[] entries share the same ps5 path");
        }
        if has_duplicates(self.files.iter().map(|f| f.pc.as_str())) {
            bail!("two files[] entries share the same pc path");
        }

        let codec =
            codec::by_id(&self.codec).ok_or_else(|| anyhow!("unknown codec {:?}", self.codec))?;
        codec
            .validate_params(&self.codec_params)
            .with_context(|| format!("codec_params for {:?}", self.codec))?;

        for option in &self.options {
            let key_ok = !option.key.is_empty()
                && option
                    .key
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
            if !key_ok {
                bail!("option key {:?} must be snake_case", option.key);
            }
            if option.label.trim().is_empty() {
                bail!("option {:?} has no label", option.key);
            }
        }
        // A key may be declared once per direction, so the same value can be
        // asked for with different wording each way ("the account that will
        // load the save" vs "the account that made it"). Within a direction
        // it must be unique, or the codec couldn't tell the values apart.
        for direction in [Direction::Ps5ToPc, Direction::PcToPs5] {
            let keys = self
                .options
                .iter()
                .filter(|o| o.applies_to(direction))
                .map(|o| o.key.as_str());
            if has_duplicates(keys) {
                bail!("two options that apply to the same direction share a key");
            }
        }
        Ok(())
    }
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn is_title_id(s: &str) -> bool {
    s.len() == 9
        && (s.starts_with("PPSA") || s.starts_with("CUSA"))
        && s[4..].bytes().all(|b| b.is_ascii_digit())
}

/// ASCII case-insensitive duplicate check (file names and ids are matched
/// case-insensitively, so `A.bin` and `a.bin` collide).
fn has_duplicates<'a>(items: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = BTreeSet::new();
    for item in items {
        if !seen.insert(item.to_ascii_lowercase()) {
            return true;
        }
    }
    false
}

fn load() -> Result<Vec<GameProfile>> {
    let mut games = Vec::with_capacity(GAME_FILES.len());
    for (stem, text) in GAME_FILES {
        let file = format!("games/{stem}.json");
        let game: GameProfile = serde_json::from_str(text).with_context(|| file.clone())?;
        if game.id != *stem {
            bail!("{file}: id {:?} must match the file name", game.id);
        }
        game.validate().with_context(|| file.clone())?;
        games.push(game);
    }
    if has_duplicates(games.iter().map(|g| g.id.as_str())) {
        bail!("the same game file is registered twice");
    }
    games.sort_by_key(|g| g.name.to_lowercase());
    Ok(games)
}

/// Every game in the database, sorted by name.
pub fn games() -> Result<&'static [GameProfile]> {
    static DB: OnceLock<Result<Vec<GameProfile>, String>> = OnceLock::new();
    match DB.get_or_init(|| load().map_err(|e| format!("{e:#}"))) {
        Ok(games) => Ok(games.as_slice()),
        Err(e) => Err(anyhow!("save converter database is invalid: {e}")),
    }
}

pub fn find_game(id: &str) -> Result<&'static GameProfile> {
    games()?
        .iter()
        .find(|g| g.id == id)
        .ok_or_else(|| anyhow!("no game with id {id:?} in the save converter database"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(patch: impl FnOnce(&mut serde_json::Value)) -> Result<GameProfile> {
        let mut value = json!({
            "id": "test-game",
            "name": "Test Game",
            "status": "ready",
            "ps5": { "title_ids": ["PPSA00001"] },
            "pc": { "steam_app_id": 1 },
            "files": [
                { "ps5": "SYSTEM.DAT", "pc": "system.sav" },
                { "ps5": "SLOT*.DAT", "pc": "slot_*.sav", "required": false }
            ],
            "codec": "passthrough"
        });
        patch(&mut value);
        let game: GameProfile = serde_json::from_value(value)?;
        game.validate()?;
        Ok(game)
    }

    #[test]
    fn embedded_database_loads_and_validates() {
        let games = games().expect("embedded game database must be valid");
        assert_eq!(games.len(), GAME_FILES.len());
        for game in games {
            assert_eq!(find_game(&game.id).unwrap().id, game.id);
        }
        assert!(find_game("no-such-game").is_err());
    }

    /// A game file dropped into `games/` but not added to `GAME_FILES`
    /// would compile fine and simply never appear in the app.
    #[test]
    fn every_game_file_on_disk_is_registered() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/save_convert/games");
        let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .map(|p| p.file_stem().unwrap().to_string_lossy().into_owned())
            .collect();
        on_disk.sort();
        let mut registered: Vec<String> = GAME_FILES.iter().map(|(s, _)| s.to_string()).collect();
        registered.sort();
        assert_eq!(
            on_disk, registered,
            "games/*.json and GAME_FILES in db.rs are out of sync"
        );
    }

    /// The profile example in docs/save-converter.md is what people copy
    /// when adding a game — keep it loadable.
    #[test]
    fn the_documented_example_profile_is_valid() {
        let doc = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/save-converter.md");
        let text = std::fs::read_to_string(&doc).unwrap();
        let start = text.find("```json\n").expect("docs have a json example") + "```json\n".len();
        let end = start + text[start..].find("```").unwrap();
        let game: GameProfile = serde_json::from_str(&text[start..end]).unwrap();
        game.validate().unwrap();
        assert_eq!(game.id, "example-game");
    }

    #[test]
    fn a_well_formed_profile_validates() {
        profile(|_| {}).unwrap();
    }

    #[test]
    fn validation_rejects_malformed_profiles() {
        type Patch = Box<dyn FnOnce(&mut serde_json::Value)>;
        let cases: Vec<(&str, Patch)> = vec![
            ("bad slug", Box::new(|v| v["id"] = json!("Test Game"))),
            ("empty name", Box::new(|v| v["name"] = json!("  "))),
            (
                "bad title id",
                Box::new(|v| v["ps5"]["title_ids"] = json!(["PPSA1234"])),
            ),
            ("no files", Box::new(|v| v["files"] = json!([]))),
            (
                "wildcard on one side only",
                Box::new(|v| v["files"][1]["pc"] = json!("slot.sav")),
            ),
            (
                "path escape",
                Box::new(|v| v["files"][0]["pc"] = json!("../system.sav")),
            ),
            (
                "duplicate destination",
                Box::new(|v| v["files"][0]["pc"] = json!("SLOT_*.SAV")),
            ),
            ("unknown codec", Box::new(|v| v["codec"] = json!("nope"))),
            (
                "passthrough takes no params",
                Box::new(|v| v["codec_params"] = json!({ "key": 1 })),
            ),
            (
                "bad option key",
                Box::new(|v| {
                    v["options"] = json!([{ "key": "Steam ID", "label": "x", "kind": "text" }])
                }),
            ),
            (
                "same option key twice in one direction",
                Box::new(|v| {
                    v["options"] = json!([
                        { "key": "steam_id64", "label": "a", "kind": "steam_id64" },
                        { "key": "steam_id64", "label": "b", "kind": "steam_id64", "directions": ["pc_to_ps5"] }
                    ])
                }),
            ),
            ("unknown field", Box::new(|v| v["codek"] = json!("typo"))),
        ];
        for (what, patch) in cases {
            assert!(profile(patch).is_err(), "should be rejected: {what}");
        }
    }

    #[test]
    fn an_option_key_may_be_declared_once_per_direction() {
        let game = profile(|v| {
            v["options"] = json!([
                { "key": "steam_id64", "label": "Account that will load it", "kind": "steam_id64", "directions": ["ps5_to_pc"] },
                { "key": "steam_id64", "label": "Account that made it", "kind": "steam_id64", "directions": ["pc_to_ps5"] }
            ])
        })
        .unwrap();
        let labels = |direction| -> Vec<&str> {
            game.options
                .iter()
                .filter(|o| o.applies_to(direction))
                .map(|o| o.label.as_str())
                .collect()
        };
        assert_eq!(labels(Direction::Ps5ToPc), ["Account that will load it"]);
        assert_eq!(labels(Direction::PcToPs5), ["Account that made it"]);
    }

    #[test]
    fn steam_id64_parsing() {
        assert_eq!(
            parse_steam_id64(" 76561198000000000 ").unwrap(),
            76561198000000000
        );
        // First and last ids of the individual-account range.
        assert!(parse_steam_id64("76561197960265729").is_ok());
        assert!(parse_steam_id64("76561202255233023").is_ok());
        for bad in [
            "",
            "76561202255233024",  // one past the last account id
            "12345678",           // SteamID3 / account id
            "7656119800000000",   // 16 digits
            "765611980000000000", // 18 digits
            "7656119800000000a",  // not a number
            "76561197960265728",  // account id 0
            "99999999999999999",  // out of range
            "https://steamcommunity.com/profiles/76561198000000000",
        ] {
            assert!(parse_steam_id64(bad).is_err(), "{bad:?} should be rejected");
        }
    }
}
