//! App-level file and data-location Tauri commands.

use super::*;
use crate::types::AppResult;
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

/// Write text to a named temp file (`mma_{name}`) and return its path. Lets JS hand
/// large payloads over by file instead of IPC serialization.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn write_temp_file(name: String, content: String) -> AppResult<String> {
    let path = env::temp_dir().join(format!("mma_{name}"));
    fs::write(&path, &content)?;
    Ok(path.to_string_lossy().to_string())
}

/// Read a file as UTF-8 text (temp files, plugin sources).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn read_file(path: String) -> AppResult<String> {
    Ok(fs::read_to_string(&path)?)
}

#[tauri::command]
#[specta::specta]
pub fn get_app_data_dir() -> AppResult<String> {
    app_data_dir().map(|p| p.to_string_lossy().into_owned())
}

/// The active and default data-folder paths, plus whether a custom override is in effect.
#[derive(serde::Serialize, specta::Type)]
pub struct DataLocation {
    path: String,
    /// OS default, ignoring any override -- backs the "reset" affordance.
    default_path: String,
    is_custom: bool,
}

#[tauri::command]
#[specta::specta]
pub fn get_data_location() -> AppResult<DataLocation> {
    let path = app_data_dir()?;
    let default_path = default_data_dir()?;
    Ok(DataLocation {
        is_custom: path != default_path,
        path: path.to_string_lossy().into_owned(),
        default_path: default_path.to_string_lossy().into_owned(),
    })
}

/// Set (`Some`) or clear (`None`) the data-folder override. Takes effect after relaunch
/// and does not move existing data.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn set_data_location(path: Option<String>) -> AppResult<()> {
    set_data_location_override(path.as_deref().map(Path::new))
}

/// Hand a path to the OS shell (file explorer / default handler).
pub(super) fn os_open(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    Command::new(program).arg(path).spawn()?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn open_data_folder() -> AppResult<()> {
    os_open(&app_data_dir()?)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn open_log_file(app: tauri::AppHandle) -> AppResult<()> {
    use tauri::Manager;
    os_open(&app.path().app_log_dir()?.join("mma.log"))
}
