//! Tauri command layer and URI scheme proxies for the MMA desktop app.
//!
//! This is the application entry point. It registers all IPC commands (via tauri-specta),
//! custom URI scheme handlers (svtile, gmaps, googl, mma-buf, mma-plugin), and Tauri plugins.
//! No business logic lives here -- commands delegate to `location_store`, `map_meta`, `import`, etc.

use crate::types::{AppError, AppResult};
use tauri::Manager;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(debug_assertions)]
pub fn promote_serialize_bindings(path: &std::path::Path) {
    let src = std::fs::read_to_string(path).expect("read bindings");
    let mut out = String::with_capacity(src.len());
    for line in src.lines() {
        // Drop union alias lines: `export type Foo = Foo_Serialize | Foo_Deserialize;`
        if line.starts_with("export type ")
            && line.contains("_Serialize | ")
            && line.contains("_Deserialize;")
        {
            continue;
        }
        out.push_str(&line.replace("_Serialize", ""));
        out.push('\n');
    }
    std::fs::write(path, out.as_bytes()).expect("write bindings");
}

mod arrow_bridge;
mod arrow_migrate;
mod selections;
mod spatial;
mod storage;
mod types;
mod util;
#[macro_use]
mod location_store;
mod borders;
mod export;
mod geocoder;
mod import;
mod map_meta;
mod plugins;
mod review;
mod seen;
mod sidecar;
mod vcs;
mod vcs_delta;

#[cfg(feature = "web-serve")]
pub mod serve;

/// App handle, captured once in `setup()`. Private: the only capability exposed is
/// event emission via [`emit_event`], so commands don't carry an `AppHandle`
/// parameter just to emit.
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Emit an app-wide event to all windows. No-op before setup completes.
pub(crate) fn emit_event(event: &str, payload: impl serde::Serialize + Clone) {
    use tauri::Emitter;
    // Browser tabs aren't app webviews, so app.emit can't reach them — bridge the
    // event to the web-serve SSE channel (no-op when no browser is connected).
    #[cfg(feature = "web-serve")]
    if let Ok(value) = serde_json::to_value(&payload) {
        tauri_plugin_webserve::forward_event(event, value);
    }
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(event, payload);
    }
}

/// Write arbitrary text content to a named temp file (`mma_{name}`). Returns the path.
/// Used by JS to pass large payloads via file instead of IPC serialization.
#[tauri::command]
#[specta::specta]
fn write_temp_file(name: String, content: String) -> AppResult<String> {
    let path = std::env::temp_dir().join(format!("mma_{name}"));
    std::fs::write(&path, &content)?;
    Ok(path.to_string_lossy().to_string())
}

/// Read a file from disk as UTF-8 text. Used by JS to read temp files and plugin sources.
#[tauri::command]
#[specta::specta]
fn read_file(path: String) -> AppResult<String> {
    std::fs::read_to_string(&path).map_err(AppError::from)
}

/// Return the platform-specific app data directory path (e.g., `%LOCALAPPDATA%/app.map-making.local`).
#[tauri::command]
#[specta::specta]
fn get_app_data_dir() -> AppResult<String> {
    storage::app_data_dir().map(|p| p.to_string_lossy().into_owned())
}

/// The active and default data-folder paths, plus whether a custom override is in effect.
#[derive(serde::Serialize, specta::Type)]
struct DataLocation {
    /// Folder currently in use this session (default or override).
    path: String,
    /// OS default, ignoring any override -- used for the "reset" affordance.
    default_path: String,
    /// True when `path` differs from the OS default.
    is_custom: bool,
}

/// Report where map data is currently stored.
#[tauri::command]
#[specta::specta]
fn get_data_location() -> AppResult<DataLocation> {
    let path = storage::app_data_dir()?;
    let default_path = storage::default_data_dir()?;
    Ok(DataLocation {
        is_custom: path != default_path,
        path: path.to_string_lossy().into_owned(),
        default_path: default_path.to_string_lossy().into_owned(),
    })
}

/// Set (`Some`) or clear (`None`) the data-folder override. Takes effect after relaunch.
/// Does not move existing data -- the caller warns the user.
#[tauri::command]
#[specta::specta]
fn set_data_location(path: Option<String>) -> AppResult<()> {
    storage::set_data_location(path.as_deref().map(std::path::Path::new))
}

/// Open the app data directory in the OS file explorer.
#[tauri::command]
#[specta::specta]
fn open_data_folder() -> AppResult<()> {
    let dir = storage::app_data_dir()?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&dir).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dir).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&dir).spawn()?;
    }
    Ok(())
}

