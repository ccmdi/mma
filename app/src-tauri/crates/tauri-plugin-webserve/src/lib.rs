//! tauri-plugin-webserve — run a Tauri app in a plain browser.
//!
//! Attaches to the LIVE app and serves it over HTTP. Browser requests are bridged
//! into the app's own machinery, so there is no per-command or per-frontend code:
//!   - `POST /__ipc/<cmd>`  -> the app's real invoke handler (`Webview::on_message`)
//!   - `GET  /<asset>`      -> the app's bundled frontend (`AssetResolver`), with a
//!                             bootstrap `<script>` injected so the same desktop
//!                             bundle boots in a browser (defines `__TAURI_INTERNALS__`)
//!   - `GET/POST /__scheme/<name>/...` -> handlers the app registered via
//!                             [`register_scheme`] (the only app-facing hook)
//!
//! The app only ever: enables this plugin, and registers its custom URI schemes
//! through [`register_scheme`]. Everything else is generic.

#![allow(
    clippy::doc_overindented_list_items,
    reason = "the -> column in the module doc is aligned by hand"
)]

use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use tauri::ipc::{CallbackFn, InvokeBody, InvokeError, InvokeResponse};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Manager, Runtime, Webview};
use tiny_http::{Header, Method, Response, Server};

const BOOTSTRAP_JS: &str = include_str!("bootstrap.js");
const SERVICE_WORKER_JS: &str = include_str!("sw.js");

// ---------------------------------------------------------------------------
// Scheme registry — the single app-facing hook. The app registers each custom
// URI scheme handler here (the same closure it would give Tauri), and the HTTP
// server invokes it for `/__scheme/<name>/...`. Tauri exposes no way to call a
// registered URI-scheme protocol programmatically, so this bridge is necessary.
// ---------------------------------------------------------------------------

pub struct SchemeRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub content_type: String,
    pub user_agent: String,
    pub body: Vec<u8>,
}

pub struct SchemeResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl SchemeResponse {
    pub fn ok(content_type: impl Into<String>, body: Vec<u8>) -> Self {
        Self { status: 200, content_type: content_type.into(), body }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { status: 404, content_type: "text/plain".into(), body: msg.into().into_bytes() }
    }
}

type SchemeHandler = Box<dyn Fn(SchemeRequest) -> SchemeResponse + Send + Sync + 'static>;

fn schemes() -> &'static RwLock<HashMap<String, SchemeHandler>> {
    static SCHEMES: OnceLock<RwLock<HashMap<String, SchemeHandler>>> = OnceLock::new();
    SCHEMES.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register a custom URI scheme handler for the web server (e.g. `"mma-buf"`).
/// On the web these schemes are served as `/__scheme/<name>/...` HTTP routes.
pub fn register_scheme<F>(name: &str, handler: F)
where
    F: Fn(SchemeRequest) -> SchemeResponse + Send + Sync + 'static,
{
    schemes().write().unwrap().insert(name.to_string(), Box::new(handler));
}

// ---------------------------------------------------------------------------
// Event bridge — `app.emit` reaches the app's own webviews, but a plain browser
// tab isn't one, so backend events never arrive there. The app forwards every
// event it emits to [`forward_event`], which fans them out to all connected
// browsers over Server-Sent Events (`GET /__events`). Generic over the app's
// events: no event name is hardcoded — the app passes the serialized payload.
// ---------------------------------------------------------------------------

fn event_clients() -> &'static Mutex<Vec<Sender<Vec<u8>>>> {
    static CLIENTS: OnceLock<Mutex<Vec<Sender<Vec<u8>>>>> = OnceLock::new();
    CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Forward a backend event to every connected web client (SSE). No-op when no
/// browser is connected — always the case on desktop, so the app can call this
/// unconditionally from its emit chokepoint.
pub fn forward_event(event: &str, payload: serde_json::Value) {
    let Ok(mut clients) = event_clients().lock() else {
        return;
    };
    if clients.is_empty() {
        return;
    }
    let frame = format!("data: {}\n\n", serde_json::json!({ "event": event, "payload": payload }))
        .into_bytes();
    clients.retain(|tx| tx.send(frame.clone()).is_ok());
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/// Initialize the plugin. Add with `.plugin(tauri_plugin_webserve::init())`.
/// Reads `MMA_SERVE_ADDR` (default `127.0.0.1:1430`) for the bind address.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webserve")
        .setup(|app, _api| {
            let handle = app.clone();
            std::thread::spawn(move || serve(handle));
            Ok(())
        })
        .build()
}

