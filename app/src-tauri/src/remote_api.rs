//! Local REST transport for the `window.MMA` plugin API.
//!
//! `POST /mma/{dotted.path}` with `Authorization: Bearer <key>` executes that
//! MMA method in a target webview and returns its JSON result. There is no
//! second API surface: the HTTP layer only routes. Each request parks on a
//! channel while the webview runs the call and answers via the
//! `remote_api_respond` command.
//!
//! Opt-in (Settings > Advanced). Binds loopback only; the bearer key gates
//! every request because any webpage can attempt requests to localhost.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::types::AppResult;
use std::env;
use std::io::Cursor;
use std::io::Read;
use std::thread;
use tokio::task;

const DEFAULT_ADDR: &str = "127.0.0.1:1429";
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

type Reply = (bool, serde_json::Value);

struct State {
    key: Mutex<String>,
    server: Mutex<Option<Arc<tiny_http::Server>>>,
    pending: Mutex<HashMap<u32, SyncSender<Reply>>>,
    next_id: AtomicU32,
}

fn state() -> &'static State {
    static S: OnceLock<State> = OnceLock::new();
    S.get_or_init(|| State {
        key: Mutex::new(String::new()),
        server: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
    })
}

fn addr() -> String {
    env::var("MMA_REMOTE_API_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string())
}

/// Start (or re-key) the remote API server. Idempotent: a running server just
/// picks up the new key. Returns the base URL.
#[tauri::command]
#[specta::specta]
pub async fn remote_api_start(key: String) -> AppResult<String> {
    task::spawn_blocking(move || {
        let s = state();
        *s.key.lock().unwrap() = key;
        let mut server = s.server.lock().unwrap();
        if server.is_none() {
            let addr = addr();
            let srv = Arc::new(
                tiny_http::Server::http(&addr)
                    .map_err(|e| format!("remote api bind {addr}: {e}"))?,
            );
            *server = Some(srv.clone());
            thread::spawn(move || accept_loop(srv));
            log::info!("[remote-api] listening on http://{addr}");
        }
        Ok(format!("http://{}", addr()))
    })
    .await?
}

#[tauri::command]
#[specta::specta]
pub fn remote_api_stop() -> AppResult<()> {
    if let Some(srv) = state().server.lock().unwrap().take() {
        srv.unblock();
        log::info!("[remote-api] stopped");
    }
    Ok(())
}

/// Webview -> HTTP reply path: resolves the parked request for `id`.
/// `payload` is JSON text, not a typed value -- specta cannot export the
/// recursive `serde_json::Value` type (stack overflow at bindings export).
#[tauri::command]
#[specta::specta]
pub fn remote_api_respond(id: u32, ok: bool, payload: String) {
    if let Some(tx) = state().pending.lock().unwrap().remove(&id) {
        let value = serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
        let _ = tx.send((ok, value));
    }
}

fn accept_loop(server: Arc<tiny_http::Server>) {
    for req in server.incoming_requests() {
        // Per-request thread: a parked MMA call must not block other requests.
        thread::spawn(move || handle(req));
    }
}

fn handle(mut req: tiny_http::Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let query = url
        .split_once('?')
        .map(|(_, q)| q.to_string())
        .unwrap_or_default();

    if req.method() == &tiny_http::Method::Options {
        let _ = req.respond(with_cors(tiny_http::Response::empty(204)));
        return;
    }
    if !authorized(&req) {
        let _ = req.respond(json_response(401, r#"{"error":"unauthorized"}"#.into()));
        return;
    }
    if req.method() == &tiny_http::Method::Get && path == "/ping" {
        let _ = req.respond(json_response(200, r#"{"ok":true}"#.into()));
        return;
    }
    let Some(mma_path) = path.strip_prefix("/mma/").map(str::to_string) else {
        let _ = req.respond(json_response(404, r#"{"error":"unknown route"}"#.into()));
        return;
    };

    let mut body = String::new();
    let _ = req.as_reader().read_to_string(&mut body);
    let args: serde_json::Value = if body.trim().is_empty() {
        serde_json::json!([])
    } else {
        match serde_json::from_str(&body) {
            Ok(v @ serde_json::Value::Array(_)) => v,
            Ok(_) => {
                let _ = req.respond(json_response(
                    400,
                    r#"{"error":"body must be a JSON array of arguments"}"#.into(),
                ));
                return;
            }
            Err(e) => {
                let _ = req.respond(json_response(
                    400,
                    serde_json::json!({ "error": format!("bad JSON body: {e}") }).to_string(),
                ));
                return;
            }
        }
    };

    let map_id = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("mapId="))
        .map(str::to_string);
    let (status, out) = dispatch(&mma_path, args, map_id.as_deref());
    let _ = req.respond(json_response(status, out));
}

fn authorized(req: &tiny_http::Request) -> bool {
    let expected = format!("Bearer {}", state().key.lock().unwrap());
    req.headers()
        .iter()
        .find(|h| {
            h.field
                .as_str()
                .as_str()
                .eq_ignore_ascii_case("authorization")
        })
        .is_some_and(|h| h.value.as_str() == expected)
}

/// Route a call into a webview and wait for its reply.
fn dispatch(mma_path: &str, args: serde_json::Value, map_id: Option<&str>) -> (u16, String) {
    let Some(app) = crate::app_handle() else {
        return (500, r#"{"error":"app not ready"}"#.into());
    };
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    let label = match pick_target(&labels, map_id) {
        Ok(l) => l,
        Err(e) => return (400, serde_json::json!({ "error": e }).to_string()),
    };

    let id = state().next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = sync_channel::<Reply>(1);
    state().pending.lock().unwrap().insert(id, tx);

    let payload = serde_json::json!({ "id": id, "path": mma_path, "args": args });
    if let Err(e) = app.emit_to(&label, "mma-remote:call", payload) {
        state().pending.lock().unwrap().remove(&id);
        return (
            500,
            serde_json::json!({ "error": format!("emit failed: {e}") }).to_string(),
        );
    }

    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok((true, result)) => (200, result.to_string()),
        Ok((false, err)) => (500, serde_json::json!({ "error": err }).to_string()),
        Err(_) => {
            state().pending.lock().unwrap().remove(&id);
            (504, r#"{"error":"call timed out"}"#.into())
        }
    }
}

/// Which window executes the call: an explicit `mapId` targets its `map-<id>`
/// window (falling back to `main`, which hosts the editor on web/single-window);
/// otherwise the single open map window, or `main` when no map window exists.
pub(crate) fn pick_target(labels: &[String], map_id: Option<&str>) -> Result<String, String> {
    if let Some(id) = map_id {
        let label = format!("map-{id}");
        if labels.iter().any(|l| l == &label) {
            return Ok(label);
        }
        return Ok("main".into());
    }
    let maps: Vec<&String> = labels.iter().filter(|l| l.starts_with("map-")).collect();
    match maps.len() {
        0 => Ok("main".into()),
        1 => Ok(maps[0].clone()),
        _ => Err("multiple map windows open; pass ?mapId=<id>".into()),
    }
}

fn json_response(status: u16, body: String) -> tiny_http::Response<Cursor<Vec<u8>>> {
    with_cors(
        tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .unwrap(),
            ),
    )
}

/// CORS + Private Network Access headers so both `GM_xmlhttpRequest` and plain
/// `fetch` from userscripts can reach us.
fn with_cors<D>(resp: tiny_http::Response<D>) -> tiny_http::Response<D>
where
    D: Read,
{
    resp.with_header(
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    )
    .with_header(
        tiny_http::Header::from_bytes(
            &b"Access-Control-Allow-Headers"[..],
            &b"authorization, content-type"[..],
        )
        .unwrap(),
    )
    .with_header(
        tiny_http::Header::from_bytes(
            &b"Access-Control-Allow-Methods"[..],
            &b"GET, POST, OPTIONS"[..],
        )
        .unwrap(),
    )
    .with_header(
        tiny_http::Header::from_bytes(&b"Access-Control-Allow-Private-Network"[..], &b"true"[..])
            .unwrap(),
    )
}

#[cfg(test)]
#[path = "remote_api.test.rs"]
mod remote_api_tests;
