//! Save conversion orchestration: find the save, plan it, run the codec,
//! write the result.
//!
//! Guarantees the rest of the app (and the user) can rely on:
//!
//!   * The input is opened read-only and never modified.
//!   * Output always goes into a brand-new folder created inside the
//!     folder the user picked — nothing that already exists is touched.
//!   * A conversion either fully succeeds or leaves nothing behind; a
//!     failure part-way through removes the new folder.
//!   * `inspect` and `convert` share one planning step, so what the
//!     preview shows is exactly what gets converted.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::codec::{self, CodecCtx};
use super::db::{self, Direction, GameProfile, Status};
use super::pattern;

/// How far below the picked folder we look for the save. Deep enough for
/// "I picked the export folder / the Steam `remote` folder", shallow
/// enough that pointing at a drive root fails fast.
const MAX_SCAN_DEPTH: usize = 6;
/// Stop scanning after this many directory entries — a real save folder
/// has a handful of files, so hitting this means the wrong folder.
const MAX_SCAN_ENTRIES: usize = 20_000;
/// Codecs work on whole files in memory; no real save is anywhere near
/// this, so a larger file is the wrong file.
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Cap on how many not-part-of-the-save file names a report carries.
const MAX_IGNORED_LISTED: usize = 50;

#[derive(Debug, Clone, Deserialize)]
pub struct InspectRequest {
    pub game_id: String,
    pub direction: Direction,
    pub input_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvertRequest {
    pub game_id: String,
    pub direction: Direction,
    pub input_dir: String,
    /// An existing (or creatable) folder; the converted save is written
    /// to a new subfolder of it.
    pub output_dir: String,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlannedFile {
    pub label: String,
    /// Path relative to `save_root`, `/`-separated.
    pub source: String,
    /// Path relative to the output folder, `/`-separated.
    pub dest: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MissingFile {
    pub label: String,
    pub pattern: String,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InspectReport {
    pub game_id: String,
    pub direction: Direction,
    /// The folder the save was actually found in: the picked folder, or
    /// the subfolder of it that holds the save files.
    pub save_root: String,
    pub files: Vec<PlannedFile>,
    pub missing: Vec<MissingFile>,
    /// Files under `save_root` that aren't part of this game's save
    /// (first few only — see `ignored_total`).
    pub ignored: Vec<String>,
    pub ignored_total: usize,
    pub convertible: bool,
    /// Why it can't be converted, in plain words. Empty when convertible.
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvertedFile {
    pub label: String,
    pub source: String,
    pub dest: String,
    pub in_size: u64,
    pub out_size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvertReport {
    pub game_id: String,
    pub direction: Direction,
    pub save_root: String,
    /// The new folder holding the converted save.
    pub output_dir: String,
    pub files: Vec<ConvertedFile>,
    pub ignored_total: usize,
    pub warnings: Vec<String>,
}

/// Preview a conversion without writing anything.
pub fn inspect(req: &InspectRequest) -> Result<InspectReport> {
    let game = db::find_game(&req.game_id)?;
    inspect_with(game, req.direction, Path::new(&req.input_dir))
}

/// Convert a save. See the module docs for the guarantees.
pub fn convert(req: &ConvertRequest) -> Result<ConvertReport> {
    let game = db::find_game(&req.game_id)?;
    convert_with(game, req)
}

fn inspect_with(
    game: &GameProfile,
    direction: Direction,
    input_dir: &Path,
) -> Result<InspectReport> {
    let plan = Plan::build(game, direction, input_dir)?;
    Ok(InspectReport {
        game_id: game.id.clone(),
        direction,
        save_root: display(&plan.save_root),
        convertible: plan.blockers.is_empty(),
        files: plan.files,
        missing: plan.missing,
        ignored_total: plan.ignored.len(),
        ignored: plan.ignored.into_iter().take(MAX_IGNORED_LISTED).collect(),
        blockers: plan.blockers,
    })
}

fn convert_with(game: &GameProfile, req: &ConvertRequest) -> Result<ConvertReport> {
    let direction = req.direction;
    let plan = Plan::build(game, direction, Path::new(&req.input_dir))?;
    if !plan.blockers.is_empty() {
        bail!("{}", plan.blockers.join(" "));
    }
    let options = check_options(game, direction, &req.options)?;
    let codec = codec::by_id(&game.codec)
        .ok_or_else(|| anyhow!("unknown codec {:?} for {}", game.codec, game.name))?;

    if req.output_dir.trim().is_empty() {
        bail!("Pick a folder to write the converted save into.");
    }
    let out_parent = PathBuf::from(&req.output_dir);
    fs::create_dir_all(&out_parent)
        .with_context(|| format!("can't create output folder {}", out_parent.display()))?;
    // The new folder must not land inside the source save: that folder
    // often gets copied wholesale back to a console or into Steam, and a
    // stray converted copy inside it would travel along.
    let out_real = fs::canonicalize(&out_parent)
        .with_context(|| format!("can't open output folder {}", out_parent.display()))?;
    let save_real = fs::canonicalize(&plan.save_root)
        .with_context(|| format!("can't open save folder {}", plan.save_root.display()))?;
    if out_real.starts_with(&save_real) {
        bail!("Pick an output folder that isn't inside the save you're converting.");
    }

    let out_dir = create_fresh_dir(
        &out_parent,
        &format!(
            "{}-{}-save",
            game.id,
            direction.target_name().to_ascii_lowercase()
        ),
    )?;
    let ctx = CodecCtx {
        game,
        direction,
        options: &options,
    };
    match write_all(&plan, codec, &ctx, &out_dir) {
        Ok((files, warnings)) => Ok(ConvertReport {
            game_id: game.id.clone(),
            direction,
            save_root: display(&plan.save_root),
            output_dir: display(&out_dir),
            files,
            ignored_total: plan.ignored.len(),
            warnings,
        }),
        Err(e) => {
            // All-or-nothing: a half-converted folder looks like a save
            // and would be the worst thing to hand back.
            let _ = fs::remove_dir_all(&out_dir);
            Err(e)
        }
    }
}

fn write_all(
    plan: &Plan,
    codec: &dyn codec::Codec,
    ctx: &CodecCtx<'_>,
    out_dir: &Path,
) -> Result<(Vec<ConvertedFile>, Vec<String>)> {
    let mut files = Vec::with_capacity(plan.files.len());
    let mut warnings = Vec::new();
    for (planned, &map_index) in plan.files.iter().zip(&plan.map_indices) {
        let source_path = join_rel(&plan.save_root, &planned.source);
        let input = read_capped(&source_path)?;
        let converted = codec
            .convert_file(ctx, &ctx.game.files[map_index], &input)
            .with_context(|| format!("couldn't convert {}", planned.source))?;
        warnings.extend(
            converted
                .warnings
                .into_iter()
                .map(|w| format!("{}: {w}", planned.source)),
        );

        let dest_path = join_rel(out_dir, &planned.dest);
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("can't create {}", parent.display()))?;
        }
        fs::write(&dest_path, &converted.data)
            .with_context(|| format!("can't write {}", dest_path.display()))?;
        files.push(ConvertedFile {
            label: planned.label.clone(),
            source: planned.source.clone(),
            dest: planned.dest.clone(),
            in_size: input.len() as u64,
            out_size: converted.data.len() as u64,
        });
    }
    Ok((files, warnings))
}

/// Validate the user-supplied values for this direction and return only
/// the ones that apply (values typed for the other direction are dropped).
fn check_options(
    game: &GameProfile,
    direction: Direction,
    given: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for spec in game.options.iter().filter(|s| s.applies_to(direction)) {
        let value = given.get(&spec.key).map(|v| v.trim()).unwrap_or("");
        if value.is_empty() {
            if spec.required {
                bail!("{} is required for this conversion.", spec.label);
            }
            continue;
        }
        spec.check(value)
            .with_context(|| format!("{} isn't valid", spec.label))?;
        out.insert(spec.key.clone(), value.to_string());
    }
    Ok(out)
}

// ── planning ────────────────────────────────────────────────────────────

struct Found {
    /// Path relative to the picked folder, `/`-separated.
    rel: String,
    size: u64,
}

struct Plan {
    save_root: PathBuf,
    files: Vec<PlannedFile>,
    /// `files[i]` matched `game.files[map_indices[i]]`.
    map_indices: Vec<usize>,
    missing: Vec<MissingFile>,
    ignored: Vec<String>,
    blockers: Vec<String>,
}

/// What a candidate save root (a folder at or below the picked one) holds.
struct Candidate {
    /// `""` for the picked folder itself, else its `/`-separated subpath.
    prefix: String,
    files: Vec<PlannedFile>,
    map_indices: Vec<usize>,
    ignored: Vec<String>,
    /// How many of the profile's required entries are present.
    required_present: usize,
}

impl Candidate {
    fn depth(&self) -> usize {
        if self.prefix.is_empty() {
            0
        } else {
            self.prefix.split('/').count()
        }
    }
}

impl Plan {
    fn build(game: &GameProfile, direction: Direction, input_dir: &Path) -> Result<Plan> {
        if input_dir.as_os_str().is_empty() {
            bail!("Pick the folder that holds the save.");
        }
        if !input_dir.is_dir() {
            bail!("{} isn't a folder.", input_dir.display());
        }
        let found = scan(input_dir)?;
        let required_total = game.files.iter().filter(|f| f.required).count();

        // The user may have picked the save folder itself or something
        // above it (an export folder, Steam's `remote`). Try the picked
        // folder and every folder below it as the save root.
        let mut prefixes = BTreeSet::from([String::new()]);
        for file in &found {
            let mut end = 0;
            while let Some(slash) = file.rel[end..].find('/') {
                end += slash;
                prefixes.insert(file.rel[..end].to_string());
                end += 1;
            }
        }
        let candidates: Vec<Candidate> = prefixes
            .iter()
            .map(|prefix| Candidate::evaluate(game, direction, &found, prefix))
            .collect();

        // A "complete" candidate has every required file. A complete
        // candidate nested inside another complete one is a copy/backup
        // kept inside the save folder, not a rival.
        let complete: Vec<&Candidate> = candidates
            .iter()
            .filter(|c| required_total > 0 && c.required_present == required_total)
            .collect();
        let outermost: Vec<&Candidate> = complete
            .iter()
            .copied()
            .filter(|c| {
                !complete
                    .iter()
                    .any(|other| is_inside(&c.prefix, &other.prefix))
            })
            .collect();

        let mut blockers = Vec::new();
        let source = direction.source_name();
        let chosen: &Candidate = match outermost.as_slice() {
            [only] => only,
            [] => {
                // Nothing complete: report against the closest partial
                // match so the "missing" list is as short and useful as
                // possible (ties go to the shallowest folder).
                let best = candidates
                    .iter()
                    .max_by_key(|c| {
                        (
                            c.required_present,
                            c.files.len(),
                            std::cmp::Reverse(c.depth()),
                        )
                    })
                    .expect("the picked folder itself is always a candidate");
                blockers.push(format!(
                    "This folder doesn't hold a complete {} {source} save.",
                    game.name
                ));
                best
            }
            several => {
                let names: Vec<&str> = several.iter().take(5).map(|c| c.prefix.as_str()).collect();
                blockers.push(format!(
                    "Found more than one {} {source} save in this folder ({}). Pick the one you want to convert.",
                    game.name,
                    names.join(", ")
                ));
                several[0]
            }
        };

        let mut missing = Vec::new();
        let present: BTreeSet<usize> = chosen.map_indices.iter().copied().collect();
        for (index, file) in game.files.iter().enumerate() {
            if !present.contains(&index) {
                missing.push(MissingFile {
                    label: file.label.clone(),
                    pattern: file.source(direction).to_string(),
                    required: file.required,
                });
            }
        }

        // Two source files landing on one destination (only possible on a
        // case-sensitive disk, e.g. `Data.bin` next to `data.bin`).
        let mut dests = BTreeSet::new();
        for file in &chosen.files {
            if !dests.insert(file.dest.to_ascii_lowercase()) {
                blockers.push(format!(
                    "More than one file would be written as {} — remove the duplicate from the save folder.",
                    file.dest
                ));
            }
            if !is_safe_rel(&file.dest) {
                blockers.push(format!(
                    "{} has a file name that can't be converted.",
                    file.source
                ));
            }
            if file.size > MAX_FILE_BYTES {
                blockers.push(format!("{} is too large to be a save file.", file.source));
            }
        }

        if game.status == Status::Wip {
            blockers.insert(
                0,
                format!("The {} converter isn't finished yet.", game.name),
            );
        }

        Ok(Plan {
            save_root: join_rel(input_dir, &chosen.prefix),
            files: chosen.files.clone(),
            map_indices: chosen.map_indices.clone(),
            missing,
            ignored: chosen.ignored.clone(),
            blockers,
        })
    }
}

impl Candidate {
    fn evaluate(game: &GameProfile, direction: Direction, found: &[Found], prefix: &str) -> Self {
        let mut files = Vec::new();
        let mut map_indices = Vec::new();
        let mut ignored = Vec::new();
        for file in found {
            let inner = if prefix.is_empty() {
                file.rel.as_str()
            } else {
                match file
                    .rel
                    .strip_prefix(prefix)
                    .and_then(|rest| rest.strip_prefix('/'))
                {
                    Some(inner) => inner,
                    None => continue, // not under this candidate
                }
            };
            let hit = game.files.iter().enumerate().find_map(|(index, map)| {
                pattern::capture(map.source(direction), inner).map(|cap| (index, map, cap))
            });
            match hit {
                Some((index, map, captured)) => {
                    files.push(PlannedFile {
                        label: map.label.clone(),
                        source: inner.to_string(),
                        dest: pattern::fill(map.dest(direction), &captured),
                        size: file.size,
                    });
                    map_indices.push(index);
                }
                None => ignored.push(inner.to_string()),
            }
        }
        let present: BTreeSet<usize> = map_indices.iter().copied().collect();
        let required_present = game
            .files
            .iter()
            .enumerate()
            .filter(|(index, map)| map.required && present.contains(index))
            .count();
        Candidate {
            prefix: prefix.to_string(),
            files,
            map_indices,
            ignored,
            required_present,
        }
    }
}

/// True when folder `inner` is strictly below folder `outer` (both are
/// `/`-separated prefixes; `""` is the picked folder itself).
fn is_inside(inner: &str, outer: &str) -> bool {
    if inner == outer {
        return false;
    }
    outer.is_empty()
        || inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// List the regular files under `root` (bounded — see the constants).
/// Symlinks and special files are skipped; they're never part of a save.
fn scan(root: &Path) -> Result<Vec<Found>> {
    let mut out = Vec::new();
    let mut seen = 0usize;
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            // The picked folder must be readable; an unreadable subfolder
            // just isn't part of the save.
            Err(e) if depth == 0 => {
                return Err(e).with_context(|| format!("can't read folder {}", dir.display()))
            }
            Err(_) => continue,
        };
        for entry in entries {
            let Ok(entry) = entry else { continue };
            seen += 1;
            if seen > MAX_SCAN_ENTRIES {
                bail!(
                    "{} holds too many files to be a save folder — pick the folder that contains just the save.",
                    root.display()
                );
            }
            // Names that aren't valid UTF-8 can't match a profile pattern.
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            // `DirEntry::file_type` doesn't follow symlinks.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_SCAN_DEPTH {
                    stack.push((entry.path(), rel, depth + 1));
                }
            } else if kind.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(Found { rel, size });
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn read_capped(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).with_context(|| format!("can't open {}", path.display()))?;
    let mut data = Vec::new();
    // `take` enforces the cap even if the file grew since it was scanned.
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .with_context(|| format!("can't read {}", path.display()))?;
    if data.len() as u64 > MAX_FILE_BYTES {
        bail!("{} is too large to be a save file.", path.display());
    }
    Ok(data)
}

/// Create `<parent>/<name>`, or `<name>-2`, `<name>-3`… if taken.
/// `create_dir` (not `create_dir_all`) makes "is it free?" and "claim it"
/// one atomic step, so an existing folder is never reused.
fn create_fresh_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    for attempt in 1..=999u32 {
        let candidate = if attempt == 1 {
            parent.join(name)
        } else {
            parent.join(format!("{name}-{attempt}"))
        };
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(e).with_context(|| format!("can't create {}", candidate.display()))
            }
        }
    }
    bail!(
        "{} already holds too many converted copies of this save — clear some out.",
        parent.display()
    )
}