fn serve<R: Runtime>(handle: AppHandle<R>) {
    let addr = std::env::var("MMA_SERVE_ADDR").unwrap_or_else(|_| "127.0.0.1:1430".to_string());
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[webserve] failed to bind {addr}: {e}");
            return;
        }
    };
    log::info!("[webserve] listening on http://{addr}");
    eprintln!("[webserve] http://{addr}");

    for mut req in server.incoming_requests() {
        let method = req.method().clone();
        let url = req.url().to_string();
        let path = url.split('?').next().unwrap_or("").to_string();
        let query = url.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();

        if method == Method::Post && path == "/__ipc_upload" {
            let raw = query.strip_prefix("name=").unwrap_or("upload");
            let name = url_decode(raw);
            let mut body = Vec::new();
            let _ = req.as_reader().read_to_end(&mut body);
            let dest = std::env::temp_dir().join(format!("mma_{name}"));
            let resp = match std::fs::write(&dest, &body) {
                Ok(()) => {
                    let path_str = dest.to_string_lossy().to_string();
                    (200, serde_json::json!(path_str).to_string())
                }
                Err(e) => (500, err_json(&format!("write failed: {e}"))),
            };
            let _ = req.respond(
                Response::from_string(resp.1)
                    .with_status_code(resp.0)
                    .with_header(json_header()),
            );
            continue;
        }

        if method == Method::Post && path.starts_with("/__ipc/") {
            let cmd = path.trim_start_matches("/__ipc/").to_string();
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let args: serde_json::Value =
                serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({}));
            let (status, out) = invoke(&handle, cmd, args);
            let _ = req.respond(
                Response::from_string(out)
                    .with_status_code(status)
                    .with_header(json_header()),
            );
            continue;
        }

        if method == Method::Get && path == "/__events" {
            let (tx, rx) = channel::<Vec<u8>>();
            event_clients().lock().unwrap().push(tx);
            // Own thread: the accept loop is single-threaded, so holding an SSE
            // connection open here would stall every other request.
            std::thread::spawn(move || stream_events(req, rx));
            continue;
        }

        if path == "/__webserve/sw.js" {
            let resp = Response::from_string(SERVICE_WORKER_JS)
                .with_header(ct_header("text/javascript; charset=utf-8"))
                .with_header(
                    Header::from_bytes(&b"Service-Worker-Allowed"[..], &b"/"[..]).unwrap(),
                );
            let _ = req.respond(resp);
            continue;
        }

        if let Some(rest) = path.strip_prefix("/__scheme/") {
            let resp = serve_scheme(&mut req, rest, &query, method);
            let _ = req.respond(resp);
            continue;
        }

        let _ = req.respond(serve_asset(&handle, &path));
    }
}

fn serve_scheme(
    req: &mut tiny_http::Request,
    rest: &str,
    query: &str,
    method: Method,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let (name, sub) = match rest.split_once('/') {
        Some((n, s)) => (n.to_string(), s.to_string()),
        None => (rest.to_string(), String::new()),
    };
    let content_type = header_value(req, "content-type").unwrap_or_default();
    let user_agent = header_value(req, "user-agent").unwrap_or_default();
    let mut body = Vec::new();
    let _ = req.as_reader().read_to_end(&mut body);

    let reg = schemes().read().unwrap();
    let Some(handler) = reg.get(&name) else {
        return Response::from_string(format!("no scheme handler: {name}")).with_status_code(404);
    };
    let resp = handler(SchemeRequest {
        method: method.to_string(),
        path: sub,
        query: query.to_string(),
        content_type,
        user_agent,
        body,
    });
    Response::from_data(resp.body)
        .with_status_code(resp.status)
        .with_header(ct_header(&resp.content_type))
        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
}

