//! Save conversion orchestration: find the save, plan it, run the codec,
//! write the result.
//!
//! Guarantees the rest of the app (and the user) can rely on:
//!
//!   * The input is opened read-only and never modified — the output
//!     folder may not be anywhere inside the folder being converted from.
//!   * Output always goes into a brand-new folder created inside the
//!     folder the user picked — nothing that already exists is touched.
//!   * A conversion either fully succeeds or leaves nothing behind; a
//!     failure (or a crash) part-way through removes the new folder and
//!     any parent folders that were created for it.
//!   * `inspect` and `convert` share one planning step, so what the
//!     preview shows is exactly what gets converted.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

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
    /// Why this particular file can't be converted, when the codec's
    /// early look at it found a reason. Also listed in `blockers`.
    pub problem: Option<String>,
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
    let mut plan = Plan::build(game, direction, input_dir)?;
    check_sources(game, direction, &mut plan);
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

/// Let the codec look at each source file, if it wants to, and turn what
/// it objects to into blockers — so "that's a PC save, not a PS5 one"
/// appears in the preview, and ahead of any complaint about options.
fn check_sources(game: &GameProfile, direction: Direction, plan: &mut Plan) {
    let Some(codec) = codec::by_id(&game.codec).filter(|c| c.checks_sources()) else {
        return;
    };
    let mut objections = Vec::new();
    for (index, (planned, &map_index)) in plan.files.iter().zip(&plan.map_indices).enumerate() {
        // Already blocked as too large by the plan — don't read it just
        // to say so again.
        if planned.size > MAX_FILE_BYTES {
            continue;
        }
        let verdict = read_capped(&join_rel(&plan.save_root, &planned.source))
            .and_then(|input| codec.check_source(game, direction, &game.files[map_index], &input));
        if let Err(e) = verdict {
            objections.push((index, format!("{e:#}")));
        }
    }
    for (index, reason) in objections {
        let file = &mut plan.files[index];
        plan.blockers.push(format!("{}: {reason}", file.source));
        file.problem = Some(reason);
    }
}

fn convert_with(game: &GameProfile, req: &ConvertRequest) -> Result<ConvertReport> {
    let direction = req.direction;
    let mut plan = Plan::build(game, direction, Path::new(&req.input_dir))?;
    check_sources(game, direction, &mut plan);
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
    // A folder picker always hands over a full, already-resolved path.
    // Anything else is refused rather than interpreted: a relative path
    // would depend on where the app happened to be started, and `..`
    // can't be resolved for folders that don't exist yet, which would let
    // a path walk back into the save unnoticed.
    if !out_parent.is_absolute() {
        bail!("The output folder must be a full path.");
    }
    if out_parent
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        bail!("The output folder path can't contain \"..\" — pick the folder itself.");
    }
    // The new folder must not land anywhere inside the folder being
    // converted from. Inside the save itself it would travel along when
    // that folder is copied back to a console or into Steam; elsewhere
    // under the picked folder it would be found as a second save the next
    // time that folder is converted. Checked before anything is created,
    // so a refused request leaves the source untouched.
    let input_real = fs::canonicalize(&req.input_dir)
        .with_context(|| format!("can't open folder {}", req.input_dir))?;
    if resolve_lenient(&out_parent).starts_with(&input_real) {
        bail!("Pick an output folder that isn't inside the folder you're converting from.");
    }

    // From here on things get created; the guard takes them away again
    // unless the conversion runs to completion.
    let mut guard = OutputGuard::new(&out_parent);
    fs::create_dir_all(&out_parent)
        .with_context(|| format!("can't create output folder {}", out_parent.display()))?;
    let out_dir = create_fresh_dir(
        &out_parent,
        &format!(
            "{}-{}-save",
            game.id,
            direction.target_name().to_ascii_lowercase()
        ),
    )?;
    guard.fresh = Some(out_dir.clone());

    let ctx = CodecCtx {
        game,
        direction,
        options: &options,
    };
    let (files, warnings) = write_all(&plan, codec, &ctx, &out_dir)?;
    guard.keep();
    Ok(ConvertReport {
        game_id: game.id.clone(),
        direction,
        save_root: display(&plan.save_root),
        output_dir: display(&out_dir),
        files,
        ignored_total: plan.ignored.len(),
        warnings,
    })
}

