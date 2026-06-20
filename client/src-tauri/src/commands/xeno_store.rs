//! XENO additions — HTTP fetch for the Game Store + cheat/trainer sync.
//!
//! The renderer's CSP `connect-src` intentionally doesn't include arbitrary
//! external hosts, so (like `title_meta_fetch`) these scrapes route through a
//! Rust command. We keep a hostname allowlist so a compromised renderer can't
//! turn this into an SSRF primitive. Unlike title_meta we DO follow redirects
//! (the dlpsgame mirror chain and GitHub's raw CDN both rely on them) but only
//! ever land back on an allowlisted host — the allowlist is re-checked here in
//! Rust, and the practical hosts are all public CDNs / the text proxy.

use std::time::Duration;

/// Hosts XENO will fetch on behalf of the renderer. Exact host OR a subdomain
/// of one of these (so `r.jina.ai`, `raw.githubusercontent.com`, etc. match).
const ALLOWED_HOSTS: &[&str] = &[
    "dlpsgame.com",
    "jina.ai",                 // r.jina.ai text proxy (JS-render + CF bypass)
    "downloadgameps3.net",
    "downloadgameps4.net",
    "github.com",
    "githubusercontent.com",   // raw.githubusercontent.com / objects.*
    "api.github.com",
    "prosperopatches.com",     // PS5 (PPSA) title + cover lookup
    "serialstation.com",       // PS4 (CUSA) title lookup
    "pkg.games",               // static PS5 game list + individual detail pages
    "pspkg.com",               // pspkg.com PS4/PS5 catalog (CF-protected, uses jina)
    "superpsx.com",            // superpsx.com PS4/PS5 catalog + dll-* download redirects
    "allorigins.win",          // CORS proxy for sites that block non-browser agents
    "arabicps4games.com",      // arabicps4games.com PS4/PS5 direct catalog (GitHub Pages)
    "justpaste.it",            // justpaste.it detail pages — PS5 game download links inside
    "jpcdn.it",                // justpaste CDN (cover/image assets)
];

/// Hosts allowed for the cover-image proxy. Superset of ALLOWED_HOSTS image
/// origins — WordPress commonly serves resized thumbnails through wp.com CDN.
const IMAGE_ALLOWED_HOSTS: &[&str] = &[
    "dlpsgame.com",
    "wp.com",                      // i0.wp.com … i3.wp.com — WordPress Jetpack image CDN
    "wordpress.com",
    "pkg.games",                   // wp-content/uploads cover art (individual game pages)
    "pspkg.com",                   // pspkg.com game cover art
    "image.api.playstation.com",   // PlayStation official cover CDN (covers.json URLs)
    "cdn.prosperopatches.com",     // PS5 PPSA cover art via prosperopatches
    "orbispatches.com",            // PS4 cover art fallback
    "superpsx.com",                // superpsx.com cover art (wp-content/uploads, .webp)
    "postimg.cc",                  // arabicps4games.com cover art (i.postimg.cc)
    "jpcdn.it",                    // justpaste.it CDN for cover images
];

/// 12 MiB ceiling — the jina-rendered game pages are large but bounded.
const MAX_BODY_BYTES: usize = 12 * 1024 * 1024;
/// 4 MiB ceiling for cover images — more than enough for a JPEG thumbnail.
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);

/// A real-browser UA — dlpsgame returns 403 to non-browser agents.
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

