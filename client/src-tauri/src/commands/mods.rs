//! XENO Mod Manager — Phase 1 (v3.2.27).
//!
//! Takes a Nexus zip the user dropped/imported, extracts it to a per-mod
//! staging dir under app_local_data, categorizes each file by ER-specific
//! pattern, and returns a manifest the renderer can preview before the
//! user pushes it to PS5 via the existing `transfer_dir` engine command.
//!
//! What this does NOT do (yet):
//!   - download from Nexus (their CDN isn't in the http allowlist; users
//!     click through to nexusmods.com in their browser, download manually,
//!     then drag-drop the zip back into the app)
//!
//! What's NEW in v3.2.29:
//!   - `mods_apply_now` ships the `xenoking-mount-once.elf` payload to PS5:9021
//!     after writing the active-mods `state.json` to the console. The ELF
//!     reads that state file, finds the running Elden Ring sandbox, and
//!     unionfs-mounts every active mod's top-level subdirs over /app0/.
//!     One-shot — the user re-clicks "Apply Mods Now" each game session.
//!
//! The mod manifest is just data — the renderer is free to render any
//! preview / conflict UI it wants on top of it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// On-console mod-loader ELF. Built by the `build-mod-daemon` CI job from
/// `mod-daemon/main.c` via prospero-clang; CI restores the artifact to this
/// path before `cargo tauri build` runs (see release.yml's "Place mod-daemon
/// ELF for include_bytes!" step). For local dev the file may be 0 bytes —
/// `mods_apply_now` refuses to fire in that case rather than push a stub to
/// the PS5. Embed (not network fetch): users hitting Apply Mods Now expect
/// zero network round-trips, and the GitHub Releases endpoint can be offline
/// or rate-limited — a missing embed is a build bug, not a runtime hiccup.
const MOUNT_ONCE_ELF: &[u8] =
    include_bytes!("../../../../mod-daemon/xenoking-mount-once.elf");

/// Port the ps5upload management runtime listens on (small-file writes via
/// the FsWriteBytes frame). Mirrors `PS5_PAYLOAD_PORT` in connection.ts.
const PS5_MGMT_PORT: u16 = 9114;

/// Elden Ring US title id — the only game v3.2.27 ships support for.
/// Future versions add a `game: GameKey` field threaded through, and the
/// catalog declares per-game prefix routing.
const ER_TITLE_ID: &str = "CUSA18000";

/// Subdir under `<app_local_data>/xeno_mods/staged/<mod_id>/` we extract
/// each mod into. Files inside use the same relative layout the daemon
/// will mount over `/app0/`.
const STAGED_SUBDIR: &str = "xeno_mods/staged";

/// Subdir under app_local_data where we persist the active-mods JSON the
/// renderer reads at startup. One file per game so future-multi-game
/// support is just iterating files.
const STATE_SUBDIR: &str = "xeno_mods/state";

#[derive(Serialize, Deserialize, Clone)]
pub struct ModFileEntry {
    /// Path inside the original zip (forward-slashes, no leading slash).
    pub zip_path: String,
    /// Absolute destination on the PS5 (`/app0/...`) the daemon will
    /// nullfs-mount over this overlay.
    pub game_path: String,
    /// Coarse category used for UI grouping + conflict detection.
    pub file_type: String,
    /// Human label rendered in the "what it replaces" list, e.g.
    /// "player character animations" or "Bloodhound Knight body armor".
    pub replaces_item: String,
    pub size_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModManifest {
    /// Stable id derived from the zip basename — used as the mod-folder
    /// name on disk and as the deduplication key in active state.
    pub mod_id: String,
    /// Human-friendly title — defaults to the zip basename minus version
    /// suffix; the renderer can override when pulled from the catalog.
    pub title: String,
    pub title_id: String,
    pub total_files: usize,
    pub total_bytes: u64,
    pub staged_dir: String,
    pub files: Vec<ModFileEntry>,
    /// Coarse categories present in the zip (animations, regulation,
    /// parts, msg, sound, …). Used by the UI to flag "this mod touches
    /// gameplay parameters" etc.
    pub categories: Vec<String>,
    /// Hard-conflict files (file_type ∈ {regulation, animations}) that
    /// will collide with any other mod touching the same path. The UI
    /// uses this to gate the install with a clear warning.
    pub conflict_paths: Vec<String>,
}

/// Per-game persisted state: which staged mods the user has toggled on.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct ModActiveState {
    pub title_id: String,
    pub active: Vec<String>,
}