/// Undoes what a conversion created unless it finishes: the new output
/// folder, and any parent folders that had to be created to hold it.
/// All-or-nothing matters because a half-converted folder looks like a
/// save. It is a `Drop` guard rather than an error branch so that a codec
/// that panics is covered as well as one that returns an error.
struct OutputGuard {
    /// Folders that didn't exist before the conversion, deepest first.
    created_parents: Vec<PathBuf>,
    fresh: Option<PathBuf>,
    keep: bool,
}

impl OutputGuard {
    /// Call before creating `out_parent`, so the folders that are about
    /// to be created can be told apart from the ones already there.
    fn new(out_parent: &Path) -> Self {
        let mut created_parents = Vec::new();
        let mut probe = Some(out_parent);
        while let Some(dir) = probe.filter(|d| !d.as_os_str().is_empty() && !d.exists()) {
            created_parents.push(dir.to_path_buf());
            probe = dir.parent();
        }
        OutputGuard {
            created_parents,
            fresh: None,
            keep: false,
        }
    }

    fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for OutputGuard {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        if let Some(fresh) = &self.fresh {
            let _ = fs::remove_dir_all(fresh);
        }
        // `remove_dir` only removes an empty folder, so anything that
        // turned up in there in the meantime is left alone.
        for dir in &self.created_parents {
            let _ = fs::remove_dir(dir);
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

/// One scanned file recognised as part of a save.
struct Hit {
    /// Index into the scan results.
    found: usize,
    /// Index into `game.files`.
    map: usize,
    /// Path inside the save root it belongs to, `/`-separated.
    source: String,
    dest: String,
}

/// What a candidate save root (a folder at or below the picked one) holds.
struct Candidate<'a> {
    /// `""` for the picked folder itself, else its `/`-separated subpath.
    prefix: &'a str,
    hits: &'a [Hit],
    /// How many of the profile's required entries are present.
    required_present: usize,
}

impl Candidate<'_> {
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
        // above it (an export folder, Steam's `remote`). Every folder that
        // holds at least one recognised file is a candidate save root, and
        // so is the picked folder itself.
        let hits_by_root = recognise(game, direction, &found);
        let no_hits: Vec<Hit> = Vec::new();
        let mut candidates: Vec<Candidate<'_>> = Vec::with_capacity(hits_by_root.len() + 1);
        if !hits_by_root.contains_key("") {
            candidates.push(Candidate {
                prefix: "",
                hits: &no_hits,
                required_present: 0,
            });
        }
        for (prefix, hits) in &hits_by_root {
            let present: BTreeSet<usize> = hits.iter().map(|h| h.map).collect();
            candidates.push(Candidate {
                prefix,
                hits,
                required_present: present.iter().filter(|&&i| game.files[i].required).count(),
            });
        }

        // A "complete" candidate has every required file — or, for a
        // profile where nothing is mandatory, at least one recognised
        // file. A complete candidate nested inside another complete one
        // is a copy/backup kept inside the save folder, not a rival.
        let complete: Vec<&Candidate<'_>> = candidates
            .iter()
            .filter(|c| {
                if required_total > 0 {
                    c.required_present == required_total
                } else {
                    !c.hits.is_empty()
                }
            })
            .collect();
        let complete_roots: HashSet<&str> = complete.iter().map(|c| c.prefix).collect();
        let outermost: Vec<&Candidate<'_>> = complete
            .iter()
            .copied()
            .filter(|c| !has_ancestor_in(c.prefix, &complete_roots))
            .collect();

        let mut blockers = Vec::new();
        let source = direction.source_name();
        let chosen: &Candidate<'_> = match outermost.as_slice() {
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
                            c.hits.len(),
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
                let names: Vec<&str> = several.iter().take(5).map(|c| c.prefix).collect();
                blockers.push(format!(
                    "Found more than one {} {source} save in this folder ({}). Pick the one you want to convert.",
                    game.name,
                    names.join(", ")
                ));
                several[0]
            }
        };

        let files: Vec<PlannedFile> = chosen
            .hits
            .iter()
            .map(|hit| PlannedFile {
                label: game.files[hit.map].label.clone(),
                source: hit.source.clone(),
                dest: hit.dest.clone(),
                size: found[hit.found].size,
                problem: None,
            })
            .collect();
        let map_indices: Vec<usize> = chosen.hits.iter().map(|hit| hit.map).collect();

        // Everything else under the chosen root is left out of the
        // conversion, and reported as such.
        let claimed: HashSet<usize> = chosen.hits.iter().map(|hit| hit.found).collect();
        let ignored: Vec<String> = found
            .iter()
            .enumerate()
            .filter(|(index, _)| !claimed.contains(index))
            .filter_map(|(_, file)| inner_path(&file.rel, chosen.prefix))
            .map(str::to_string)
            .collect();

        let mut missing = Vec::new();
        let present: BTreeSet<usize> = map_indices.iter().copied().collect();
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
        for file in &files {
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
            save_root: join_rel(input_dir, chosen.prefix),
            files,
            map_indices,
            missing,
            ignored,
            blockers,
        })
    }
}

