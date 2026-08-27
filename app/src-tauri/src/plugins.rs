//! Native command surface for built-in plugins, namespaced by plugin id.
//!
//! Vali runs in-process (vali-rs crate dep, no sidecar). The data root is resolved
//! through Vali's own chain (VALI_DOWNLOAD_FOLDER / application-settings.json /
//! ProgramData), so data is shared with a standalone Vali install. Progress is
//! streamed to the frontend as `vali-progress` events.

use crate::types::{AppError, AppResult};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tokio::task;
use vali_data::paths;
use vali_generate::download;
use vali_generate::export;
use vali_generate::names;
use vali_generate::{generate_output, prepare, CancelToken, GeoMapLocation, ProgressEvent};

pub struct ValiState {
    cancel: Mutex<Option<CancelToken>>,
}

impl ValiState {
    pub fn new() -> Self {
        Self {
            cancel: Mutex::new(None),
        }
    }
}

#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ValiLocation {
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pano_id: Option<String>,
    pub tags: Vec<String>,
}

impl From<GeoMapLocation> for ValiLocation {
    fn from(l: GeoMapLocation) -> Self {
        ValiLocation {
            lat: l.lat,
            lng: l.lng,
            heading: l.heading,
            zoom: l.zoom,
            pitch: l.pitch,
            pano_id: l.pano_id,
            tags: l.extra.map(|e| e.tags).unwrap_or_default(),
        }
    }
}

#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[tauri_specta(event_name = "vali-progress")]
pub enum ValiProgress {
    WorkItems {
        total: u32,
    },
    WorkItemDone {
        country_code: String,
        subdivision_code: Option<String>,
        done: u32,
        total: u32,
    },
    CountryDownloadStarted {
        country_code: String,
        files: u32,
        bytes: f64,
        updates: bool,
    },
    FileDownloaded {
        country_code: String,
        name: String,
        bytes: f64,
    },
}

impl From<ProgressEvent> for ValiProgress {
    fn from(e: ProgressEvent) -> Self {
        match e {
            ProgressEvent::WorkItems { total } => ValiProgress::WorkItems {
                total: total as u32,
            },
            ProgressEvent::WorkItemDone {
                country_code,
                subdivision_code,
                done,
                total,
            } => ValiProgress::WorkItemDone {
                country_code,
                subdivision_code,
                done: done as u32,
                total: total as u32,
            },
            ProgressEvent::CountryDownloadStarted {
                country_code,
                files,
                bytes,
                updates,
            } => ValiProgress::CountryDownloadStarted {
                country_code,
                files: files as u32,
                bytes: bytes as f64,
                updates,
            },
            ProgressEvent::FileDownloaded {
                country_code,
                name,
                bytes,
            } => ValiProgress::FileDownloaded {
                country_code,
                name,
                bytes: bytes as f64,
            },
        }
    }
}

fn emit_progress(e: ProgressEvent) {
    crate::emit_event(ValiProgress::from(e));
}

fn data_root() -> AppResult<PathBuf> {
    paths::data_root().map_err(|e| AppError(format!("{e:#}")))
}

/// Generate locations from a Vali map definition (JSON/JSONC text). Missing country
/// data is auto-downloaded like the Vali CLI. Returns the generated locations.
#[tauri::command]
#[specta::specta]
pub async fn vali_generate(
    state: tauri::State<'_, ValiState>,
    definition: String,
) -> AppResult<Vec<ValiLocation>> {
    let token = CancelToken::new();
    *state.cancel.lock().unwrap() = Some(token.clone());
    let result = task::spawn_blocking(move || {
        let def: vali_core::MapDefinition = json5::from_str(&definition)
            .map_err(|e| AppError(format!("The map definition is not valid JSON: {e}")))?;
        let prepared = prepare(&def).map_err(AppError)?;
        let output = generate_output(
            &prepared,
            &data_root()?,
            false,
            Some(&emit_progress),
            Some(&token),
        )
        .map_err(|e| AppError(format!("{e:#}")))?;
        Ok(output.records.into_iter().map(ValiLocation::from).collect())
    })
    .await
    .map_err(|e| AppError(format!("vali generate task failed: {e}")))?;
    *state.cancel.lock().unwrap() = None;
    result
}