/// Classify an ER file by its in-zip path. Returns (file_type, replaces_item).
/// The pattern list is the v3.2.27 truth table — pulled straight from the
/// audit of Naruto Six Paths + Clever's Moveset Modpack + the standard ER
/// file layout. Future mods will hit one of these patterns; anything that
/// doesn't match falls through as "other".
fn classify(rel: &str) -> (&'static str, String) {
    let lower = rel.to_ascii_lowercase();
    let base = Path::new(&lower)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&lower);

    // regulation.bin — game-wide parameter blob (weapon stats, balance, …)
    if base == "regulation.bin" {
        return ("regulation", "game balance & parameter data (regulation.bin)".into());
    }
    // chr/ — player or NPC bundles. c0000 = player, c8000 = mount.
    if lower.contains("/chr/") || lower.starts_with("chr/") {
        if base.starts_with("c0000") {
            if base.ends_with(".anibnd.dcx") {
                return ("animations", "player character animations".into());
            }
            if base.ends_with(".behbnd.dcx") {
                return ("animations", "player Havok behaviour graph".into());
            }
            if base.ends_with(".chrbnd.dcx") {
                return ("animations", "player character bundle (skeleton + bind)".into());
            }
        }
        if base.starts_with("c8000") {
            return ("animations", "Torrent (mount) character bundle".into());
        }
        return ("animations", format!("character bundle ({})", base));
    }
    if lower.starts_with("action/script") || lower.contains("/action/script/") {
        return ("event", format!("player Havok script ({})", base));
    }
    // parts/ — wm/am/bd/hd/lg = weapon/arms/body/head/legs.
    // Parts files — either under a `parts/` subdir OR at the zip root with a
    // recognizable partsbnd basename (Naruto Six Paths and a lot of cosmetic
    // packs ship flat: `bd_m_2010.partsbnd.dcx` at zip root). Match the prefix
    // pattern even when there's no `parts/` parent.
    let is_partsbnd = base.ends_with(".partsbnd.dcx") || base.ends_with(".partsbnd");
    let parts_prefix = base.len() >= 2
        && matches!(&base[0..2], "wp" | "wm" | "am" | "bd" | "hd" | "lg" | "fc");
    if lower.contains("/parts/") || lower.starts_with("parts/") || (is_partsbnd && parts_prefix) {
        let kind = match &base[0..2.min(base.len())] {
            "wp" => "weapon model",
            "wm" => "weapon model",
            "am" => "arms armor",
            "bd" => "body armor",
            "hd" => "head armor",
            "lg" => "leg armor",
            "fc" => "face/hair model",
            _ => "parts model",
        };
        // Carry the file-name into the label so the UI shows the slot id.
        let label = base.trim_end_matches(".dcx").trim_end_matches(".partsbnd");
        return ("parts", format!("{} ({})", kind, label));
    }
    if lower.contains("/menu/") || lower.starts_with("menu/") {
        return ("menu", format!("UI / menu asset ({})", base));
    }
    if lower.contains("/msg/") || lower.starts_with("msg/") {
        return ("msg", format!("localized text ({})", base));
    }
    if lower.contains("/sound/") || lower.starts_with("sound/") {
        return ("sound", format!("audio asset ({})", base));
    }
    if lower.contains("/sfx/") || lower.starts_with("sfx/") {
        return ("sound", format!("VFX/particle bundle ({})", base));
    }
    if lower.contains("/param/") || lower.starts_with("param/") {
        return ("param", format!("game parameter ({})", base));
    }
    if lower.contains("/event/") || lower.starts_with("event/") {
        return ("event", format!("event script ({})", base));
    }
    if lower.contains("/shader/") || lower.starts_with("shader/") {
        return ("shader", format!("shader ({})", base));
    }
    ("other", format!("file: {}", base))
}

