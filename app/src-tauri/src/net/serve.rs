//! Headless web-serve entry. Builds the real app with the `webserve` plugin and a
//! hidden `about:blank` webview (the IPC dispatch host), registers the app's URI
//! schemes for the web, then runs. All HTTP/bridge logic lives in the plugin -
//! the only app-facing surface is enabling the plugin + the scheme registrations.
//!
//! Gate: `--features web-serve`. Entry: the `mma-serve` bin.

use tauri::http::header::CONTENT_TYPE;
use tauri::http::Response as HttpResponse;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_webserve::{register_scheme, SchemeRequest, SchemeResponse};

use crate::net::proxy;
use crate::store::engine;
use crate::store::storage;

pub fn run_server() {
    // Drop the configured visible window; we make our own hidden blank "main"
    // webview as the IPC dispatch host (the browser gets the bundle over HTTP).
    let mut ctx = tauri::generate_context!();
    ctx.config_mut().app.windows.clear();

    tauri::Builder::default()
        .manage(engine::StoreState::new(engine::StoreManager::new()))
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
fn relay(r: HttpResponse<Vec<u8>>) -> SchemeResponse {
    let status = r.status().as_u16();
    let content_type = r
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    SchemeResponse {
        status,
        content_type,
        body: r.into_body(),
    }
}

/// Serve every app URI scheme through the web server.
fn register_web_schemes() {
    for scheme in proxy::SCHEMES {
        let handle = scheme.handle;
        register_scheme(scheme.name, move |req: SchemeRequest| {
            relay(handle(proxy::SchemeCall::from_web(
                &req.method,
                &req.path,
                req.query,
                req.content_type,
                req.user_agent,
                req.body,
            )))
        });
    }
}