/// Open the current log file in the OS default handler.
#[tauri::command]
#[specta::specta]
fn open_log_file(app: tauri::AppHandle) -> AppResult<()> {
    let path = app.path().app_log_dir()?.join("mma.log");
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&path).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()?;
    }
    Ok(())
}

/// A plugin's declared sidecar binary (downloaded from GitHub Releases on install).
#[derive(serde::Serialize, Clone, specta::Type)]
struct PluginSidecar {
    name: String,
    version: String,
    /// Expected SHA-256 hex digest of the platform-specific zip archive.
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

/// Metadata for a user-installed plugin, read from `plugins/{id}/manifest.json`.
#[derive(serde::Serialize, specta::Type)]
struct PluginManifest {
    id: String,
    name: String,
    description: String,
    icon: String,
    main: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sidecar: Option<PluginSidecar>,
}

/// Parse the optional `sidecar` object out of a manifest JSON value.
fn parse_sidecar(val: &serde_json::Value) -> Option<PluginSidecar> {
    let s = val.get("sidecar")?;
    let sha256 = sidecar::platform_tag().ok().and_then(|p| {
        s.get(format!("sha256-{p}"))?
            .as_str()
            .map(|s| s.to_string())
    });
    Some(PluginSidecar {
        name: s.get("name")?.as_str()?.to_string(),
        version: s.get("version")?.as_str()?.to_string(),
        sha256,
    })
}

fn validate_sidecar_name(name: &str) -> AppResult<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError(format!("Invalid sidecar name: {name}")));
    }
    Ok(())
}

/// Scan the `plugins/` directory under app data and return manifests for all installed plugins.
#[tauri::command]
#[specta::specta]
fn list_user_plugins() -> Vec<PluginManifest> {
    let dir = match storage::app_data_dir() {
        Ok(d) => d.join("plugins"),
        Err(_) => return vec![],
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };
    let mut plugins = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if let Ok(content) = std::fs::read_to_string(&manifest_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let folder_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let id = val
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or(folder_name.clone());
                let name = val
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or(folder_name);
                let description = val
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let icon = val
                    .get("icon")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let main = val
                    .get("main")
                    .and_then(|v| v.as_str())
                    .unwrap_or("index.js")
                    .to_string();
                let version = val
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let sidecar = parse_sidecar(&val);
                plugins.push(PluginManifest {
                    id,
                    name,
                    description,
                    icon,
                    main,
                    version,
                    sidecar,
                });
            }
        }
    }
    plugins
}

/// Base URL for the plugin marketplace repository on GitHub.
const PLUGIN_REPO_BASE: &str = "https://raw.githubusercontent.com/ccmdi/mma/master/plugins";

pub(crate) fn validate_plugin_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError(format!("Invalid plugin id: {id}")));
    }
    Ok(())
}

/// Download a plugin from the GitHub plugin repository and install it to the local plugins directory.
/// Fetches `manifest.json` and the main JS file specified in the manifest.
#[tauri::command]
#[specta::specta]
fn install_plugin(id: String) -> AppResult<PluginManifest> {
    validate_plugin_id(&id)?;
    let dir = storage::app_data_dir()?.join("plugins").join(&id);
    std::fs::create_dir_all(&dir)?;

    let manifest_url = format!("{PLUGIN_REPO_BASE}/{id}/manifest.json");
    let manifest_bytes = proxy_client()
        .get(&manifest_url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch manifest: {e}"))?
        .bytes()?;
    std::fs::write(dir.join("manifest.json"), &manifest_bytes)?;

    let val: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Invalid manifest JSON: {e}"))?;
    let main = val
        .get("main")
        .and_then(|v| v.as_str())
        .unwrap_or("index.js");
    if main.contains("..") || main.contains('/') || main.contains('\\') {
        return Err(AppError(format!("Invalid main field in manifest: {main}")));
    }

    let main_url = format!("{PLUGIN_REPO_BASE}/{id}/{main}");
    let main_bytes = proxy_client()
        .get(&main_url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch {main}: {e}"))?
        .bytes()?;
    std::fs::write(dir.join(main), &main_bytes)?;

    let name = val
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let description = val
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let icon = val
        .get("icon")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sidecar = parse_sidecar(&val);

    Ok(PluginManifest {
        id,
        name,
        description,
        icon,
        main: main.to_string(),
        version,
        sidecar,
    })
}

/// Remove a plugin by deleting its directory from the local plugins folder.
#[tauri::command]
#[specta::specta]
fn uninstall_plugin(id: String) -> AppResult<()> {
    validate_plugin_id(&id)?;
    let dir = storage::app_data_dir()?.join("plugins").join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

fn build_http_client(follow_redirects: bool) -> reqwest::blocking::Client {
    let redirect = if follow_redirects {
        reqwest::redirect::Policy::default()
    } else {
        reqwest::redirect::Policy::none()
    };
    reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .redirect(redirect)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("failed to build http client")
}

/// Follows redirects (svtile tiles, gmaps RPC).
fn proxy_client() -> &'static reqwest::blocking::Client {
    static C: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| build_http_client(true))
}

/// Does NOT follow redirects, so the `Location` header is readable (googl).
fn resolve_client() -> &'static reqwest::blocking::Client {
    static C: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| build_http_client(false))
}