fn mod_id_from_zip(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("mod")
        .to_string();
    // Strip the Nexus-style "-NNNN-V-V-TIMESTAMP" suffix Nexus appends to
    // the filename so the same mod across re-downloads gets a stable id.
    let trimmed = stem.splitn(2, '-').next().unwrap_or(&stem).trim();
    // Sanitize: keep [A-Za-z0-9._-], collapse spaces/whitespace to '_'.
    let id: String = trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let id = id.trim_matches('_').to_string();
    if id.is_empty() { "mod".into() } else { id.to_ascii_lowercase() }
}

fn staged_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app local data dir: {e}"))?
        .join(STAGED_SUBDIR))
}

fn state_path(app: &AppHandle, title_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("no app local data dir: {e}"))?
        .join(STATE_SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir state: {e}"))?;
    Ok(dir.join(format!("{title_id}.json")))
}

/// Extract a Nexus mod zip into per-mod staging and return the manifest.
/// Caller (renderer) then calls the existing `transfer_dir` to push the
/// staged dir to `/data/xeno_mods/{title_id}/{mod_id}/` on the PS5.
#[tauri::command]
pub async fn mods_extract_and_inspect(
    app: AppHandle,
    zip_path: String,
    override_mod_id: Option<String>,
    override_title: Option<String>,
) -> Result<ModManifest, String> {
    let src = PathBuf::from(&zip_path);
    if !src.is_file() {
        return Err(format!("zip not found: {zip_path}"));
    }

    let mod_id = override_mod_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| mod_id_from_zip(&src));
    let title = override_title
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            src.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&mod_id)
                .replace('_', " ")
        });

    let root = staged_root(&app)?.join(ER_TITLE_ID).join(&mod_id);
    // Idempotent re-import: wipe any previous extraction so the staged
    // tree exactly mirrors the new zip — partial leftovers would otherwise
    // upload stale files alongside the new ones.
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("clean stage: {e}"))?;
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir stage: {e}"))?;

    let f = std::fs::File::open(&src).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| format!("read zip: {e}"))?;

    let mut files: Vec<ModFileEntry> = Vec::new();
    let mut cats: std::collections::BTreeSet<String> = Default::default();
    let mut conflict_paths: Vec<String> = Vec::new();
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| "zip entry has an unsafe path".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        // Skip obvious noise (mac metadata, readme, install instructions).
        let low = rel.to_ascii_lowercase();
        if low.starts_with("__macosx/")
            || low.ends_with("/.ds_store")
            || low.ends_with(".txt")
            || low.ends_with(".md")
            || low.ends_with(".pdf")
            || low.ends_with(".jpg")
            || low.ends_with(".png")
            || low.ends_with(".gif")
        {
            continue;
        }

        let (ftype, label) = classify(&rel);
        cats.insert(ftype.to_string());
        // Normalize the relative path so the staged tree mirrors what the
        // on-console daemon will mount at /app0/. Armor packs like Naruto Six
        // Paths ship FLAT (bd_m_2010.partsbnd.dcx at zip root) but the bytes
        // belong under /app0/parts/, not /app0/. Promote those into a
        // synthetic `parts/` prefix so the staged layout, the displayed
        // game_path, and the transfer_dir push all line up.
        let canonical_rel: String = match ftype {
            "parts" if !rel.contains("/parts/") && !rel.starts_with("parts/") => {
                let base = Path::new(&rel)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&rel);
                format!("parts/{}", base)
            }
            _ => rel.clone(),
        };

        let dest = root.join(&canonical_rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("create {dest:?}: {e}"))?;
        let copied = std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {rel}: {e}"))?;
        total_bytes = total_bytes.saturating_add(copied);

        let game_path = format!("/app0/{}", canonical_rel.trim_start_matches('/'));
        if ftype == "regulation" || ftype == "animations" {
            conflict_paths.push(game_path.clone());
        }
        files.push(ModFileEntry {
            zip_path: rel,
            game_path,
            file_type: ftype.to_string(),
            replaces_item: label,
            size_bytes: copied,
        });
    }

    if files.is_empty() {
        return Err("zip contained no installable files (only readmes / images?)".into());
    }

    Ok(ModManifest {
        mod_id,
        title,
        title_id: ER_TITLE_ID.to_string(),
        total_files: files.len(),
        total_bytes,
        staged_dir: root.to_string_lossy().into_owned(),
        files,
        categories: cats.into_iter().collect(),
        conflict_paths,
    })
}

