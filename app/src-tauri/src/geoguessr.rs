//! GeoGuessr session auth and the `ggapi` authenticated proxy.
//!
//! The frontend cannot talk to geoguessr.com directly: CORS blocks it and the
//! `_ncfa` session cookie is HttpOnly. So the user signs in inside a dedicated
//! webview window, we lift `_ncfa` out of that webview's cookie store, and every
//! subsequent API call goes through the `ggapi://` scheme, which replays it
//! server-side with the cookie attached.
//!
//! The token lives in the OS credential store, never the app DB.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::storage;
use crate::types::AppResult;

pub(crate) const ORIGIN: &str = "https://www.geoguessr.com";
const SECRET_NAME: &str = "geoguessr";
const LOGIN_LABEL: &str = "gg-login";
const POLL_INTERVAL: Duration = Duration::from_millis(750);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// The signed-in GeoGuessr account.
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GgUser {
    pub id: String,
    pub nick: String,
    /// Avatar pin path (e.g. `pin/<hash>.png`), served under `/images/` on geoguessr.com.
    pub pin: Option<String>,
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/// Outer `None` = not yet read from the credential store; inner `None` = no session.
fn cell() -> &'static Mutex<Option<Option<String>>> {
    static S: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Current `_ncfa`, read from the credential store on first use. A load failure is propagated
/// and NOT cached, so the next call retries rather than reporting "signed out" until restart.
fn session() -> AppResult<Option<String>> {
    let mut g = cell().lock()?;
    if g.is_none() {
        *g = Some(storage::secret::get(SECRET_NAME)?);
    }
    Ok(g.clone().unwrap_or_default())
}

fn set_session(ncfa: Option<String>) -> AppResult<()> {
    match ncfa.as_deref() {
        Some(v) => storage::secret::set(SECRET_NAME, v)?,
        None => storage::secret::delete(SECRET_NAME)?,
    }
    *cell().lock()? = Some(ncfa);
    Ok(())
}

// ---------------------------------------------------------------------------
// ggapi proxy
// ---------------------------------------------------------------------------

/// `ggapi://localhost/<path>?<query>` -> `https://www.geoguessr.com/<path>?<query>`.
pub(crate) fn upstream_url(path: &str, query: Option<&str>) -> String {
    let path = path.trim_start_matches('/');
    match query {
        Some(q) if !q.is_empty() => format!("{ORIGIN}/{path}?{q}"),
        _ => format!("{ORIGIN}/{path}"),
    }
}

/// Headers for an upstream call. `Origin`/`Referer` are set defensively -- an
/// on-origin caller would send them for free and we have not tested their absence.
pub(crate) fn proxy_headers(ncfa: &str, content_type: Option<&str>) -> Vec<(&'static str, String)> {
    let mut h = vec![
        ("cookie", format!("_ncfa={ncfa}")),
        ("x-client", "web".to_string()),
        ("accept", "application/json".to_string()),
        ("origin", ORIGIN.to_string()),
        ("referer", format!("{ORIGIN}/")),
    ];
    if let Some(ct) = content_type {
        h.push(("content-type", ct.to_string()));
    }
    h
}

fn no_session_response() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(401)
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(br#"{"message":"not signed in to GeoGuessr"}"#.to_vec())
        .unwrap()
}

/// Replay a `ggapi` request upstream with the stored session cookie. The upstream
/// status is relayed verbatim -- callers distinguish 401 from 409/400 themselves.
pub(crate) fn proxy(
    method: reqwest::Method,
    path: &str,
    query: Option<&str>,
    content_type: Option<String>,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    let ncfa = match session() {
        Ok(Some(v)) => v,
        Ok(None) => return no_session_response(),
        Err(e) => return crate::proxy_error(format!("ggapi session error: {e}")),
    };
    let url = upstream_url(path, query);
    let has_body = !body.is_empty();
    let mut req = crate::proxy_client().request(method, &url);
    for (k, v) in proxy_headers(&ncfa, content_type.as_deref().filter(|_| has_body)) {
        req = req.header(k, v);
    }
    if has_body {
        req = req.body(body);
    }
    match req.send() {
        Ok(resp) => crate::relay(resp, "application/json"),
        Err(e) => crate::proxy_error(format!("ggapi fetch error: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Profile lookup
// ---------------------------------------------------------------------------

/// Pull `{id, nick}` out of the `/api/v3/profiles` payload. The user sits under
/// `user` on that endpoint, but accept a bare user object too.
fn parse_profile(v: &serde_json::Value) -> Option<GgUser> {
    let user = v.get("user").filter(|u| u.is_object()).unwrap_or(v);
    Some(GgUser {
        id: user.get("id")?.as_str()?.to_string(),
        nick: user.get("nick")?.as_str()?.to_string(),
        pin: user
            .get("pin")
            .and_then(|p| p.get("url"))
            .and_then(|u| u.as_str())
            .map(String::from),
    })
}

/// Blocking `/api/v3/profiles` call. `Ok(None)` means the session is absent or
/// rejected (and has been cleared).
fn fetch_me() -> AppResult<Option<GgUser>> {
    let Some(ncfa) = session()? else {
        return Ok(None);
    };
    let mut req = crate::proxy_client().get(upstream_url("api/v3/profiles", None));
    for (k, v) in proxy_headers(&ncfa, None) {
        req = req.header(k, v);
    }
    let resp = req.send().map_err(|e| format!("geoguessr profiles: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        set_session(None)?;
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("geoguessr profiles returned {}", resp.status()).into());
    }
    let body: serde_json::Value = resp.json().map_err(|e| format!("profiles decode: {e}"))?;
    Ok(parse_profile(&body))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task failed: {e}").into())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Whether the login window may navigate to `url`. The custom scheme handlers (`ggapi`, `mma-buf`,
/// `gmaps`) attach to every webview, so an unrestricted navigation could reach the authenticated
/// proxy from an arbitrary page. Only geoguessr.com and the SSO hosts the sign-in flow uses pass.
fn login_nav_allowed(url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    const ALLOWED: &[&str] = &[
        "geoguessr.com",
        "google.com",
        "googleapis.com",
        "gstatic.com",
        "facebook.com",
        "appleid.apple.com",
    ];
    // Exact match or a dot-boundary subdomain, so "xgeoguessr.com" does not slip past "geoguessr.com".
    ALLOWED
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// Open the GeoGuessr sign-in window and wait for a `_ncfa` cookie to appear.
/// Returns the signed-in nickname.
#[tauri::command]
#[specta::specta]
pub async fn geoguessr_login(app: tauri::AppHandle) -> AppResult<String> {
    if app.get_webview_window(LOGIN_LABEL).is_some() {
        return Err("a GeoGuessr login window is already open".into());
    }
    let url = format!("{ORIGIN}/signin")
        .parse()
        .map_err(|e| format!("bad signin url: {e}"))?;
    WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Sign in to GeoGuessr")
        .inner_size(500.0, 800.0)
        .resizable(true)
        // SSO hands its credential back through the popup's `window.opener`, so the popup
        // must be a real window.
        .on_new_window(|url, _features| {
            log::debug!("[geoguessr] popup -> {}", url.host_str().unwrap_or("?"));
            tauri::webview::NewWindowResponse::Allow
        })
        .on_navigation(|u| {
            let allowed = login_nav_allowed(u);
            if allowed {
                // Where the sign-in actually went, so a stall is diagnosable from the log alone.
                log::debug!(
                    "[geoguessr] login window -> {}://{}{}",
                    u.scheme(),
                    u.host_str().unwrap_or("?"),
                    u.path()
                );
            } else {
                // Host only, never the query string.
                log::info!(
                    "[geoguessr] blocked login navigation to {}",
                    u.host_str().unwrap_or("?")
                );
            }
            allowed
        })
        .build()?;

    // cookies_for_url deadlocks on Windows unless it runs off the main thread.
    let handle = app.clone();
    let polled = blocking(move || poll_for_ncfa(&handle)).await?;

    // Close on failure too: a timed-out window left open would trip the guard above and lock the
    // user out of retrying.
    if let Some(win) = app.get_webview_window(LOGIN_LABEL) {
        let _ = win.close();
    }
    set_session(Some(polled?))?;
    match blocking(fetch_me).await?? {
        Some(user) => Ok(user.nick),
        None => Err("signed in, but GeoGuessr rejected the session".into()),
    }
}

/// Polls the login webview's cookie store. Terminates as soon as the window is
/// gone, so the task cannot outlive the window the user closed.
fn poll_for_ncfa(app: &tauri::AppHandle) -> AppResult<String> {
    let url: tauri::Url = ORIGIN.parse().map_err(|e| format!("bad origin: {e}"))?;
    let deadline = std::time::Instant::now() + LOGIN_TIMEOUT;
    let mut seen = String::new();
    loop {
        let Some(win) = app.get_webview_window(LOGIN_LABEL) else {
            return Err("login window was closed".into());
        };
        // The window can be destroyed between the check above and this call, and cookies_for_url
        // unwraps its internal channel -- so a close mid-read panics inside Tauri rather than
        // returning Err. Absorb it and treat it as the close it is.
        let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            win.cookies_for_url(url.clone())
        }));
        match read {
            Ok(Ok(cookies)) => {
                if let Some(c) = cookies.iter().find(|c| c.name() == "_ncfa") {
                    return Ok(c.value().to_string());
                }
                // Names only, never values; sorted so it logs once per change, not per poll.
                let mut names = cookies.iter().map(|c| c.name()).collect::<Vec<_>>();
                names.sort_unstable();
                let names = names.join(",");
                if names != seen {
                    log::debug!("[geoguessr] login cookies: [{names}]");
                    seen = names;
                }
            }
            Ok(Err(e)) => log::debug!("[geoguessr] cookie read: {e}"),
            Err(_) => return Err("login window was closed".into()),
        }
        if std::time::Instant::now() >= deadline {
            return Err("timed out waiting for GeoGuessr sign-in".into());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// The signed-in user, or `None` when there is no session (or it was rejected).
#[tauri::command]
#[specta::specta]
pub async fn geoguessr_me() -> AppResult<Option<GgUser>> {
    blocking(fetch_me).await?
}

#[tauri::command]
#[specta::specta]
pub async fn geoguessr_logout(app: tauri::AppHandle) -> AppResult<()> {
    blocking(move || {
        set_session(None)?;
        clear_webview_cookies(&app);
        Ok(())
    })
    .await?
}

/// Best-effort. The shared webview profile keeps its own signed-in state; left in place, the
/// next login window silently re-lifts the OLD account's cookie instead of showing the form.
fn clear_webview_cookies(app: &tauri::AppHandle) {
    let Ok(url) = ORIGIN.parse::<tauri::Url>() else {
        return;
    };
    let Some(win) = app.webview_windows().into_values().next() else {
        return;
    };
    match win.cookies_for_url(url) {
        Ok(cookies) => {
            for c in cookies {
                if let Err(e) = win.delete_cookie(c) {
                    log::debug!("[geoguessr] logout cookie delete: {e}");
                }
            }
        }
        Err(e) => log::debug!("[geoguessr] logout cookie read: {e}"),
    }
}

/// Local-only check: is a token stored? Says nothing about its validity.
#[tauri::command]
#[specta::specta]
pub async fn geoguessr_has_session() -> AppResult<bool> {
    blocking(|| Ok(session()?.is_some())).await?
}

#[cfg(test)]
#[path = "geoguessr.test.rs"]
mod tests;