/// Build a 502 error response with CORS headers for failed proxy requests.
fn proxy_error(msg: String) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(502)
        .header("Access-Control-Allow-Origin", "*")
        .body(msg.into_bytes())
        .unwrap()
}

/// Relays an upstream response body + content-type back to the webview with CORS.
fn relay(resp: reqwest::blocking::Response, default_ct: &str) -> tauri::http::Response<Vec<u8>> {
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(default_ct)
        .to_string();
    match resp.bytes() {
        Ok(body) => tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", content_type)
            .header("Access-Control-Allow-Origin", "*")
            .body(body.to_vec())
            .unwrap(),
        Err(e) => proxy_error(format!("read error: {e}")),
    }
}

/// svtile: StreetView photosphere tiles via lh3.ggpht.com.
pub(crate) fn fetch_svtile(url: &str) -> tauri::http::Response<Vec<u8>> {
    match proxy_client().get(url).send() {
        Ok(resp) => {
            let mut out = relay(resp, "image/jpeg");
            if let Ok(v) = "private, max-age=86400".parse() {
                out.headers_mut()
                    .insert(tauri::http::header::CACHE_CONTROL, v);
            }
            out
        }
        Err(e) => proxy_error(format!("svtile fetch error: {e}")),
    }
}

/// gmaps: forward a request (POST batchexecute etc.) to www.google.com.
pub(crate) fn proxy_gmaps(
    method: reqwest::Method,
    url: &str,
    content_type: String,
    user_agent: String,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    match proxy_client()
        .request(method, url)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .header(reqwest::header::USER_AGENT, user_agent)
        .body(body)
        .send()
    {
        Ok(resp) => relay(resp, "text/plain"),
        Err(e) => proxy_error(format!("gmaps fetch error: {e}")),
    }
}

/// googl: resolve a goo.gl / maps.app.goo.gl short link by reading its redirect
/// `Location` header; returns the target URL as a JSON string.
pub(crate) fn resolve_googl(id: &str, mapsapp: bool) -> tauri::http::Response<Vec<u8>> {
    let url = if mapsapp {
        format!("https://maps.app.goo.gl/{id}")
    } else {
        format!("https://goo.gl/maps/{id}")
    };
    match resolve_client().get(&url).send() {
        Ok(resp) => match resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
        {
            Some(location) => tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "application/json")
                .header("Access-Control-Allow-Origin", "*")
                .body(
                    serde_json::to_string(location)
                        .unwrap_or_default()
                        .into_bytes(),
                )
                .unwrap(),
            None => tauri::http::Response::builder()
                .status(404)
                .header("Access-Control-Allow-Origin", "*")
                .body(Vec::new())
                .unwrap(),
        },
        Err(e) => proxy_error(format!("googl fetch error: {e}")),
    }
}

/// Application entry point. Configures panic logging, URI scheme protocols, Tauri plugins,
/// the IPC command handler (with specta binding generation in debug builds), and window setup.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
static START_INSTANT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
static STARTUP_MS: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

#[tauri::command]
#[specta::specta]
fn app_ready() -> u32 {
    *STARTUP_MS.get_or_init(|| {
        let ms = START_INSTANT
            .get()
            .map(|t| t.elapsed().as_millis() as u32)
            .unwrap_or(0);
        log::info!("[startup] app ready in {ms}ms");
        ms
    })
}