/// A destination path built from a profile pattern plus text captured
/// from a real file name; make sure the capture didn't smuggle in
/// anything that changes where the file lands.
fn is_safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\\')
        && !rel.contains(':')
        && rel
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn join_rel(base: &Path, rel: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    path.extend(rel.split('/').filter(|segment| !segment.is_empty()));
    path
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Scratch dir removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "xeno-save-convert-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self, rel: &str) -> PathBuf {
            join_rel(&self.0, rel)
        }

        fn write(&self, rel: &str, data: &[u8]) {
            let path = self.path(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, data).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn game_with(codec: &str, status: &str) -> GameProfile {
        let game: GameProfile = serde_json::from_value(json!({
            "id": "test-game",
            "name": "Test Game",
            "status": status,
            "ps5": { "title_ids": ["PPSA00001"] },
            "pc": { "steam_app_id": 1 },
            "files": [
                { "ps5": "SYSTEM.DAT", "pc": "remote/system.sav", "label": "System data" },
                { "ps5": "SLOT*.DAT", "pc": "remote/slot_*.sav", "label": "Character slot", "required": false }
            ],
            "codec": codec,
            "options": [
                { "key": "steam_id64", "label": "SteamID64", "kind": "steam_id64", "directions": ["ps5_to_pc"] }
            ]
        }))
        .unwrap();
        game.validate().unwrap();
        game
    }

    fn game() -> GameProfile {
        game_with("passthrough", "ready")
    }

    const STEAM_ID: &str = "76561198000000000";

    fn request(direction: Direction, input: &Path, output: &Path) -> ConvertRequest {
        ConvertRequest {
            game_id: "test-game".into(),
            direction,
            input_dir: display(input),
            output_dir: display(output),
            options: BTreeMap::from([("steam_id64".to_string(), STEAM_ID.to_string())]),
        }
    }

    #[test]
    fn ps5_to_pc_renames_into_a_fresh_folder_and_leaves_the_input_alone() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"system");
        tmp.write("ps5/SLOT1.DAT", b"slot one");
        tmp.write("ps5/SLOT2.DAT", b"slot two");
        tmp.write("ps5/sce_sys/param.sfo", b"meta");

        let report = convert_with(
            &game(),
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out")),
        )
        .unwrap();

        let out = tmp.path("out/test-game-pc-save");
        assert_eq!(report.output_dir, display(&out));
        assert_eq!(fs::read(out.join("remote/system.sav")).unwrap(), b"system");
        assert_eq!(
            fs::read(out.join("remote/slot_1.sav")).unwrap(),
            b"slot one"
        );
        assert_eq!(
            fs::read(out.join("remote/slot_2.sav")).unwrap(),
            b"slot two"
        );
        assert_eq!(report.files.len(), 3);
        assert_eq!(report.ignored_total, 1); // sce_sys/param.sfo
        assert!(report.warnings.is_empty());
        // Input untouched.
        assert_eq!(fs::read(tmp.path("ps5/SYSTEM.DAT")).unwrap(), b"system");
        assert_eq!(fs::read_dir(tmp.path("ps5")).unwrap().count(), 4);
    }

    #[test]
    fn pc_to_ps5_maps_back_and_matches_case_insensitively() {
        let tmp = TempDir::new();
        tmp.write("pc/remote/System.SAV", b"system");
        tmp.write("pc/remote/slot_3.sav", b"slot three");

        let report = convert_with(
            &game(),
            &request(Direction::PcToPs5, &tmp.path("pc"), &tmp.path("out")),
        )
        .unwrap();

        let out = tmp.path("out/test-game-ps5-save");
        assert_eq!(report.output_dir, display(&out));
        assert_eq!(fs::read(out.join("SYSTEM.DAT")).unwrap(), b"system");
        assert_eq!(fs::read(out.join("SLOT3.DAT")).unwrap(), b"slot three");
    }

    #[test]
    fn round_trip_restores_the_original_layout() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"system");
        tmp.write("ps5/SLOT1.DAT", b"slot one");
        let to_pc = convert_with(
            &game(),
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("a")),
        )
        .unwrap();
        let back = convert_with(
            &game(),
            &request(
                Direction::PcToPs5,
                Path::new(&to_pc.output_dir),
                &tmp.path("b"),
            ),
        )
        .unwrap();
        let out = PathBuf::from(back.output_dir);
        assert_eq!(fs::read(out.join("SYSTEM.DAT")).unwrap(), b"system");
        assert_eq!(fs::read(out.join("SLOT1.DAT")).unwrap(), b"slot one");
    }

    #[test]
    fn finds_the_save_below_the_picked_folder() {
        let tmp = TempDir::new();
        tmp.write("export/PPSA00001/savedata0/SYSTEM.DAT", b"system");
        tmp.write("export/readme.txt", b"hi");

        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("export")).unwrap();
        assert!(report.convertible, "{:?}", report.blockers);
        assert_eq!(
            report.save_root,
            display(&tmp.path("export/PPSA00001/savedata0"))
        );
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].source, "SYSTEM.DAT");
        assert_eq!(report.files[0].dest, "remote/system.sav");
        // The optional slot pattern is reported, but doesn't block.
        assert_eq!(report.missing.len(), 1);
        assert!(!report.missing[0].required);
    }

    #[test]
    fn a_folder_without_the_required_file_is_refused_and_nothing_is_written() {
        let tmp = TempDir::new();
        tmp.write("ps5/SLOT1.DAT", b"slot one");
        tmp.write("ps5/unrelated.bin", b"x");

        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
        assert!(!report.convertible);
        assert!(report
            .missing
            .iter()
            .any(|m| m.required && m.pattern == "SYSTEM.DAT"));

        let err = convert_with(
            &game(),
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out")),
        )
        .unwrap_err();
        assert!(err.to_string().contains("doesn't hold a complete"), "{err}");
        assert!(!tmp.path("out").exists());
    }

    #[test]
    fn two_separate_saves_under_one_folder_are_ambiguous() {
        let tmp = TempDir::new();
        tmp.write("saves/alice/SYSTEM.DAT", b"a");
        tmp.write("saves/bob/SYSTEM.DAT", b"b");

        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("saves")).unwrap();
        assert!(!report.convertible);
        assert!(
            report.blockers[0].contains("more than one"),
            "{:?}",
            report.blockers
        );
        // Pointing at one of them resolves it.
        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("saves/bob")).unwrap();
        assert!(report.convertible);
    }

    #[test]
    fn a_backup_copy_nested_inside_the_save_is_not_a_rival() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"live");
        tmp.write("ps5/backup/SYSTEM.DAT", b"old");

        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
        assert!(report.convertible, "{:?}", report.blockers);
        assert_eq!(report.save_root, display(&tmp.path("ps5")));
        assert_eq!(report.ignored, vec!["backup/SYSTEM.DAT".to_string()]);
    }

    #[test]
    fn converting_twice_never_overwrites_the_first_result() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"first");
        let req = request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out"));
        let first = convert_with(&game(), &req).unwrap();
        tmp.write("ps5/SYSTEM.DAT", b"second");
        let second = convert_with(&game(), &req).unwrap();

        assert_eq!(
            second.output_dir,
            display(&tmp.path("out/test-game-pc-save-2"))
        );
        let read = |dir: &str| fs::read(Path::new(dir).join("remote/system.sav")).unwrap();
        assert_eq!(read(&first.output_dir), b"first");
        assert_eq!(read(&second.output_dir), b"second");
    }

    #[test]
    fn output_inside_the_source_save_is_refused() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"system");
        for out in ["ps5", "ps5/converted"] {
            let err = convert_with(
                &game(),
                &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path(out)),
            )
            .unwrap_err();
            assert!(err.to_string().contains("isn't inside the save"), "{err}");
        }
        // Nothing converted leaked into the save folder.
        assert!(!tmp.path("ps5/test-game-pc-save").exists());
        assert!(!tmp.path("ps5/converted/test-game-pc-save").exists());
    }

    #[test]
    fn wip_games_are_listed_but_refuse_to_convert() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"system");
        let wip = game_with("passthrough", "wip");

        let report = inspect_with(&wip, Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
        assert!(!report.convertible);
        assert!(report.blockers[0].contains("isn't finished yet"));
        assert!(convert_with(
            &wip,
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out"))
        )
        .is_err());
        assert!(!tmp.path("out").exists());
    }

    #[test]
    fn required_options_are_enforced_only_for_their_direction() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"system");
        tmp.write("pc/remote/system.sav", b"system");

        let mut req = request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out"));
        req.options.clear();
        let err = convert_with(&game(), &req).unwrap_err();
        assert!(err.to_string().contains("SteamID64 is required"), "{err}");

        req.options.insert("steam_id64".into(), "12345".into());
        let err = convert_with(&game(), &req).unwrap_err();
        assert!(format!("{err:#}").contains("17 digits"), "{err:#}");
        assert!(
            !tmp.path("out").exists(),
            "a rejected option must not create output"
        );

        // The option is declared for ps5_to_pc only, so the other
        // direction converts without it.
        let mut req = request(Direction::PcToPs5, &tmp.path("pc"), &tmp.path("out"));
        req.options.clear();
        convert_with(&game(), &req).unwrap();
    }

    #[test]
    fn the_codec_runs_and_its_warnings_reach_the_report() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"abc");
        tmp.write("ps5/SLOT1.DAT", b"");
        let report = convert_with(
            &game_with("test-reverse", "ready"),
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out")),
        )
        .unwrap();
        let out = PathBuf::from(&report.output_dir);
        assert_eq!(fs::read(out.join("remote/system.sav")).unwrap(), b"cba");
        assert_eq!(
            report.warnings,
            vec!["SLOT1.DAT: file is empty".to_string()]
        );
    }

    #[test]
    fn a_codec_failure_leaves_no_partial_output_behind() {
        let tmp = TempDir::new();
        // Scan order is alphabetical, so SLOT1 converts before SYSTEM fails.
        tmp.write("ps5/SLOT1.DAT", b"fine");
        tmp.write("ps5/SYSTEM.DAT", b"FAIL");
        let err = convert_with(
            &game_with("test-reverse", "ready"),
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out")),
        )
        .unwrap_err();
        assert!(
            format!("{err:#}").contains("this save is corrupt"),
            "{err:#}"
        );
        assert!(format!("{err:#}").contains("SYSTEM.DAT"), "{err:#}");
        assert_eq!(
            fs::read_dir(tmp.path("out")).unwrap().count(),
            0,
            "the half-written folder must be removed"
        );
    }

    #[test]
    fn missing_or_bogus_input_folders_are_reported_plainly() {
        let tmp = TempDir::new();
        tmp.write("file.bin", b"x");
        assert!(inspect_with(&game(), Direction::Ps5ToPc, Path::new("")).is_err());
        assert!(inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("nope")).is_err());
        assert!(inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("file.bin")).is_err());
    }

    #[test]
    fn is_inside_only_accepts_strict_descendants() {
        assert!(is_inside("a", ""));
        assert!(is_inside("a/b", "a"));
        assert!(!is_inside("a", "a"));
        assert!(!is_inside("ab", "a"));
        assert!(!is_inside("", "a"));
        assert!(!is_inside("", ""));
    }
}
