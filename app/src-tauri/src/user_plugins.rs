//! User-installed plugins under `{app_data}/plugins/{id}/`: manifest parsing,
//! install from the marketplace repo, uninstall, and serving plugin files to the
//! webview over `mma-plugin://`.

use crate::proxy::{cors, proxy_client};
use crate::types::{AppError, AppResult};
use crate::{sidecar, storage};
use std::path::{Path, PathBuf};

const REPO_BASE: &str = "https://raw.githubusercontent.com/ccmdi/mma/master/plugins";

/// A plugin's declared sidecar binary (downloaded from GitHub Releases on install).
#[derive(serde::Serialize, Clone, specta::Type)]
pub struct PluginSidecar {
    name: String,
    version: String,
    /// Expected SHA-256 hex digest of the platform-specific zip archive.
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

/// Manifest form of a sidecar: the digest is keyed per platform (`sha256-{platform_tag}`).
#[derive(serde::Deserialize)]
struct RawSidecar {
    name: String,
    version: String,
    #[serde(flatten)]
    digests: std::collections::HashMap<String, serde_json::Value>,
}

impl<'de> serde::Deserialize<'de> for PluginSidecar {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = RawSidecar::deserialize(d)?;
        let sha256 = sidecar::platform_tag().ok().and_then(|p| {
            raw.digests
                .get(&format!("sha256-{p}"))?
                .as_str()
                .map(str::to_string)
        });
        Ok(PluginSidecar {
            name: raw.name,
            version: raw.version,
            sha256,
        })
    }
}

/// Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`.
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginManifest {
    id: String,
    name: String,
    description: String,
    icon: String,
    main: String,
    version: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    experimental: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    coming_soon: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sidecar: Option<PluginSidecar>,
}

impl Default for PluginManifest {
    fn default() -> Self {
        PluginManifest {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            icon: String::new(),
            main: "index.js".to_string(),
            version: String::new(),
            experimental: false,
            coming_soon: false,
            min_app_version: None,
            sidecar: None,
        }
    }
}

impl PluginManifest {
    /// Folder name stands in for a missing id/name.
    fn with_fallback(mut self, fallback: &str) -> Self {
        if self.id.is_empty() {
            self.id = fallback.to_string();
        }
        if self.name.is_empty() {
            self.name = fallback.to_string();
        }
        self
    }
}

/// Plugin ids, sidecar names, and sidecar commands all end up in paths, argv, or URL
/// paths, so they share one conservative charset.
fn validate_ident(kind: &str, value: &str) -> AppResult<()> {
    let ok = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(())
        .ok_or_else(|| AppError(format!("Invalid {kind}: {value}")))
}

pub(crate) fn validate_plugin_id(id: &str) -> AppResult<()> {
    validate_ident("plugin id", id)
}

pub(crate) fn validate_sidecar_name(name: &str) -> AppResult<()> {
    validate_ident("sidecar name", name)
}

pub(crate) fn validate_sidecar_command(command: &str) -> AppResult<()> {
    validate_ident("sidecar command", command)
}

fn plugins_dir() -> AppResult<PathBuf> {
    Ok(storage::app_data_dir()?.join("plugins"))
}

fn read_manifest(dir: &Path) -> Option<PluginManifest> {
    let path = dir.join("manifest.json");
    let content = std::fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<PluginManifest>(&content) {
        Ok(m) => Some(m.with_fallback(dir.file_name()?.to_str()?)),
        Err(e) => {
            log::warn!("Invalid manifest {}: {e}", path.display());
            None
        }
    }
}

/// Manifests of every installed plugin.
#[tauri::command]
#[specta::specta]
pub fn list_user_plugins() -> Vec<PluginManifest> {
    let Ok(entries) = plugins_dir().and_then(|d| Ok(std::fs::read_dir(d)?)) else {
        return vec![];
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| read_manifest(&p))
        .collect()
}

fn fetch(url: &str, what: &str) -> AppResult<bytes::Bytes> {
    Ok(proxy_client()
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch {what}: {e}"))?
        .bytes()?)
}

/// Install a plugin from the marketplace repo: its `manifest.json` plus the main JS file.
#[tauri::command]
#[specta::specta]
pub fn install_plugin(id: String) -> AppResult<PluginManifest> {
    validate_plugin_id(&id)?;
    let dir = plugins_dir()?.join(&id);
    std::fs::create_dir_all(&dir)?;

    let manifest_bytes = fetch(&format!("{REPO_BASE}/{id}/manifest.json"), "manifest")?;
    std::fs::write(dir.join("manifest.json"), &manifest_bytes)?;
    let manifest: PluginManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Invalid manifest JSON: {e}"))?;

    let main = &manifest.main;
    if main.contains("..") || main.contains('/') || main.contains('\\') {
        return Err(AppError(format!("Invalid main field in manifest: {main}")));
    }
    std::fs::write(dir.join(main), fetch(&format!("{REPO_BASE}/{id}/{main}"), main)?)?;

    let mut manifest = manifest.with_fallback(&id);
    manifest.id = id;
    Ok(manifest)
}

/// Delete a plugin's directory.
#[tauri::command]
#[specta::specta]
pub fn uninstall_plugin(id: String) -> AppResult<()> {
    validate_plugin_id(&id)?;
    let dir = plugins_dir()?.join(&id);
    // A live sidecar holds the directory open on Windows, so delete under the
    // plugin's process lock with everything stopped.
    sidecar::with_plugin_stopped(&id, || {
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    })?;
    Ok(())
}

/// `mma-plugin://` handler: a file from inside the plugins dir, nothing outside it.
pub(crate) fn serve_file(path: &str) -> tauri::http::Response<Vec<u8>> {
    let status = |code: u16| tauri::http::Response::builder().status(code).body(vec![]).unwrap();
    let root = plugins_dir().unwrap_or_default();
    let canonical = root
        .join(path.trim_start_matches('/'))
        .canonicalize()
        .unwrap_or_default();
    if !canonical.starts_with(&root) {
        return status(403);
    }
    let Ok(data) = std::fs::read(&canonical) else {
        return status(404);
    };
    let mime = match canonical.extension().and_then(|e| e.to_str()) {
        Some("js" | "mjs") => "application/javascript",
        _ => "application/octet-stream",
    };
    cors().header("Content-Type", mime).body(data).unwrap()
}