/// Single source of truth for the IPC command surface. Used by both the desktop
/// app (`run`) and the web sidecar (`serve`), so adding a command here wires it
/// for both transports automatically — no second list.
pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .dangerously_cast_bigints_to_number()
        .semantic_types(
            specta_typescript::semantic::Configuration::default().enable_lossless_floats(),
        )
        .commands(tauri_specta::collect_commands![
            write_temp_file,
            read_file,
            // --- Utility ---
            app_ready,
            get_app_data_dir,
            get_data_location,
            set_data_location,
            open_data_folder,
            open_log_file,
            list_user_plugins,
            install_plugin,
            uninstall_plugin,
            sidecar::sidecar_install,
            sidecar::sidecar_installed_version,
            sidecar::sidecar_spawn,
            sidecar::sidecar_kill,
            borders::check_border_file,
            borders::download_border_file,
            borders::border_lookup,
            geocoder::reverse_geocode,
            // --- Map lifecycle ---
            location_store::store_open_map,
            location_store::store_close_map,
            location_store::store_save_dirty,
            location_store::store_copy_locations_to_map,
            location_store::store_get_summary,
            // --- Map metadata ---
            map_meta::store_list_maps,
            map_meta::store_get_map,
            map_meta::store_create_map,
            map_meta::store_delete_map,
            map_meta::store_update_map_meta,
            map_meta::store_touch_map_opened,
            map_meta::store_rename_folder,
            map_meta::store_delete_folder,
            map_meta::store_db_table_info,
            // --- Location CRUD ---
            location_store::store_add_locations,
            location_store::store_remove_locations,
            location_store::store_update_locations,
            location_store::store_set_active,
            location_store::store_set_marker_color,
            location_store::store_get_location,
            location_store::store_get_locations_by_ids,
            location_store::store_get_all_locations,
            location_store::store_country_distribution,
            location_store::store_location_count,
            location_store::store_bounds,
            location_store::store_find_nearby,
            location_store::store_near_any,
            location_store::store_extra_field_values,
            // --- Tag CRUD ---
            location_store::store_create_tags,
            location_store::store_update_tags,
            location_store::store_delete_tags,
            location_store::store_reorder_tags,
            // --- Undo / redo ---
            location_store::store_undo,
            location_store::store_redo,
            location_store::store_reset_undo,
            location_store::store_commit_diff,
            // --- Selections ---
            location_store::store_sync_selections,
            location_store::store_get_selected_ids_list,
            location_store::store_pick_spaced,
            location_store::store_resolve_selection,
            location_store::store_partition,
            location_store::store_duplicate_groups,
            location_store::store_merge_duplicates,
            location_store::store_prune_duplicates,
            // --- Render ---
            location_store::store_fill_render_file,
            location_store::store_resolve_pick,
            // --- Import / export ---
            import::bulk_import_preview,
            import::bulk_import_confirm,
            import::bulk_import_cancel,
            import::store_import_preview,
            import::store_import_paste_preview,
            import::store_import_staged_location,
            import::store_import_file,
            export::store_export_json,
            export::store_export_csv,
            export::store_export_geojson,
            export::store_save_export_file,
            export::store_export_bulk_zip,
            // --- Version control ---
            map_meta::store_db_clear_table,
            map_meta::store_db_stats,
            seen::store_seen_write,
            seen::store_seen_list,
            seen::store_seen_count,
            seen::store_seen_countries,
            seen::store_seen_maps,
            seen::store_seen_clear,
            review::store_review_create,
            review::store_review_get,
            review::store_review_list,
            review::store_review_update,
            review::store_review_delete,
            vcs::store_commit,
            vcs::store_list_commits,
            vcs::store_checkout_commit,
            vcs::store_get_commit_delta,
            // --- Plugins (vali) ---
            plugins::vali_generate,
            plugins::vali_download,
            plugins::vali_cancel,
            plugins::vali_subdivisions,
        ])
}