/// Hold one browser's SSE connection open and write event frames as they arrive.
/// Uses the raw response writer (not `Response`/chunked, which buffers until the
/// stream ends — never, here) and flushes per frame so events deliver live. A
/// 25s heartbeat keeps the connection alive and turns a dropped client into a
/// write error that ends the thread; its `tx` is then pruned on the next emit.
fn stream_events(req: tiny_http::Request, rx: Receiver<Vec<u8>>) {
    let mut w = req.into_writer();
    let head = "HTTP/1.1 200 OK\r\n\
                Content-Type: text/event-stream\r\n\
                Cache-Control: no-cache\r\n\
                Connection: close\r\n\r\n";
    if w.write_all(head.as_bytes()).and_then(|_| w.flush()).is_err() {
        return;
    }
    loop {
        let frame = match rx.recv_timeout(Duration::from_secs(25)) {
            Ok(f) => f,
            Err(RecvTimeoutError::Timeout) => b": ping\n\n".to_vec(),
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if w.write_all(&frame).and_then(|_| w.flush()).is_err() {
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// IPC bridge: forward to the app's real invoke handler.
// ---------------------------------------------------------------------------

fn invoke<R: Runtime>(handle: &AppHandle<R>, cmd: String, args: serde_json::Value) -> (u16, String) {
    let webview = match handle.get_webview_window("main") {
        Some(w) => w.as_ref().clone(),
        None => return (500, err_json("ipc webview not ready")),
    };

    // Must be the app's real local origin or Tauri's ACL treats it as remote and
    // denies every custom command. The IPC host webview is about:blank, so we
    // can't read it off the webview — derive it per-platform (matches schemeBase
    // on the JS side; Windows/Android serve custom protocols as http://*.localhost).
    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };

    let request = InvokeRequest {
        cmd,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().unwrap(),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: handle.invoke_key().to_string(),
    };

    let (tx, rx) = sync_channel::<InvokeResponse>(1);
    let scheduled = handle.run_on_main_thread(move || {
        webview.on_message(
            request,
            Box::new(
                move |_wv: Webview<R>,
                      _cmd: String,
                      response: InvokeResponse,
                      _cb: CallbackFn,
                      _err: CallbackFn| {
                    let _ = tx.send(response);
                },
            ),
        );
    });
    if scheduled.is_err() {
        return (500, err_json("failed to schedule invoke"));
    }

    match rx.recv_timeout(Duration::from_secs(120)) {
        Ok(InvokeResponse::Ok(body)) => (
            200,
            body.deserialize::<serde_json::Value>()
                .unwrap_or(serde_json::Value::Null)
                .to_string(),
        ),
        Ok(InvokeResponse::Err(InvokeError(v))) => {
            (500, serde_json::json!({ "error": v }).to_string())
        }
        Err(_) => (504, err_json("command timed out")),
    }
}

// ---------------------------------------------------------------------------
// Static frontend: serve the app's bundle, injecting the bootstrap shim.
// ---------------------------------------------------------------------------

fn serve_asset<R: Runtime>(
    handle: &AppHandle<R>,
    path: &str,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let asset_path = if path == "/" || path.is_empty() {
        "index.html".to_string()
    } else {
        path.trim_start_matches('/').to_string()
    };

    let resolver = handle.asset_resolver();
    // SPA fallback: unknown non-file routes resolve to index.html.
    let asset = resolver
        .get(asset_path.clone())
        .or_else(|| resolver.get("index.html".to_string()));

    let Some(asset) = asset else {
        return Response::from_string("not found").with_status_code(404);
    };

    let is_html = asset.mime_type.contains("html");
    let bytes = if is_html {
        inject_bootstrap(asset.bytes)
    } else {
        asset.bytes
    };

    let mut resp = Response::from_data(bytes).with_header(ct_header(&asset.mime_type));
    if is_html {
        // index.html must never be cached (points at content-hashed assets).
        resp = resp
            .with_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap());
    }
    resp
}

/// Insert the bootstrap `<script>` at the very start of `<head>` so it defines
/// `window.__TAURI_INTERNALS__` before the app's module bundle runs.
fn inject_bootstrap(html: Vec<u8>) -> Vec<u8> {
    let s = String::from_utf8_lossy(&html);
    let script = format!("<script>{BOOTSTRAP_JS}</script>");
    if let Some(idx) = s.find("<head>") {
        let cut = idx + "<head>".len();
        format!("{}{}{}", &s[..cut], script, &s[cut..]).into_bytes()
    } else {
        format!("{script}{s}").into_bytes()
    }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

fn json_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()
}

fn ct_header(ct: &str) -> Header {
    Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap()
}

fn err_json(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn header_value(req: &tiny_http::Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn url_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let mut bytes = s.as_bytes().iter();
    while let Some(&b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().copied().unwrap_or(0);
            let lo = bytes.next().copied().unwrap_or(0);
            let hex = [hi, lo];
            if let Ok(val) = u8::from_str_radix(std::str::from_utf8(&hex).unwrap_or(""), 16) {
                out.push(val);
            }
        } else if b == b'+' {
            out.push(b' ');
        } else {
            out.push(b);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