/// Match every scanned file against the profile and file each match under
/// the save root it implies: `a/b/data.bin` matching the pattern
/// `b/data.bin` belongs to a save rooted at `a`. One pass over the files,
/// rather than trying every folder as a root against every file.
///
/// Entries without a `*` are tried first, so a file named exactly like one
/// entry is never swallowed by another entry's wildcard. Under any one
/// root a file is claimed by at most one entry.
fn recognise(
    game: &GameProfile,
    direction: Direction,
    found: &[Found],
) -> BTreeMap<String, Vec<Hit>> {
    let mut order: Vec<usize> = (0..game.files.len()).collect();
    order.sort_by_key(|&index| pattern::has_wildcard(game.files[index].source(direction)));

    let mut by_root: BTreeMap<String, Vec<Hit>> = BTreeMap::new();
    for (found_index, file) in found.iter().enumerate() {
        // Where this file's in-root path starts, for each root it has
        // already been claimed under.
        let mut claimed: Vec<usize> = Vec::new();
        for &map_index in &order {
            let map = &game.files[map_index];
            let source_pattern = map.source(direction);
            let Some(start) = tail_start(&file.rel, source_pattern.split('/').count()) else {
                continue;
            };
            if claimed.contains(&start) {
                continue;
            }
            let inner = &file.rel[start..];
            let Some(captured) = pattern::capture(source_pattern, inner) else {
                continue;
            };
            claimed.push(start);
            let root = if start == 0 {
                ""
            } else {
                &file.rel[..start - 1]
            };
            by_root.entry(root.to_string()).or_default().push(Hit {
                found: found_index,
                map: map_index,
                source: inner.to_string(),
                dest: pattern::fill(map.dest(direction), &captured),
            });
        }
    }
    by_root
}

/// Byte offset at which the last `segments` `/`-separated segments of
/// `rel` begin, or `None` when `rel` has fewer segments than that.
fn tail_start(rel: &str, segments: usize) -> Option<usize> {
    // One past a virtual trailing separator.
    let mut start = rel.len() + 1;
    for _ in 0..segments {
        if start == 0 {
            return None;
        }
        start = rel[..start - 1].rfind('/').map_or(0, |slash| slash + 1);
    }
    Some(start)
}

/// `rel` as seen from the folder `prefix` (`""` = the picked folder), or
/// `None` when `rel` isn't under it.
fn inner_path<'a>(rel: &'a str, prefix: &str) -> Option<&'a str> {
    if prefix.is_empty() {
        Some(rel)
    } else {
        rel.strip_prefix(prefix)?.strip_prefix('/')
    }
}