pub fn run() {
    let _ = START_INSTANT.set(std::time::Instant::now());
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("[PANIC] {info}");
        default_hook(info);
    }));
    let builder = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("mma-buf", |_ctx, req, responder| {
            let raw = percent_encoding::percent_decode_str(req.uri().path())
                .decode_utf8_lossy()
                .into_owned();
            std::thread::spawn(move || {
                let _t = std::time::Instant::now();
                let trimmed = raw.trim_start_matches('/');
                let clean = if trimmed.starts_with(|c: char| c.is_ascii_alphabetic())
                    && trimmed.as_bytes().get(1) == Some(&b':')
                {
                    trimmed
                } else {
                    &raw
                };
                let resp = match std::fs::read(clean) {
                    Ok(data) => {
                        log::debug!(
                            "[mma-buf] read {} bytes in {:.1}ms",
                            data.len(),
                            _t.elapsed().as_secs_f64() * 1000.0
                        );
                        tauri::http::Response::builder()
                            .header("Access-Control-Allow-Origin", "*")
                            .header("Content-Type", "application/octet-stream")
                            .body(data)
                            .unwrap()
                    }
                    Err(e) => tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(format!("file not found: {clean} — {e}").into_bytes())
                        .unwrap(),
                };
                responder.respond(resp);
            });
        })
        .register_uri_scheme_protocol("mma-plugin", |_ctx, req| {
            let plugins_dir = storage::app_data_dir().unwrap_or_default().join("plugins");
            let path = percent_encoding::percent_decode_str(req.uri().path()).decode_utf8_lossy();
            let resolved = plugins_dir.join(path.trim_start_matches('/'));
            let canonical = resolved.canonicalize().unwrap_or_default();
            if !canonical.starts_with(&plugins_dir) {
                return tauri::http::Response::builder()
                    .status(403)
                    .body(vec![])
                    .unwrap();
            }
            match std::fs::read(&canonical) {
                Ok(data) => {
                    let mime = if canonical
                        .extension()
                        .is_some_and(|e| e == "js" || e == "mjs")
                    {
                        "application/javascript"
                    } else {
                        "application/octet-stream"
                    };
                    tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(data)
                        .unwrap()
                }
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(vec![])
                    .unwrap(),
            }
        })
        .register_asynchronous_uri_scheme_protocol("svtile", |_ctx, req, responder| {
            let path = req.uri().path().trim_start_matches('/').to_string();
            let query = req
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default();
            let url = format!("https://lh3.ggpht.com/jsapi2/a/b/c/{path}{query}");
            std::thread::spawn(move || responder.respond(fetch_svtile(&url)));
        })
        .register_asynchronous_uri_scheme_protocol("gmaps", |_ctx, req, responder| {
            let path = req.uri().path().to_string();
            let query = req
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default();
            let url = format!("https://www.google.com{path}{query}");
            let method = req.method().clone();
            let content_type = req
                .headers()
                .get(tauri::http::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/x-www-form-urlencoded")
                .to_string();
            let user_agent = req
                .headers()
                .get(tauri::http::header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let body = req.body().clone();
            std::thread::spawn(move || {
                responder.respond(proxy_gmaps(method, &url, content_type, user_agent, body))
            });
        })
        .register_asynchronous_uri_scheme_protocol("googl", |_ctx, req, responder| {
            let id = req.uri().path().trim_start_matches('/').to_string();
            let mapsapp = req
                .uri()
                .query()
                .unwrap_or("")
                .split('&')
                .any(|kv| kv == "source=mapsapp");
            std::thread::spawn(move || responder.respond(resolve_googl(&id, mapsapp)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(location_store::StoreState::new(
            location_store::StoreManager::new(),
        ))
        .manage(plugins::ValiState::new())
        .invoke_handler({
            let specta_builder = specta_builder();

            #[cfg(debug_assertions)]
            {
                let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../src/bindings.gen.ts");
                eprintln!("[specta] exporting to {}", out.display());
                match specta_builder.export(specta_typescript::Typescript::default(), &out) {
                    Ok(()) => {
                        promote_serialize_bindings(&out);
                        eprintln!("[specta] bindings exported OK");
                    }
                    Err(e) => {
                        eprintln!("[specta] export FAILED: {e}");
                        eprintln!("[specta] debug: {e:?}");
                    }
                }
            }

            specta_builder.invoke_handler()
        })
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                // updater dumps full release manifests at debug
                .level_for("tauri_plugin_updater", log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                // default targets include LogDir{None} ("Map Making App.log"); .target()
                // appends, so without clearing, every line is written to two files
                .clear_targets()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("mma".to_string()),
                    },
                ))
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let t = std::time::Instant::now();
            let _ = APP_HANDLE.set(app.handle().clone());
            storage::init_paths(app.handle())?;
            storage::run_migrations()?;
            log::info!("[startup] migrations: {}ms", t.elapsed().as_millis());

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            if let Some(t0) = START_INSTANT.get() {
                log::info!(
                    "[startup] setup done: {}ms since run()",
                    t0.elapsed().as_millis()
                );
            }
            Ok(())
        });

    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                sidecar::kill_all_sidecars();
            }
        });
}