/// List every mod that's been extracted into staging for a given title.
/// Each row carries enough to render the My Mods view without re-opening
/// the original zip.
#[tauri::command]
pub async fn mods_list_staged(
    app: AppHandle,
    title_id: Option<String>,
) -> Result<Vec<StagedSummary>, String> {
    let tid = title_id.unwrap_or_else(|| ER_TITLE_ID.to_string());
    let root = staged_root(&app)?.join(&tid);
    let mut out: Vec<StagedSummary> = Vec::new();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Ok(out);
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let id = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let (count, bytes) = walk_size(&p);
        out.push(StagedSummary {
            mod_id: id,
            title_id: tid.clone(),
            staged_dir: p.to_string_lossy().into_owned(),
            file_count: count,
            total_bytes: bytes,
        });
    }
    out.sort_by(|a, b| a.mod_id.cmp(&b.mod_id));
    Ok(out)
}

#[derive(Serialize)]
pub struct StagedSummary {
    pub mod_id: String,
    pub title_id: String,
    pub staged_dir: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

fn walk_size(p: &Path) -> (usize, u64) {
    let mut count = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let q = e.path();
                if q.is_dir() {
                    stack.push(q);
                } else if let Ok(m) = std::fs::metadata(&q) {
                    count += 1;
                    bytes = bytes.saturating_add(m.len());
                }
            }
        }
    }
    (count, bytes)
}

