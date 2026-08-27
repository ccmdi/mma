//! Where things live on disk: app data, the user's data-location override, temp, DB and Arrow paths.

use crate::types::{AppError, AppResult};
use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

/// True when running under e2e tests or with `MMA_TEST_DB` set.
/// Controls which database file and Arrow directory are used, keeping
/// test data isolated from production.
pub(super) fn is_test_mode() -> bool {
    cfg!(feature = "e2e") || env::var("MMA_TEST_DB").is_ok()
}

pub(super) fn db_filename() -> &'static str {
    if is_test_mode() {
        "mma_test.db"
    } else {
        "mma.db"
    }
}

/// Process-constant directories, resolved once at startup. Lets every path helper
/// (db, arrow, plugins, temp) be zero-arg instead of threading an `AppHandle`
/// through functions whose only use for it is path resolution.
pub(super) static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(super) static DEFAULT_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(super) static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(super) static TEMP_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Bootstrap pointer file (in `app_config_dir`, never relocatable) naming the
/// user's chosen data folder. Absent/empty means "use the OS default".
pub(super) const DATA_LOCATION_FILE: &str = "data_location.txt";

/// Resolve and cache the data/temp directories. Called once from `setup()`,
/// before anything touches disk.
///
/// The effective data dir is the OS default unless a [`DATA_LOCATION_FILE`]
/// pointer in `app_config_dir` overrides it. Test mode always uses the default.
pub(crate) fn init_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppResult<()> {
    let default_dir = app.path().app_data_dir().map_err(AppError::from)?;
    let config_dir = app.path().app_config_dir().map_err(AppError::from)?;
    let _ = DEFAULT_DATA_DIR.set(default_dir.clone());
    let _ = CONFIG_DIR.set(config_dir.clone());
    let _ = TEMP_DIR.set(app.path().temp_dir().map_err(AppError::from)?);

    let effective = if is_test_mode() {
        default_dir
    } else {
        read_data_location_override(&config_dir).unwrap_or(default_dir)
    };
    let _ = APP_DATA_DIR.set(effective);
    Ok(())
}

/// The effective app data directory (default or user override). Errors if
/// `init_paths` has not run.
pub(crate) fn app_data_dir() -> AppResult<PathBuf> {
    APP_DATA_DIR
        .get()
        .cloned()
        .ok_or_else(|| AppError::from("app paths not initialized".to_string()))
}

/// The OS default data directory, ignoring any override. Used to reset the
/// data-folder setting and to tell the UI what "default" resolves to.
pub(crate) fn default_data_dir() -> AppResult<PathBuf> {
    DEFAULT_DATA_DIR
        .get()
        .cloned()
        .ok_or_else(|| AppError::from("app paths not initialized".to_string()))
}

/// Parse the raw pointer-file contents into an override path. Pure: trims
/// whitespace, treats empty as "no override". Does not touch disk.
pub(super) fn parse_data_location(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Read and validate the data-folder override from `<config_dir>/data_location.txt`.
/// Returns `None` (falling back to default) if the file is absent, empty, or names
/// a folder that cannot be created/used.
pub(super) fn read_data_location_override(config_dir: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(config_dir.join(DATA_LOCATION_FILE)).ok()?;
    let path = parse_data_location(&raw)?;
    if let Err(e) = fs::create_dir_all(&path) {
        log::warn!(
            "configured data folder '{}' is unusable ({e}); using default",
            path.display()
        );
        return None;
    }
    Some(path)
}

/// Persist (or clear) the data-folder override. `Some(path)` validates the folder
/// is creatable then writes the pointer; `None` removes it (revert to default).
/// Takes effect on next launch -- the active paths are fixed for the process.
pub(crate) fn set_data_location_override(path: Option<&Path>) -> AppResult<()> {
    let config_dir = CONFIG_DIR
        .get()
        .ok_or_else(|| AppError::from("app paths not initialized".to_string()))?;
    fs::create_dir_all(config_dir)?;
    let file = config_dir.join(DATA_LOCATION_FILE);
    match path {
        Some(p) => {
            fs::create_dir_all(p)?;
            fs::write(&file, p.to_string_lossy().as_bytes())?;
        }
        None => {
            let _ = fs::remove_file(&file);
        }
    }
    Ok(())
}

/// The OS temp directory (resolved via Tauri at startup).
pub(crate) fn temp_dir() -> AppResult<PathBuf> {
    TEMP_DIR
        .get()
        .cloned()
        .ok_or_else(|| AppError::from("app paths not initialized".to_string()))
}

pub(crate) fn db_path() -> AppResult<PathBuf> {
    Ok(app_data_dir()?.join(db_filename()))
}

/// Root directory for all Arrow IPC files (`arrow/` or `arrow_test/`).
/// Created on first access.
pub(crate) fn arrow_dir() -> AppResult<PathBuf> {
    let subdir = if is_test_mode() {
        "arrow_test"
    } else {
        "arrow"
    };
    let dir = app_data_dir()?.join(subdir);
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Path to a map's base Arrow IPC snapshot: `<arrow_dir>/<map_id>.arrow`.
pub(crate) fn arrow_path(map_id: &str) -> AppResult<PathBuf> {
    Ok(arrow_dir()?.join(format!("{map_id}.arrow")))
}

/// Path to a map's uncommitted delta file: `<arrow_dir>/<map_id>_delta.arrow`.
/// Contains overlay mutations not yet baked into the base snapshot.
pub(crate) fn arrow_delta_path(map_id: &str) -> AppResult<PathBuf> {
    Ok(arrow_dir()?.join(format!("{map_id}_delta.arrow")))
}

/// Directory holding a map's per-commit VCS delta files. Created on first access.
pub(crate) fn commit_dir(map_id: &str) -> AppResult<PathBuf> {
    let dir = arrow_dir()?.join("commits").join(map_id);
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Path to a single commit's Arrow delta file: `<arrow_dir>/commits/<map_id>/<commit_id>.arrow`.
pub(crate) fn commit_delta_path(map_id: &str, commit_id: &str) -> AppResult<PathBuf> {
    Ok(commit_dir(map_id)?.join(format!("{commit_id}.arrow")))
}
