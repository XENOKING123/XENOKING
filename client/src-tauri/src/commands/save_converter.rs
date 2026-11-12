//! Save Converter (PS5 ⇄ PC) — Tauri commands.
//!
//! Thin wrappers only: the game database, the planning and the codecs all
//! live in `ps5upload_core::save_convert`, where they're unit-tested
//! without a webview. These commands just move the work onto the blocking
//! pool (a conversion reads and writes whole files) and flatten errors to
//! strings for the renderer.
//!
//! Everything here is local-disk work — no console connection is needed
//! or used.

use ps5upload_core::save_convert::{
    self, ConvertReport, ConvertRequest, GameProfile, InspectReport, InspectRequest,
};

/// The whole game database, sorted by name.
#[tauri::command]
pub async fn save_converter_games() -> Result<Vec<GameProfile>, String> {
    save_convert::games()
        .map(|games| games.to_vec())
        .map_err(|e| format!("{e:#}"))
}

/// Dry run: locate the save under the picked folder and report which
/// files would be converted, what's missing, and why it can't proceed
/// (if it can't). Writes nothing.
#[tauri::command]
pub async fn save_converter_inspect(req: InspectRequest) -> Result<InspectReport, String> {
    tokio::task::spawn_blocking(move || save_convert::inspect(&req))
        .await
        .map_err(|e| format!("save_converter_inspect join: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

/// Convert a save into a new folder under `req.output_dir`. The input is
/// never modified and nothing existing is overwritten.
#[tauri::command]
pub async fn save_converter_convert(req: ConvertRequest) -> Result<ConvertReport, String> {
    tokio::task::spawn_blocking(move || save_convert::convert(&req))
        .await
        .map_err(|e| format!("save_converter_convert join: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

/// Open a converted-save folder in the OS file manager.
#[tauri::command]
pub async fn save_converter_reveal(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    super::reveal::reveal(&path)
}
