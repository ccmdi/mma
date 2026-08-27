//! Self-update against a caller-chosen release.
//!
//! The frontend picks which GitHub release to install (stable vs pre-release) and passes that
//! release's own `latest.json` here. `tauri-plugin-updater`'s JS `check()` cannot override the
//! endpoint -- only the Rust builder can -- so the check and install both live on this side.

use std::sync::Mutex;

use tauri_plugin_updater::{Update, UpdaterExt};

use crate::types::{AppError, AppResult};

/// The update found by [`update_check`], held until [`update_install`] consumes it.
static PENDING: Mutex<Option<Update>> = Mutex::new(None);

/// Download progress, emitted per chunk. `total` is absent when the server sends no length.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "update-progress")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailable {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

/// Look for an update at `endpoint` (a release's `latest.json`). `None` means the announced
/// version is not newer than the running one, which is the plugin's own comparison.
#[tauri::command]
#[specta::specta]
pub async fn update_check(endpoint: String) -> AppResult<Option<UpdateAvailable>> {
    let app = crate::app_handle().ok_or_else(|| AppError("app not ready".into()))?;
    let url = endpoint.parse().map_err(|e| AppError(format!("{e}")))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| AppError(e.to_string()))?
        .build()
        .map_err(|e| AppError(e.to_string()))?;

    let update = updater.check().await.map_err(|e| AppError(e.to_string()))?;
    let found = update.as_ref().map(|u| UpdateAvailable {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *PENDING.lock()? = update;
    Ok(found)
}

/// Download and install whatever the last [`update_check`] found. The installer replaces the
/// running app, so nothing after this is guaranteed to run -- the caller saves its state first.
#[tauri::command]
#[specta::specta]
pub async fn update_install() -> AppResult<()> {
    let update = PENDING
        .lock()?
        .take()
        .ok_or_else(|| AppError("no update pending".into()))?;

    let mut downloaded = 0u64;
    let res = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                crate::emit_event(UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await;

    // A failed install leaves the update still pending, so the retry button does not have to
    // re-run the whole check.
    match res {
        Ok(()) => Ok(()),
        Err(e) => {
            *PENDING.lock()? = Some(update);
            Err(AppError(e.to_string()))
        }
    }
}