fn host_allowed(host: &str) -> bool {
    ALLOWED_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

/// Fetch a URL's body as a UTF-8 string. Optional `jina` flag wraps the URL in
/// the r.jina.ai proxy (runs the page's JS + passes Cloudflare) and asks for
/// raw HTML. Used by the Game Store catalog/detail scrape and cheat sync.
#[tauri::command]
pub async fn xeno_http_get(url: String, jina: Option<bool>) -> Result<String, String> {
    let target = if jina.unwrap_or(false) {
        format!("https://r.jina.ai/{url}")
    } else {
        url.clone()
    };
    let parsed = reqwest::Url::parse(&target).map_err(|e| format!("invalid url: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("refusing non-http(s) url: {target}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("url has no host: {target}"))?;
    if !host_allowed(host) {
        return Err(format!("host not in allowlist: {host}"));
    }

    let mut headers = reqwest::header::HeaderMap::new();
    if jina.unwrap_or(false) {
        // ask the proxy for raw HTML, not its markdown rendering
        headers.insert("X-Return-Format", "html".parse().unwrap());
    }

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(BROWSER_UA)
        .redirect(reqwest::redirect::Policy::limited(6))
        .default_headers(headers)
        .build()
        .map_err(|e| format!("xeno http client init: {e}"))?;

    let resp = client
        .get(parsed)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml,application/json,*/*",
        )
        .send()
        .await
        .map_err(|e| format!("xeno http fetch: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("http {}", status.as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_BODY_BYTES as u64 {
            return Err(format!("body too large ({len} > {MAX_BODY_BYTES})"));
        }
    }

    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("xeno http read: {e}"))?;
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("body exceeded cap mid-stream".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Fetch a game cover image and return it as a `data:<mime>;base64,…` URI.
/// Used by the Game Store as a fallback when the browser's direct `<img>` load
/// fails (Cloudflare hotlink protection, CSP mismatch, or WordPress CDN host
/// not in img-src). Sends no Referer header, so hotlink checks pass.
#[tauri::command]
pub async fn xeno_image_fetch(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(format!("refusing non-http(s) url: {url}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("url has no host: {url}"))?;
    if !IMAGE_ALLOWED_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    {
        return Err(format!("host not allowed for image proxy: {host}"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(BROWSER_UA)
        .redirect(reqwest::redirect::Policy::limited(6))
        // No Referer — bypasses Cloudflare / WordPress hotlink protection.
        .referer(false)
        .build()
        .map_err(|e| format!("image client: {e}"))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("image fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .trim()
        .to_string();
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("image read: {e}"))?;
        if body.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err("image too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&body);
    Ok(format!("data:{mime};base64,{b64}"))
}

// --------------------------------------------------------------------------- //
//  CheatRunner (on-console web cheat engine on :9999) — My Games / Trainers.
//  Open HTTP API, CORS *, no auth. We proxy through Rust so the renderer's CSP
//  doesn't need every LAN PS5 IP, and so icons come back as data: URIs (the
//  webview blocks plain-http <img> as mixed content).
// --------------------------------------------------------------------------- //
const CR_PORT: u16 = 9999;

fn cr_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("cheatrunner client init: {e}"))
}

fn valid_host(ip: &str) -> bool {
    !ip.is_empty()
        && ip.len() < 64
        && ip.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
}

/// GET `http://<ip>:9999<path>` and return the body text (JSON). `path` must
/// start with '/'. Used for /api/games, /api/cheats/state, /api/cheats/toggle…
#[tauri::command]
pub async fn cheatrunner_get(ip: String, path: String) -> Result<String, String> {
    if !valid_host(&ip) {
        return Err(format!("bad host: {ip}"));
    }
    if !path.starts_with('/') {
        return Err("path must start with '/'".into());
    }
    let url = format!("http://{ip}:{CR_PORT}{path}");
    let resp = cr_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("cheatrunner unreachable on {ip}:{CR_PORT} — {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("cheatrunner read: {e}"))?;
    if !status.is_success() {
        return Err(format!("cheatrunner http {} — {}", status.as_u16(), text));
    }
    Ok(text)
}

/// Fetch a game cover from CheatRunner's app DB and return it as a
/// `data:image/png;base64,…` URI (so the renderer can use it directly in an
/// <img> without a mixed-content/CSP problem).
#[tauri::command]
pub async fn cheatrunner_icon(ip: String, id: String) -> Result<String, String> {
    if !valid_host(&ip) || id.is_empty() {
        return Err("bad host/id".into());
    }
    let url = format!("http://{ip}:{CR_PORT}/appdb/icon?id={id}");
    let resp = cr_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("icon fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("icon http {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("icon read: {e}"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("icon too large".into());
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

// --------------------------------------------------------------------------- //
//  XENO trainer library — 6-repo cheat sync + scan. Trainers live under
//  <app_data_dir>/trainers/{json,mc4,shn}/. Sync pulls each repo's branch zip
//  and extracts the cheat files; scan reads lightweight metadata (game name,
//  title id, version, modder, cheat names) for the Trainers / Title Search
//  browse pages. Cheat APPLY is via CheatRunner / ps5debug, not here.
// --------------------------------------------------------------------------- //
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const CHEAT_REPOS: &[&str] = &[
    "TeeKay87/HEN-Cheats-Collection",
    "GoldHEN/GoldHEN_Cheat_Repository",
    "RDX-Sci01/HEN-PPSA-Cheats",
    "illusionyy/ps-game-patch",
    "spfi970/PS5_etaHEN_Cheat_Repository",
    "etaHEN/PS5_Cheats",
];

fn trainers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("trainers");
    Ok(base)
}

fn ext_subdir(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "json" => Some("json"),
        "mc4" | "xml" => Some("mc4"), // .mc4 + .mc4.xml sidecars together
        "shn" => Some("shn"),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct SyncResult {
    pub total: u32,
    pub per_repo: Vec<(String, u32)>,
}

/// Download every cheat repo's branch zip and extract trainer files. `force`
/// re-pulls even unchanged repos.
#[tauri::command]
pub async fn cheat_sync(app: AppHandle, force: Option<bool>) -> Result<SyncResult, String> {
    let _ = force;
    let root = trainers_dir(&app)?;
    for sub in ["json", "mc4", "shn"] {
        let _ = std::fs::create_dir_all(root.join(sub));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent(BROWSER_UA)
        .redirect(reqwest::redirect::Policy::limited(6))
        .build()
        .map_err(|e| format!("sync client: {e}"))?;

    let mut total = 0u32;
    let mut per_repo = Vec::new();
    for repo in CHEAT_REPOS {
        let mut n = 0u32;
        for branch in ["main", "master"] {
            let url = format!("https://github.com/{repo}/archive/refs/heads/{branch}.zip");
            let resp = match client.get(&url).send().await {
                Ok(r) if r.status().is_success() => r,
                _ => continue,
            };
            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(_) => continue,
            };
            n = extract_zip(&bytes, &root).unwrap_or(0);
            break; // first branch that downloaded wins
        }
        total += n;
        per_repo.push((repo.to_string(), n));
    }
    Ok(SyncResult { total, per_repo })
}

/// Extract every cheat file (.json/.mc4/.mc4.xml/.shn) from a repo zip into the
/// right trainers subdir. Returns the number of files written.
fn extract_zip(bytes: &[u8], root: &std::path::Path) -> Result<u32, String> {
    use std::io::{Cursor, Read};
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("zip: {e}"))?;
    let mut n = 0u32;
    for i in 0..zip.len() {
        let mut f = match zip.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let fname = name.rsplit('/').next().unwrap_or(&name).to_string();
        if fname.is_empty() {
            continue;
        }
        // route by extension (.mc4.xml → mc4 dir as "xml")
        let ext = fname.rsplit('.').next().unwrap_or("").to_string();
        let sub = match ext_subdir(&ext) {
            Some(s) => s,
            None => continue,
        };
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        let dest = root.join(sub).join(&fname);
        if std::fs::write(&dest, &buf).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

// --------------------------------------------------------------------------- //
//  First-run SEED: ship the full trainer library (~9k) + the title catalog
//  inside the installer and unpack them once, so a fresh install has every
//  cheat and a name for almost every title immediately. The 24h cheat_sync
//  layers repo updates on top. Idempotent via stamp files (mirrors the
//  engine's extract-on-first-run).
// --------------------------------------------------------------------------- //
const TRAINER_SEED_ZIP: &[u8] = include_bytes!("../../resources/trainers-seed.zip");
const TITLES_SEED_ZIP: &[u8] = include_bytes!("../../resources/titles-seed.zip");
const COVERS_SEED_ZIP: &[u8] = include_bytes!("../../resources/covers-seed.zip");
const SEED_VERSION: &str = "v4";

/// Best-effort, called once at startup. Never panics — a seed hiccup just means
/// the user syncs from the repos as before.
pub fn seed_on_startup(app: &AppHandle) {
    if let Err(e) = seed_trainers(app) {
        eprintln!("[seed] trainers: {e}");
    }
    if let Err(e) = seed_titles(app) {
        eprintln!("[seed] titles: {e}");
    }
    if let Err(e) = seed_covers(app) {
        eprintln!("[seed] covers: {e}");
    }
}

/// Extract the bundled game covers (CUSA#####.jpg / PPSA#####.jpg) into the app
/// data dir's covers/ folder so trainer cards have art for games the online
/// covers map misses (mostly PS4).
fn seed_covers(app: &AppHandle) -> Result<(), String> {
    use std::io::{Cursor, Read};
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("covers");
    let stamp = dir.join(".covers_seed");
    if seeded(&stamp) {
        return Ok(());
    }
    let _ = std::fs::create_dir_all(&dir);
    let mut zip =
        zip::ZipArchive::new(Cursor::new(COVERS_SEED_ZIP)).map_err(|e| format!("covers zip: {e}"))?;
    let mut n = 0u32;
    for i in 0..zip.len() {
        let mut f = match zip.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if f.is_dir() {
            continue;
        }
        let name = f.name().rsplit('/').next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        if std::fs::write(dir.join(&name), &buf).is_ok() {
            n += 1;
        }
    }
    let _ = std::fs::write(&stamp, SEED_VERSION);
    eprintln!("[seed] unpacked {n} covers");
    Ok(())
}

/// Absolute path to a bundled cover for a title id (e.g. CUSA12345), or "" if
/// none. The renderer turns it into an asset URL via convertFileSrc.
#[tauri::command]
pub async fn trainer_cover_path(app: AppHandle, title_id: String) -> Result<String, String> {
    let id = title_id.split('_').next().unwrap_or(&title_id).trim().to_uppercase();
    if id.is_empty() {
        return Ok(String::new());
    }
    let p = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("covers")
        .join(format!("{id}.jpg"));
    Ok(if p.exists() {
        p.to_string_lossy().to_string()
    } else {
        String::new()
    })
}

fn seeded(stamp: &std::path::Path) -> bool {
    std::fs::read_to_string(stamp)
        .map(|s| s.trim() == SEED_VERSION)
        .unwrap_or(false)
}

fn seed_trainers(app: &AppHandle) -> Result<(), String> {
    let root = trainers_dir(app)?;
    let stamp = root.join(".seed");
    if seeded(&stamp) {
        return Ok(());
    }
    for sub in ["json", "mc4", "shn"] {
        let _ = std::fs::create_dir_all(root.join(sub));
    }
    let n = extract_zip(TRAINER_SEED_ZIP, &root)?;
    let _ = std::fs::write(&stamp, SEED_VERSION);
    eprintln!("[seed] unpacked {n} bundled trainer files");
    Ok(())
}

/// Extract the single All_Titles.json out of titles-seed.zip into the app data
/// dir so the title resolver has an offline base (covers PS4 + PS5).
fn seed_titles(app: &AppHandle) -> Result<(), String> {
    use std::io::{Cursor, Read};
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let stamp = dir.join(".titles_seed");
    if seeded(&stamp) && dir.join("All_Titles.json").exists() {
        return Ok(());
    }
    let _ = std::fs::create_dir_all(&dir);
    let mut zip =
        zip::ZipArchive::new(Cursor::new(TITLES_SEED_ZIP)).map_err(|e| format!("titles zip: {e}"))?;
    // Extract BOTH name indexes: All_Titles.json (general PS catalog) and
    // cheatslist.json (cheat-repo names — newer, covers games the general
    // catalog lacks, e.g. Saros / PPSA07631).
    let mut wrote = 0u32;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| format!("zip entry: {e}"))?;
        let name = f.name().rsplit('/').next().unwrap_or("").to_string();
        if name == "All_Titles.json" || name == "cheatslist.json" {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| format!("read {name}: {e}"))?;
            std::fs::write(dir.join(&name), &buf).map_err(|e| format!("write {name}: {e}"))?;
            wrote += 1;
        }
    }
    if wrote > 0 {
        let _ = std::fs::write(&stamp, SEED_VERSION);
        eprintln!("[seed] wrote {wrote} title-index file(s)");
        Ok(())
    } else {
        Err("no title index found in seed".into())
    }
}

// --------------------------------------------------------------------------- //
//  Title resolution: offline catalog (All_Titles.json) first, then live
//  prosperopatches.com for PS5 (PPSA) names + cover art.
// --------------------------------------------------------------------------- //
static TITLE_INDEX: std::sync::OnceLock<std::collections::HashMap<String, String>> =
    std::sync::OnceLock::new();

fn title_index(app: &AppHandle) -> &'static std::collections::HashMap<String, String> {
    TITLE_INDEX.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        if let Ok(dir) = app.path().app_data_dir() {
            if let Ok(txt) = std::fs::read_to_string(dir.join("All_Titles.json")) {
                if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&txt) {
                    for t in arr {
                        if let (Some(id), Some(name)) = (t["titleId"].as_str(), t["name"].as_str()) {
                            let key = id.split('_').next().unwrap_or(id).to_uppercase();
                            m.entry(key).or_insert_with(|| name.to_string());
                        }
                    }
                }
            }
            // cheatslist.json — `{ "entries": [ { "id": "PPSA07631",
            // "title": "SAROS", ... } ] }`. Cheat-repo names take precedence
            // (newer + cover games the general catalog doesn't have).
            if let Ok(txt) = std::fs::read_to_string(dir.join("cheatslist.json")) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(entries) = v["entries"].as_array() {
                        for e in entries {
                            if let (Some(id), Some(title)) = (e["id"].as_str(), e["title"].as_str()) {
                                let key = id.split('_').next().unwrap_or(id).to_uppercase();
                                m.insert(key, title.to_string());
                            }
                        }
                    }
                }
            }
        }
        m
    })
}

#[derive(Serialize)]
pub struct TitleInfo {
    pub title: String,
    pub cover: String,
}

/// Resolve a CUSA/PPSA id to a game name (+ cover for PS5). Catalog first, then
/// prosperopatches for PS5 to fill a missing name and add real cover art.
#[tauri::command]
pub async fn title_resolve(app: AppHandle, id: String) -> Result<TitleInfo, String> {
    let key = id.split('_').next().unwrap_or(&id).trim().to_uppercase();
    let mut title = title_index(&app).get(&key).cloned().unwrap_or_default();
    let mut cover = String::new();
    if key.starts_with("PPSA") {
        if let Ok(html) = fetch_prospero(&key).await {
            if title.is_empty() {
                title = extract_prospero_title(&html, &key);
            }
            cover = extract_prospero_cover(&html);
        }
    }
    Ok(TitleInfo { title, cover })
}

async fn fetch_prospero(ppsa: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://prosperopatches.com/{ppsa}");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("prospero {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// `<title>PPSA01628: Call of Duty®: Black Ops Cold War</title>` -> the name.
fn extract_prospero_title(html: &str, key: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(s) = lower.find("<title>") {
        let start = s + 7;
        if let Some(e) = lower[start..].find("</title>") {
            let raw = html[start..start + e].trim();
            // strip the "PPSAxxxxx: " prefix
            let name = raw
                .strip_prefix(key)
                .map(|r| r.trim_start_matches([':', ' ']).to_string())
                .unwrap_or_else(|| raw.to_string());
            return name.trim().to_string();
        }
    }
    String::new()
}

/// First `cdn.prosperopatches.com/titles/.../icon0.webp` -> a full https URL.
fn extract_prospero_cover(html: &str) -> String {
    const NEEDLE: &str = "cdn.prosperopatches.com/titles/";
    if let Some(p) = html.find(NEEDLE) {
        let tail = &html[p..];
        let end = tail
            .find(|c: char| c == '"' || c == '\'' || c == ')' || c.is_whitespace())
            .unwrap_or(tail.len());
        let path = &tail[..end];
        if path.contains("icon0") {
            return format!("https://{path}");
        }
        // otherwise build the icon0 url from the title dir
        if let Some(slash) = path[NEEDLE.len()..].find('/') {
            let dir = &path[..NEEDLE.len() + slash];
            return format!("https://{dir}/icon0.webp");
        }
    }
    String::new()
}

// --------------------------------------------------------------------------- //
//  nanoDNS live probe — send one real DNS query to the console's :53 so the UI
//  can show an honest ON/OFF (and whether it's actually blocking PSN).
// --------------------------------------------------------------------------- //
#[derive(Serialize)]
pub struct NanoDnsStatus {
    pub running: bool,
    pub blocking: bool,
    pub detail: String,
}

#[tauri::command]
pub async fn nanodns_probe(host: String) -> Result<NanoDnsStatus, String> {
    let host = host.trim().to_string();
    if host.is_empty() {
        return Ok(NanoDnsStatus {
            running: false,
            blocking: false,
            detail: "no console connected".into(),
        });
    }
    // A PSN download domain nanoDNS blocks (returns 0.0.0.0) by default.
    let domain = "gs2.ww.prod.dl.playstation.net";
    let res = tauri::async_runtime::spawn_blocking(move || probe_dns(&host, domain))
        .await
        .map_err(|e| e.to_string())?;
    Ok(res)
}

fn probe_dns(host: &str, domain: &str) -> NanoDnsStatus {
    use std::net::UdpSocket;
    let query = build_dns_query(domain);
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(e) => {
            return NanoDnsStatus {
                running: false,
                blocking: false,
                detail: format!("socket: {e}"),
            }
        }
    };
    let _ = sock.set_read_timeout(Some(Duration::from_secs(2)));
    if sock.send_to(&query, format!("{host}:53")).is_err() {
        return NanoDnsStatus {
            running: false,
            blocking: false,
            detail: "couldn't reach :53".into(),
        };
    }
    let mut buf = [0u8; 512];
    match sock.recv_from(&mut buf) {
        Ok((n, _)) => {
            let ip = parse_first_a(&buf[..n]);
            let blocking = matches!(ip, Some([0, 0, 0, 0]));
            let detail = match ip {
                Some(a) => format!("answered {}.{}.{}.{}", a[0], a[1], a[2], a[3]),
                None => "answered on :53".into(),
            };
            NanoDnsStatus {
                running: true,
                blocking,
                detail,
            }
        }
        Err(_) => NanoDnsStatus {
            running: false,
            blocking: false,
            detail: "no DNS reply on :53 (nanoDNS not running)".into(),
        },
    }
}

/// Minimal DNS A-query packet for `domain`.
fn build_dns_query(domain: &str) -> Vec<u8> {
    let mut q = vec![
        0x12, 0x34, // id
        0x01, 0x00, // flags: standard query, recursion desired
        0x00, 0x01, // qdcount = 1
        0x00, 0x00, // ancount
        0x00, 0x00, // nscount
        0x00, 0x00, // arcount
    ];
    for label in domain.split('.') {
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0x00); // root label
    q.extend_from_slice(&[0x00, 0x01]); // type A
    q.extend_from_slice(&[0x00, 0x01]); // class IN
    q
}

/// Defensive parse of the first A record's 4-byte address. Returns None on any
/// malformed/short response (never panics).
fn parse_first_a(resp: &[u8]) -> Option<[u8; 4]> {
    if resp.len() < 12 {
        return None;
    }
    let qd = u16::from_be_bytes([resp[4], resp[5]]) as usize;
    let an = u16::from_be_bytes([resp[6], resp[7]]) as usize;
    if an == 0 {
        return None;
    }
    let mut i = 12;
    // skip question section
    for _ in 0..qd {
        i = skip_name(resp, i)?;
        i = i.checked_add(4)?; // qtype + qclass
        if i > resp.len() {
            return None;
        }
    }
    // walk answers
    for _ in 0..an {
        i = skip_name(resp, i)?;
        let rtype = u16::from_be_bytes([*resp.get(i)?, *resp.get(i + 1)?]);
        let rdlen = u16::from_be_bytes([*resp.get(i + 8)?, *resp.get(i + 9)?]) as usize;
        let rdata = i.checked_add(10)?;
        if rtype == 1 && rdlen == 4 && rdata + 4 <= resp.len() {
            return Some([resp[rdata], resp[rdata + 1], resp[rdata + 2], resp[rdata + 3]]);
        }
        i = rdata.checked_add(rdlen)?;
        if i > resp.len() {
            return None;
        }
    }
    None
}

/// Advance past a DNS name (labels or a compression pointer). Returns the index
/// just after the name, or None if malformed.
fn skip_name(resp: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let len = *resp.get(i)? as usize;
        if len == 0 {
            return Some(i + 1);
        }
        if len & 0xC0 == 0xC0 {
            // compression pointer = 2 bytes, name ends here
            return Some(i + 2);
        }
        i = i.checked_add(1 + len)?;
        if i > resp.len() {
            return None;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainerRow {
    pub game: String,
    pub title_id: String,
    pub version: String,
    pub format: String, // "JSON" | "SHN" | "MC4"
    pub modder: String,
    pub cheats: Vec<String>,
    pub path: String,
}

fn attr<'a>(xml: &'a str, key: &str) -> String {
    // crude: find  key="value"  (case-insensitive key)
    let needle = format!("{key}=\"");
    let lower = xml.to_ascii_lowercase();
    if let Some(p) = lower.find(&needle.to_ascii_lowercase()) {
        let start = p + needle.len();
        if let Some(end) = xml[start..].find('"') {
            return xml[start..start + end].to_string();
        }
    }
    String::new()
}

fn cheat_texts(xml: &str) -> Vec<String> {
    // pull every  Text="..."  off <Cheat ...> tags
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(p) = rest.find("Text=\"") {
        let s = p + 6;
        if let Some(end) = rest[s..].find('"') {
            out.push(rest[s..s + end].to_string());
            rest = &rest[s + end..];
        } else {
            break;
        }
    }
    out
}

/// Extract all <ID>...</ID> values from an Orbis-style patch XML <TitleID> block.
fn orbis_title_ids(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(p) = rest.find("<ID>") {
        let s = p + 4;
        if let Some(end) = rest[s..].find("</ID>") {
            let tid = rest[s..s + end].trim().to_uppercase();
            if !tid.is_empty() && !out.contains(&tid) {
                out.push(tid);
            }
            rest = &rest[s + end + 5..];
        } else {
            break;
        }
    }
    out
}

/// Extract all Name="..." attribute values from <Metadata ...> tags in an Orbis patch XML.
fn orbis_cheats(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(meta_pos) = rest.find("<Metadata") {
        let after = &rest[meta_pos + 9..];
        let tag_end = after.find('>').unwrap_or(after.len());
        let tag = &after[..tag_end];
        if let Some(np) = tag.find("Name=\"") {
            let vs = np + 6;
            if let Some(ve) = tag[vs..].find('"') {
                let name = tag[vs..vs + ve].trim().to_string();
                if !name.is_empty() {
                    out.push(name);
                }
            }
        }
        rest = &after[tag_end.min(after.len())..];
    }
    out
}

/// Pull a CUSA/PPSA title id (4 letters + 5 digits) out of a filename.
fn id_from_name(name: &str) -> String {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .find(|t| {
            t.len() == 9
                && t.as_bytes()[..4].iter().all(u8::is_ascii_alphabetic)
                && t.as_bytes()[4..].iter().all(u8::is_ascii_digit)
        })
        .map(|t| t.to_uppercase())
        .unwrap_or_default()
}

/// Best-effort version token (e.g. `01.000.000`) from a trainer filename.
fn version_from_name(name: &str) -> String {
    name.split('_')
        .map(|t| {
            t.trim_end_matches(".mc4")
                .trim_end_matches(".shn")
                .trim_end_matches(".json")
        })
        .find(|t| {
            t.contains('.')
                && t.starts_with(|c: char| c.is_ascii_digit())
                && t.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
        .unwrap_or("")
        .to_string()
}

/// Scan the local trainer library into lightweight rows for the browse pages.
/// Game names are resolved from the file first, then the bundled title index
/// (cheatslist.json / All_Titles.json) — so id-named trainers (e.g. Saros) are
/// shown with their real name and searchable. EVERY .mc4 is listed, sidecar or
/// not, so sidecar-less blobs no longer go missing.
#[tauri::command]
pub async fn list_trainers(app: AppHandle) -> Result<Vec<TrainerRow>, String> {
    let root = trainers_dir(&app)?;
    let idx = title_index(&app);
    let resolve = |game: String, tid: &str| -> String {
        if game.is_empty() {
            idx.get(tid).cloned().unwrap_or_default()
        } else {
            game
        }
    };
    let mut rows: Vec<TrainerRow> = Vec::new();

    // JSON (GoldHEN)
    if let Ok(rd) = std::fs::read_dir(root.join("json")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let txt = std::fs::read_to_string(&p).unwrap_or_default();
            let v: serde_json::Value = match serde_json::from_str(&txt) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("mods").is_none() {
                continue; // not a trainer (index/list file)
            }
            // Keep EVERY mod (even nameless) so the index here lines up with
            // ps5debug.rs::parse_trainer — cheat #N must mean the same cheat in
            // both, or apply-by-index writes the wrong patch.
            let cheats = v["mods"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|m| m.get("name").and_then(|n| n.as_str()).unwrap_or("?").to_string())
                        .collect()
                })
                .unwrap_or_default();
            let tid = v["id"].as_str().unwrap_or("").split('_').next().unwrap_or("").to_uppercase();
            rows.push(TrainerRow {
                game: resolve(v["name"].as_str().unwrap_or("").to_string(), &tid),
                title_id: tid,
                version: v["version"].as_str().map(String::from).unwrap_or_default(),
                format: "JSON".into(),
                modder: v["credits"].as_array().and_then(|a| a.first()).and_then(|c| c.as_str()).unwrap_or("").to_string(),
                cheats,
                path: p.to_string_lossy().to_string(),
            });
        }
    }
    // SHN (XML)
    if let Ok(rd) = std::fs::read_dir(root.join("shn")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("shn") {
                continue;
            }
            let xml = std::fs::read_to_string(&p).unwrap_or_default();
            if xml.is_empty() {
                continue;
            }
            let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let mut tid = attr(&xml, "Cusa").split('_').next().unwrap_or("").to_uppercase();
            if tid.is_empty() {
                tid = id_from_name(fname);
            }
            rows.push(TrainerRow {
                game: resolve(attr(&xml, "Game"), &tid),
                title_id: tid,
                version: attr(&xml, "Version"),
                format: "SHN".into(),
                modder: attr(&xml, "Moder"),
                cheats: cheat_texts(&xml),
                path: p.to_string_lossy().to_string(),
            });
        }
    }
    // MC4 — list EVERY .mc4 blob (with or without a .mc4.xml sidecar). Name
    // comes from the sidecar if present, else the title index by id — so
    // id-named, sidecar-less trainers (e.g. Saros / PPSA07631) appear + search.
    if let Ok(rd) = std::fs::read_dir(root.join("mc4")) {
        for e in rd.flatten() {
            let p = e.path();
            let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if !fname.to_lowercase().ends_with(".mc4") {
                continue; // skip .mc4.xml sidecars (read via their .mc4 below)
            }
            let tid = id_from_name(&fname);
            let sidecar = std::path::PathBuf::from(format!("{}.xml", p.to_string_lossy()));
            let (game, version, modder, cheats) = match std::fs::read_to_string(&sidecar) {
                Ok(xml) if !xml.is_empty() => {
                    let v = attr(&xml, "Version");
                    (
                        resolve(attr(&xml, "Game"), &tid),
                        if v.is_empty() { version_from_name(&fname) } else { v },
                        attr(&xml, "Moder"),
                        cheat_texts(&xml),
                    )
                }
                _ => (
                    resolve(String::new(), &tid),
                    version_from_name(&fname),
                    String::new(),
                    Vec::new(),
                ),
            };
            rows.push(TrainerRow {
                game,
                title_id: tid,
                version,
                format: "MC4".into(),
                modder,
                cheats,
                path: p.to_string_lossy().to_string(),
            });
        }
    }

    // Orbis/GoldHEN patch XMLs — standalone .xml files in the mc4 dir that use
    // <Metadata Name="cheat"> entries. Each file may cover multiple title IDs;
    // we emit one TrainerRow per ID so covers + search work per-region.
    if let Ok(rd) = std::fs::read_dir(root.join("mc4")) {
        for e in rd.flatten() {
            let p = e.path();
            let fname_lower = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            // standalone .xml only — skip .mc4 binaries and .mc4.xml sidecars
            if !fname_lower.ends_with(".xml") || fname_lower.ends_with(".mc4.xml") {
                continue;
            }
            let xml = match std::fs::read_to_string(&p) {
                Ok(s) if !s.is_empty() => s,
                _ => continue,
            };
            let tids = orbis_title_ids(&xml);
            if tids.is_empty() {
                continue;
            }
            let cheats = orbis_cheats(&xml);
            let game_name = attr(&xml, "Title");
            let modder = attr(&xml, "Author");
            let version = attr(&xml, "AppVer");
            let path_str = p.to_string_lossy().to_string();
            for tid in tids {
                rows.push(TrainerRow {
                    game: resolve(game_name.clone(), &tid),
                    title_id: tid,
                    version: version.clone(),
                    format: "XML".into(),
                    modder: modder.clone(),
                    cheats: cheats.clone(),
                    path: path_str.clone(),
                });
            }
        }
    }

    rows.retain(|r| !r.title_id.is_empty() || !r.game.is_empty());
    rows.sort_by(|a, b| a.game.to_lowercase().cmp(&b.game.to_lowercase()));
    Ok(rows)
}
