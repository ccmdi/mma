//! Headless web-serve entry. Builds the real app with the `webserve` plugin and a
//! hidden `about:blank` webview (the IPC dispatch host), registers the app's URI
//! schemes for the web, then runs. All HTTP/bridge logic lives in the plugin —
//! the only app-facing surface is enabling the plugin + the scheme registrations.
//!
//! Gate: `--features web-serve`. Entry: the `mma-serve` bin.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_webserve::{register_scheme, SchemeRequest, SchemeResponse};

use crate::{location_store, storage};

pub fn run_server() {
    // Drop the configured visible window; we make our own hidden blank "main"
    // webview as the IPC dispatch host (the browser gets the bundle over HTTP).
    let mut ctx = tauri::generate_context!();
    ctx.config_mut().app.windows.clear();

    tauri::Builder::default()
        .manage(location_store::StoreState::new(
            location_store::StoreManager::new(),
        ))
        .invoke_handler(crate::specta_builder().invoke_handler())
        .plugin(tauri_plugin_webserve::init())
        .setup(|app| {
            storage::init_paths(app.handle())?;
            storage::run_migrations()?;
            register_web_schemes();
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(
                &handle,
                "main",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .visible(false)
            .build()?;
            Ok(())
        })
        .build(ctx)
        .expect("failed to build web sidecar app")
        .run(|_app, _event| {});
}

/// Convert a Tauri proxy response into the plugin's scheme response.
fn relay(r: tauri::http::Response<Vec<u8>>) -> SchemeResponse {
    let status = r.status().as_u16();
    let content_type = r
        .headers()
        .get(tauri::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    SchemeResponse {
        status,
        content_type,
        body: r.into_body(),
    }
}

fn qs(query: &str) -> String {
    if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    }
}

/// The one app-facing hook: register each custom URI scheme handler with the
/// plugin (same logic the desktop `register_uri_scheme_protocol` handlers use).
fn register_web_schemes() {
    register_scheme("mma-buf", |req: SchemeRequest| {
        let path = percent_encoding::percent_decode_str(&req.path)
            .decode_utf8_lossy()
            .into_owned();
        match std::fs::read(&path) {
            Ok(data) => SchemeResponse::ok("application/octet-stream", data),
            Err(e) => SchemeResponse::not_found(format!("file not found: {path} — {e}")),
        }
    });
    register_scheme("svtile", |req: SchemeRequest| {
        let url = format!(
            "https://lh3.ggpht.com/jsapi2/a/b/c/{}{}",
            req.path,
            qs(&req.query)
        );
        relay(crate::fetch_svtile(&url))
    });
    register_scheme("gmaps", |req: SchemeRequest| {
        let url = format!("https://www.google.com/{}{}", req.path, qs(&req.query));
        let method =
            reqwest::Method::from_bytes(req.method.as_bytes()).unwrap_or(reqwest::Method::GET);
        let ct = if req.content_type.is_empty() {
            "application/x-www-form-urlencoded".to_string()
        } else {
            req.content_type
        };
        relay(crate::proxy_gmaps(
            method,
            &url,
            ct,
            req.user_agent,
            req.body,
        ))
    });
    register_scheme("googl", |req: SchemeRequest| {
        let mapsapp = req.query.split('&').any(|kv| kv == "source=mapsapp");
        relay(crate::resolve_googl(&req.path, mapsapp))
    });
}