/// True when a folder strictly above `prefix` is in `roots` (`""` is the
/// picked folder itself, above every other).
fn has_ancestor_in(prefix: &str, roots: &HashSet<&str>) -> bool {
    if prefix.is_empty() {
        return false;
    }
    if roots.contains("") {
        return true;
    }
    let mut end = prefix.len();
    while let Some(slash) = prefix[..end].rfind('/') {
        end = slash;
        if roots.contains(&prefix[..end]) {
            return true;
        }
    }
    false
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

/// Canonicalize a path that may not exist yet: resolve the deepest
/// ancestor that does exist and re-attach the rest unchanged. Lets a
/// not-yet-created output folder be compared against the save folder
/// without creating it first.
fn resolve_lenient(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        let probe = if current.as_os_str().is_empty() {
            Path::new(".")
        } else {
            current
        };
        if let Ok(mut real) = fs::canonicalize(probe) {
            real.extend(missing.iter().rev());
            return real;
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_os_string());
                current = parent;
            }
            // Nothing along the path resolves: compare it as given.
            _ => return path.to_path_buf(),
        }
    }
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
            assert!(err.to_string().contains("isn't inside the folder"), "{err}");
        }
        // Nothing leaked into the save folder — not even the (refused)
        // output folder itself.
        assert!(!tmp.path("ps5/test-game-pc-save").exists());
        assert!(!tmp.path("ps5/converted").exists());
        assert_eq!(fs::read_dir(tmp.path("ps5")).unwrap().count(), 1);
    }

    #[test]
    fn a_profile_with_only_optional_files_needs_at_least_one_of_them() {
        let mut optional = game();
        for file in &mut optional.files {
            file.required = false;
        }
        let tmp = TempDir::new();
        tmp.write("empty/unrelated.bin", b"x");
        tmp.write("ps5/SLOT1.DAT", b"slot one");

        let report = inspect_with(&optional, Direction::Ps5ToPc, &tmp.path("empty")).unwrap();
        assert!(!report.convertible);

        let report = inspect_with(&optional, Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
        assert!(report.convertible, "{:?}", report.blockers);
        assert_eq!(report.files.len(), 1);
        convert_with(
            &optional,
            &request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out")),
        )
        .unwrap();
        assert_eq!(
            fs::read(tmp.path("out/test-game-pc-save/remote/slot_1.sav")).unwrap(),
            b"slot one"
        );
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
    fn a_codec_can_reject_a_source_file_in_the_preview() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"WRONG platform");
        tmp.write("ps5/SLOT1.DAT", b"fine");
        let checking = game_with("test-reverse", "ready");

        let report = inspect_with(&checking, Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
        assert!(!report.convertible);
        assert_eq!(
            report.blockers,
            vec!["SYSTEM.DAT: this isn't a PS5 save".to_string()]
        );
        // The file is still listed — it was found, it just can't be used —
        // and carries the reason; the other file is clean.
        assert_eq!(report.files.len(), 2);
        let problem = |name: &str| {
            let file = report.files.iter().find(|f| f.source == name).unwrap();
            file.problem.clone()
        };
        assert_eq!(
            problem("SYSTEM.DAT").as_deref(),
            Some("this isn't a PS5 save")
        );
        assert_eq!(problem("SLOT1.DAT"), None);

        // Converting reports the same objection, ahead of the missing
        // option, and writes nothing.
        let mut req = request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out"));
        req.options.clear();
        let err = convert_with(&checking, &req).unwrap_err();
        assert!(err.to_string().contains("this isn't a PS5 save"), "{err}");
        assert!(!tmp.path("out").exists());

        // A codec that doesn't ask to see sources (passthrough) accepts
        // the same folder.
        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
        assert!(report.convertible, "{:?}", report.blockers);
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
        // Both the half-written folder and the output folder that was
        // created to hold it are gone.
        assert!(
            !tmp.path("out").exists(),
            "nothing created for the conversion may remain"
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
    fn tail_start_finds_where_the_last_segments_begin() {
        assert_eq!(tail_start("c.bin", 1), Some(0));
        assert_eq!(tail_start("c.bin", 2), None);
        assert_eq!(tail_start("a/b/c.bin", 1), Some(4));
        assert_eq!(tail_start("a/b/c.bin", 2), Some(2));
        assert_eq!(tail_start("a/b/c.bin", 3), Some(0));
        assert_eq!(tail_start("a/b/c.bin", 4), None);
    }

    #[test]
    fn has_ancestor_in_only_counts_folders_strictly_above() {
        let roots = |list: &[&'static str]| list.iter().copied().collect::<HashSet<&str>>();
        assert!(has_ancestor_in("a/b", &roots(&["a"])));
        assert!(has_ancestor_in("a/b/c", &roots(&["a"])));
        assert!(has_ancestor_in("a", &roots(&[""])));
        assert!(!has_ancestor_in("a", &roots(&["a"])));
        assert!(!has_ancestor_in("ab/c", &roots(&["a"])));
        assert!(!has_ancestor_in("", &roots(&["", "a"])));
        assert!(!has_ancestor_in("a/b", &roots(&["a/b/c", "x"])));
    }

    #[test]
    fn an_output_path_with_dot_dot_is_refused_before_anything_is_created() {
        // `..` can't be resolved through folders that don't exist yet, so
        // such a path could walk back into the save without being noticed.
        for route in [
            "nonexistent/../ps5/converted",
            "nonexistent/sub/../../ps5/x/y",
            "ps5/nonexistent/../converted",
            "other/../ps5",
            "other/../elsewhere",
        ] {
            let tmp = TempDir::new();
            tmp.write("ps5/SYSTEM.DAT", b"system");
            fs::create_dir_all(tmp.path("other")).unwrap();
            let out = tmp.0.join(route);
            let err = convert_with(
                &game(),
                &request(Direction::Ps5ToPc, &tmp.path("ps5"), &out),
            )
            .unwrap_err();
            assert!(
                err.to_string().contains("can't contain \"..\""),
                "{route}: {err}"
            );
            assert_eq!(
                fs::read_dir(tmp.path("ps5")).unwrap().count(),
                1,
                "{route}: the save folder must be untouched"
            );
            assert!(!tmp.path("nonexistent").exists(), "{route}");
        }
    }

    #[test]
    fn a_relative_output_path_is_refused() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"system");
        let mut req = request(Direction::Ps5ToPc, &tmp.path("ps5"), Path::new("out"));
        req.output_dir = "relative/out".into();
        let err = convert_with(&game(), &req).unwrap_err();
        assert!(err.to_string().contains("full path"), "{err}");
    }

    #[test]
    fn output_inside_the_picked_folder_is_refused_even_outside_the_located_save() {
        // The save sits two levels below the picked folder. Writing the
        // result next to it would make the picked folder hold two "saves"
        // the next time round.
        let tmp = TempDir::new();
        tmp.write("export/PPSA00001/savedata0/SYSTEM.DAT", b"system");
        for out in ["export", "export/converted", "export/PPSA00001"] {
            let err = convert_with(
                &game(),
                &request(Direction::Ps5ToPc, &tmp.path("export"), &tmp.path(out)),
            )
            .unwrap_err();
            assert!(
                err.to_string().contains("isn't inside the folder"),
                "{out}: {err}"
            );
        }
        assert!(!tmp.path("export/converted").exists());
        assert!(!tmp.path("export/test-game-pc-save").exists());
        // A sibling of the picked folder is fine, and converting again
        // from the same picked folder still finds exactly one save.
        let req = request(Direction::Ps5ToPc, &tmp.path("export"), &tmp.path("out"));
        convert_with(&game(), &req).unwrap();
        convert_with(&game(), &req).unwrap();
    }

    #[test]
    fn a_failed_conversion_removes_the_folders_it_created_and_nothing_else() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"FAIL");
        tmp.write("existing/keep.txt", b"mine");
        let failing = game_with("test-reverse", "ready");

        // The whole chain new/deep/out is created for the conversion and
        // must be gone again after it fails.
        convert_with(
            &failing,
            &request(
                Direction::Ps5ToPc,
                &tmp.path("ps5"),
                &tmp.path("new/deep/out"),
            ),
        )
        .unwrap_err();
        assert!(!tmp.path("new").exists());

        // A folder that already existed stays, with its contents; only
        // the part below it that was created goes.
        convert_with(
            &failing,
            &request(
                Direction::Ps5ToPc,
                &tmp.path("ps5"),
                &tmp.path("existing/sub"),
            ),
        )
        .unwrap_err();
        assert_eq!(fs::read(tmp.path("existing/keep.txt")).unwrap(), b"mine");
        assert!(!tmp.path("existing/sub").exists());

        // On success the created chain is kept.
        tmp.write("ps5/SYSTEM.DAT", b"ok");
        convert_with(
            &failing,
            &request(
                Direction::Ps5ToPc,
                &tmp.path("ps5"),
                &tmp.path("new/deep/out"),
            ),
        )
        .unwrap();
        assert!(tmp
            .path("new/deep/out/test-game-pc-save/remote/system.sav")
            .exists());
    }

    #[test]
    fn a_panicking_codec_leaves_no_partial_output_behind() {
        let tmp = TempDir::new();
        // SLOT1 converts and is written before SYSTEM makes the codec panic.
        tmp.write("ps5/SLOT1.DAT", b"fine");
        tmp.write("ps5/SYSTEM.DAT", b"PANIC");
        let panicking = game_with("test-reverse", "ready");
        let req = request(Direction::Ps5ToPc, &tmp.path("ps5"), &tmp.path("out"));
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            convert_with(&panicking, &req)
        }));
        assert!(outcome.is_err(), "the test codec should have panicked");
        assert!(
            !tmp.path("out").exists(),
            "a crash mid-conversion must not leave a half-written save"
        );
    }

    #[test]
    fn an_exact_file_name_wins_over_another_entry_s_wildcard() {
        // `SYSTEM.DAT` also matches `S*.DAT`. Whatever order the profile
        // lists them in, the exact entry must claim it.
        for wildcard_first in [true, false] {
            let mut files = vec![
                json!({ "ps5": "S*.DAT", "pc": "s_*.sav", "label": "Slot", "required": false }),
                json!({ "ps5": "SYSTEM.DAT", "pc": "system.sav", "label": "System" }),
            ];
            if !wildcard_first {
                files.reverse();
            }
            let overlapping: GameProfile = serde_json::from_value(json!({
                "id": "test-game",
                "name": "Test Game",
                "status": "ready",
                "ps5": {},
                "pc": {},
                "files": files,
                "codec": "passthrough"
            }))
            .unwrap();
            let tmp = TempDir::new();
            tmp.write("ps5/SYSTEM.DAT", b"system");
            tmp.write("ps5/S1.DAT", b"slot");
            let report = inspect_with(&overlapping, Direction::Ps5ToPc, &tmp.path("ps5")).unwrap();
            assert!(report.convertible, "{:?}", report.blockers);
            let dests: Vec<(&str, &str)> = report
                .files
                .iter()
                .map(|f| (f.source.as_str(), f.dest.as_str()))
                .collect();
            assert_eq!(dests, [("S1.DAT", "s_1.sav"), ("SYSTEM.DAT", "system.sav")]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_oversized_file_is_reported_once_and_never_read() {
        let tmp = TempDir::new();
        tmp.write("ps5/SYSTEM.DAT", b"");
        // Sparse: takes no disk space, and reading it would be slow enough
        // to notice if the check ever regressed into reading it.
        fs::File::options()
            .write(true)
            .open(tmp.path("ps5/SYSTEM.DAT"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        // "test-reverse" asks to see source files in the preview.
        let report = inspect_with(
            &game_with("test-reverse", "ready"),
            Direction::Ps5ToPc,
            &tmp.path("ps5"),
        )
        .unwrap();
        assert_eq!(
            report.blockers,
            vec!["SYSTEM.DAT is too large to be a save file.".to_string()]
        );
    }

    #[test]
    fn many_separate_saves_under_one_folder_are_handled_quickly() {
        // 3,000 one-file saves: every folder is a complete candidate.
        // Planning used to compare every folder with every file.
        let tmp = TempDir::new();
        for i in 0..3000 {
            tmp.write(&format!("saves/s{i:04}/SYSTEM.DAT"), b"x");
        }
        let started = std::time::Instant::now();
        let report = inspect_with(&game(), Direction::Ps5ToPc, &tmp.path("saves")).unwrap();
        assert!(!report.convertible);
        assert!(
            report.blockers[0].contains("more than one"),
            "{:?}",
            report.blockers
        );
        // Generous bound: it takes a few milliseconds; the old quadratic
        // planning took seconds in a debug build.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }
}
