use tauri::Manager;

mod fast_io;
mod import;
mod location_store;
mod map_meta;
mod selections;
mod arrow_bridge;
mod export;
mod geocoder;
mod seen;
mod types;
mod util;
mod vcs;

#[tauri::command]
#[specta::specta]
fn write_temp_file(name: String, content: String) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("mma_{name}"));
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn get_db_uri(app: tauri::AppHandle) -> Result<String, String> {
    let path = fast_io::db_path(&app)?;
    Ok(format!("sqlite:{}", path.to_string_lossy()))
}

#[tauri::command]
#[specta::specta]
fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path().app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    { std::process::Command::new("explorer").arg(&dir).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&dir).spawn().map_err(|e| e.to_string())?; }
    #[cfg(target_os = "linux")]
    { std::process::Command::new("xdg-open").arg(&dir).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}

#[derive(serde::Serialize, specta::Type)]
struct PluginManifest {
    id: String,
    name: String,
    description: String,
    icon: String,
    main: String,
}

#[tauri::command]
#[specta::specta]
fn list_user_plugins(app: tauri::AppHandle) -> Vec<PluginManifest> {
    let dir = match app.path().app_data_dir() {
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
        if !path.is_dir() { continue; }
        let manifest_path = path.join("manifest.json");
        if let Ok(content) = std::fs::read_to_string(&manifest_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let folder_name = path.file_name()
                    .and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
                let id = val.get("id").and_then(|v| v.as_str())
                    .map(|s| s.to_string()).unwrap_or(folder_name.clone());
                let name = val.get("name").and_then(|v| v.as_str())
                    .map(|s| s.to_string()).unwrap_or(folder_name);
                let description = val.get("description").and_then(|v| v.as_str())
                    .unwrap_or("").to_string();
                let icon = val.get("icon").and_then(|v| v.as_str())
                    .unwrap_or("").to_string();
                let main = val.get("main").and_then(|v| v.as_str())
                    .unwrap_or("index.js").to_string();
                plugins.push(PluginManifest { id, name, description, icon, main });
            }
        }
    }
    plugins
}