/// Delete a mod's staged extraction (local only — does NOT touch the PS5
/// copy; the daemon will simply not see it on next launch).
#[tauri::command]
pub async fn mods_remove_staged(
    app: AppHandle,
    mod_id: String,
    title_id: Option<String>,
) -> Result<(), String> {
    if mod_id.is_empty() || mod_id.contains('/') || mod_id.contains('\\') || mod_id.contains("..") {
        return Err(format!("bad mod_id: {mod_id}"));
    }
    let tid = title_id.unwrap_or_else(|| ER_TITLE_ID.to_string());
    let dir = staged_root(&app)?.join(&tid).join(&mod_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {dir:?}: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mods_active_load(
    app: AppHandle,
    title_id: Option<String>,
) -> Result<ModActiveState, String> {
    let tid = title_id.unwrap_or_else(|| ER_TITLE_ID.to_string());
    let path = state_path(&app, &tid)?;
    if !path.exists() {
        return Ok(ModActiveState { title_id: tid, active: vec![] });
    }
    let txt = std::fs::read_to_string(&path).map_err(|e| format!("read state: {e}"))?;
    serde_json::from_str(&txt).map_err(|e| format!("parse state: {e}"))
}

#[tauri::command]
pub async fn mods_active_save(
    app: AppHandle,
    state: ModActiveState,
) -> Result<(), String> {
    let path = state_path(&app, &state.title_id)?;
    let txt = serde_json::to_string_pretty(&state).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, txt).map_err(|e| format!("write tmp: {e}"))?;
    super::replace_file(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Summary returned by `mods_apply_now` so the renderer can render a tidy
/// success notification: which mods went out, where the loader log lives on
/// the PS5, how many bytes hit the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyMountResult {
    pub title_id: String,
    pub active: Vec<String>,
    pub state_bytes: usize,
    pub elf_bytes: usize,
    pub log_path: String,
}

/// One-shot mod loader: write the current active-mods state.json to the PS5,
/// then stream `xenoking-mount-once.elf` to :9021 so it executes inside
/// etaHEN's kstuff-lite context and unionfs-mounts each active mod's top
/// directory over the running game's <sandbox>/app0/<subdir>.
///
/// Pre-requisite: the user must have launched Elden Ring already — the
/// sandbox mount path only exists inside a running game session. The ELF
/// logs to /data/xeno_mods/mount-once.log so the user can FTP-in and read
/// what mounted (or what failed and why).
#[tauri::command]
pub async fn mods_apply_now(
    app: AppHandle,
    host: String,
    title_id: Option<String>,
) -> Result<ApplyMountResult, String> {
    if MOUNT_ONCE_ELF.is_empty() {
        return Err(
            "xenoking-mount-once.elf was not embedded into this build — CI step \
             'Place mod-daemon ELF for include_bytes!' did not run. Update the app."
                .into(),
        );
    }
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err("no PS5 host set — connect first".into());
    }
    let tid = title_id.unwrap_or_else(|| ER_TITLE_ID.to_string());

    // (1) Load the current active list and push it to the PS5 at the path
    // the daemon hard-codes in main.c (STATE_FMT = /data/xeno_mods/<tid>/state.json).
    let state = {
        let path = state_path(&app, &tid)?;
        if path.exists() {
            let txt = std::fs::read_to_string(&path).map_err(|e| format!("read state: {e}"))?;
            serde_json::from_str::<ModActiveState>(&txt)
                .map_err(|e| format!("parse state: {e}"))?
        } else {
            ModActiveState { title_id: tid.clone(), active: vec![] }
        }
    };
    if state.active.is_empty() {
        return Err(
            "no mods are marked active in My Mods — enable at least one before applying.".into(),
        );
    }
    let state_json = serde_json::to_vec_pretty(&state).map_err(|e| format!("serialize state: {e}"))?;
    let state_bytes_len = state_json.len();
    let remote_state_path = format!("/data/xeno_mods/{}/state.json", tid);
    let mgmt_addr = format!("{host}:{PS5_MGMT_PORT}");
    {
        let addr = mgmt_addr.clone();
        let path = remote_state_path.clone();
        let raw = state_json.clone();
        tokio::task::spawn_blocking(move || {
            ps5upload_core::diagnostics::fs_write_bytes(&addr, &path, &raw, false)
        })
        .await
        .map_err(|e| format!("state write task: {e}"))?
        .map_err(|e| format!("push state.json: {e}"))?;
    }

    // (2) Drop the embedded ELF to a tempfile and stream it to :9021 via the
    // same path the rest of the app's payload-send flow uses. Tempfile is
    // auto-cleaned when the handle drops.
    let tmp_dir = std::env::temp_dir();
    let elf_path = tmp_dir.join("xenoking-mount-once.elf");
    std::fs::write(&elf_path, MOUNT_ONCE_ELF).map_err(|e| format!("stage elf tmp: {e}"))?;
    let elf_bytes_len = MOUNT_ONCE_ELF.len();
    super::probes::do_payload_send(
        &host,
        elf_path.to_string_lossy().as_ref(),
        super::probes::PS5_LOADER_PORT,
    )
    .await?;
    // Best-effort cleanup; not fatal.
    let _ = std::fs::remove_file(&elf_path);

    Ok(ApplyMountResult {
        title_id: state.title_id,
        active: state.active,
        state_bytes: state_bytes_len,
        elf_bytes: elf_bytes_len,
        log_path: "/data/xeno_mods/mount-once.log".to_string(),
    })
}