/// Download Vali coverage data. `country` = code/continent alias/None for all.
#[tauri::command]
#[specta::specta]
pub async fn vali_download(
    state: tauri::State<'_, ValiState>,
    country: Option<String>,
    full: bool,
    updates: bool,
) -> AppResult<()> {
    let token = CancelToken::new();
    *state.cancel.lock().unwrap() = Some(token.clone());
    let result = task::spawn_blocking(move || {
        download::download_files(
            &data_root()?,
            country.as_deref(),
            full,
            updates,
            Some(&emit_progress),
            Some(&token),
        )
        .map_err(|e| AppError(format!("{e:#}")))
    })
    .await
    .map_err(|e| AppError(format!("vali download task failed: {e}")))?;
    *state.cancel.lock().unwrap() = None;
    result
}

/// Download exactly the countries `vali_data_status` reports as behind. No-op when nothing
/// is stale, so the caller can fire it without checking first.
#[tauri::command]
#[specta::specta]
pub async fn vali_download_stale(state: tauri::State<'_, ValiState>) -> AppResult<()> {
    let token = CancelToken::new();
    *state.cancel.lock().unwrap() = Some(token.clone());
    let result = task::spawn_blocking(move || {
        let root = data_root()?;
        let stale = download::stale_countries(&root, Duration::from_secs(30), Some(&token))
            .map_err(|e| AppError(format!("{e:#}")))?;
        let codes: Vec<String> = stale.into_iter().map(|c| c.country_code).collect();
        if codes.is_empty() {
            return Ok(());
        }
        download::download_codes(
            &root,
            &codes,
            false,
            false,
            Some(&emit_progress),
            Some(&token),
        )
        .map_err(|e| AppError(format!("{e:#}")))
    })
    .await
    .map_err(|e| AppError(format!("vali download task failed: {e}")))?;
    *state.cancel.lock().unwrap() = None;
    result
}

/// Cancel an in-flight vali generate or download.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn vali_cancel(state: tauri::State<'_, ValiState>) {
    if let Some(token) = state.cancel.lock().unwrap().as_ref() {
        token.cancel();
    }
}

/// Subdivision weights for a country (JSON text, same shape as `vali subdivisions`).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn vali_subdivisions(country: String) -> AppResult<String> {
    export::subdivisions_export(&country, false).map_err(AppError)
}

/// How far behind one country's downloaded coverage data is.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ValiCountryStatus {
    pub country_code: String,
    pub files: u32,
    pub bytes: f64,
}

/// Countries whose downloaded coverage data is older than the remote copy. Object metadata
/// only -- nothing is fetched. Errors while offline, which callers should read as "unknown"
/// rather than "up to date".
#[tauri::command]
#[specta::specta]
pub async fn vali_data_status() -> AppResult<Vec<ValiCountryStatus>> {
    task::spawn_blocking(move || {
        let stale = download::stale_countries(&data_root()?, Duration::from_secs(30), None)
            .map_err(|e| AppError(format!("{e:#}")))?;
        Ok(stale
            .into_iter()
            .map(|c| ValiCountryStatus {
                country_code: c.country_code,
                files: c.files as u32,
                bytes: c.bytes as f64,
            })
            .collect())
    })
    .await
    .map_err(|e| AppError(format!("vali status task failed: {e}")))?
}

/// Country codes Vali has coverage data for, i.e. the set `vali download` iterates
/// when no country is given. Display names are the caller's job.
#[tauri::command]
#[specta::specta]
pub fn vali_countries() -> Vec<String> {
    names::country_names()
        .iter()
        .map(|(code, _)| code.to_string())
        .collect()
}

#[cfg(test)]
#[path = "plugins.test.rs"]
mod tests;