fn build_http_client(follow_redirects: bool) -> reqwest::blocking::Client {
    let redirect = if follow_redirects {
        reqwest::redirect::Policy::default()
    } else {
        reqwest::redirect::Policy::none()
    };
    reqwest::blocking::Client::builder()
        .use_native_tls()
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
fn fetch_svtile(url: &str) -> tauri::http::Response<Vec<u8>> {
    match proxy_client().get(url).send() {
        Ok(resp) => {
            let mut out = relay(resp, "image/jpeg");
            if let Ok(v) = "private, max-age=86400".parse() {
                out.headers_mut().insert(tauri::http::header::CACHE_CONTROL, v);
            }
            out
        }
        Err(e) => proxy_error(format!("svtile fetch error: {e}")),
    }
}

/// gmaps: forward a request (POST batchexecute etc.) to www.google.com.
fn proxy_gmaps(
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
fn resolve_googl(id: &str, mapsapp: bool) -> tauri::http::Response<Vec<u8>> {
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
                .body(serde_json::to_string(location).unwrap_or_default().into_bytes())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("[PANIC] {info}");
        default_hook(info);
    }));
    let builder = tauri::Builder::default()
        .register_uri_scheme_protocol("mma-buf", |_ctx, req| {
            let raw = req.uri().path().replace("%20", " ").replace("%3A", ":");
            let trimmed = raw.trim_start_matches('/');
            let clean = if trimmed.starts_with(|c: char| c.is_ascii_alphabetic())
                && trimmed.as_bytes().get(1) == Some(&b':') { trimmed } else { &raw };
            match std::fs::read(clean) {
                Ok(data) => tauri::http::Response::builder()
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Content-Type", "application/octet-stream")
                    .body(data)
                    .unwrap(),
                Err(e) => tauri::http::Response::builder()
                    .status(404)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(format!("file not found: {clean} — {e}").into_bytes())
                    .unwrap(),
            }
        })
        .register_uri_scheme_protocol("mma-plugin", |ctx, req| {
            let plugins_dir = ctx.app_handle().path().app_data_dir()
                .unwrap_or_default().join("plugins");
            let path = req.uri().path().trim_start_matches('/');
            let resolved = plugins_dir.join(path);
            let canonical = resolved.canonicalize().unwrap_or_default();
            if !canonical.starts_with(&plugins_dir) {
                return tauri::http::Response::builder()
                    .status(403).body(vec![]).unwrap();
            }
            match std::fs::read(&canonical) {
                Ok(data) => {
                    let mime = if canonical.extension().is_some_and(|e| e == "js" || e == "mjs") {
                        "application/javascript"
                    } else { "application/octet-stream" };
                    tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(data).unwrap()
                }
                Err(_) => tauri::http::Response::builder()
                    .status(404).body(vec![]).unwrap(),
            }
        })
        .register_asynchronous_uri_scheme_protocol("svtile", |_ctx, req, responder| {
            let path = req.uri().path().trim_start_matches('/').to_string();
            let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
            let url = format!("https://lh3.ggpht.com/jsapi2/a/b/c/{path}{query}");
            std::thread::spawn(move || responder.respond(fetch_svtile(&url)));
        })
        .register_asynchronous_uri_scheme_protocol("gmaps", |_ctx, req, responder| {
            let path = req.uri().path().to_string();
            let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
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
        .manage(location_store::StoreState::new(location_store::Store::new()))
        .invoke_handler({
            let mut specta_builder = tauri_specta::Builder::<tauri::Wry>::new()
                .dangerously_cast_bigints_to_number()
                .semantic_types(specta_typescript::semantic::Configuration::default().enable_lossless_floats())
                .commands(tauri_specta::collect_commands![
                    write_temp_file,
                    read_file,
                    // --- Utility ---
                    get_db_uri,
                    get_app_data_dir,
                    open_data_folder,
                    list_user_plugins,
                    geocoder::reverse_geocode,
                    // --- Map lifecycle ---
                    location_store::store_open_map,
                    location_store::store_close_map,
                    location_store::store_save_dirty,
                    location_store::store_bake_and_save,
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
                    map_meta::store_move_map_to_folder,
                    map_meta::store_update_map_labels,
                    map_meta::store_get_pano_date,
                    map_meta::store_set_pano_date,
                    map_meta::store_db_table_info,
                    // --- Location CRUD ---
                    location_store::store_add_locations,
                    location_store::store_remove_locations,
                    location_store::store_update_locations,
                    location_store::store_set_active,
                    location_store::store_get_location,
                    location_store::store_get_location_file,
                    location_store::store_get_locations_by_ids,
                    location_store::store_get_all_locations,
                    location_store::store_location_count,
                    location_store::store_has_location,
                    location_store::store_bounds,
                    location_store::store_selection_bounds,
                    location_store::store_find_nearby,
                    location_store::store_extra_field_values,
                    // --- Tag CRUD ---
                    location_store::store_create_tags,
                    location_store::store_update_tag,
                    location_store::store_delete_tags,
                    location_store::store_strip_tags,
                    location_store::store_reorder_tags,
                    location_store::store_tag_counts,
                    // --- Undo / redo ---
                    location_store::store_undo,
                    location_store::store_redo,
                    location_store::store_reset_undo,
                    location_store::store_commit_diff,
                    // --- Selections ---
                    location_store::store_sync_selections,
                    location_store::store_add_selection,
                    location_store::store_remove_selection,
                    location_store::store_reset_selections,
                    location_store::store_get_selections,
                    location_store::store_get_selected_ids,
                    location_store::store_get_selected_ids_list,
                    location_store::store_set_selected_ids,
                    location_store::store_resolve_selection,
                    location_store::store_refresh_selections,
                    // --- Render ---
                    location_store::store_fill_render_file,
                    location_store::store_resolve_pick,
                    // --- Import / export ---
                    import::bulk_import_preview,
                    import::bulk_import_confirm,
                    import::store_import_preview,
                    import::store_import_file,
                    import::store_import_paste,
                    export::store_export_json,
                    export::store_export_csv,
                    export::store_export_geojson,
                    export::store_export_bulk_zip,
                    // --- Version control ---
                    location_store::store_snapshot_commit,
                    location_store::store_restore_commit,
                    map_meta::store_db_clear_table,
                    map_meta::store_db_stats,
                    seen::store_seen_write,
                    seen::store_seen_list,
                    seen::store_seen_count,
                    seen::store_seen_countries,
                    seen::store_seen_maps,
                    seen::store_seen_clear,
                    vcs::store_create_commit,
                    vcs::store_list_commits,
                    vcs::store_checkout_commit,
                ]);

            #[cfg(debug_assertions)]
            {
                let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings.gen.ts");
                eprintln!("[specta] exporting to {}", out.display());
                match specta_builder.export(specta_typescript::Typescript::default(), &out) {
                    Ok(()) => eprintln!("[specta] bindings exported OK"),
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
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: Some("mma".to_string()) },
                ))
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            fast_io::run_migrations(app.handle())?;

            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }

            if let Some(window) = app.get_webview_window("main") {
                let png_bytes = include_bytes!("../icons/icon.png");
                let icon = tauri::image::Image::from_bytes(png_bytes).unwrap();
                let _ = window.set_icon(icon);
            }

            Ok(())
        });

    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}
