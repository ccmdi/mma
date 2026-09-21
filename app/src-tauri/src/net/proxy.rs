//! Outbound HTTP clients and the custom URI schemes that proxy the webview's
//! cross-origin requests (tiles, Google RPCs, GeoGuessr, short links, local files).

use crate::io::export;
use crate::net::gdoc;
use crate::net::geoguessr;
use crate::plugins::user;
use crate::types::AppResult;
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;
use tauri::async_runtime;
use tauri::http::response::Builder;
use tauri::http::{header, Method, Request, Response as HttpResponse};
use tauri::UriSchemeResponder;

type Reply = HttpResponse<Vec<u8>>;

fn build_client(follow_redirects: bool) -> Client {
    let redirect = if follow_redirects {
        Policy::default()
    } else {
        Policy::none()
    };
    Client::builder()
        .use_rustls_tls()
        .redirect(redirect)
        .timeout(Duration::from_secs(15))
        .build()
        .expect("failed to build http client")
}

/// Follows redirects (svtile tiles, gmaps RPC, gdoc).
pub(crate) fn proxy_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| build_client(true))
}

/// Sync transfers move whole maps, far past the proxy client's 15s total cap, so this client
/// bounds the CONNECT, not the transfer.
pub(crate) fn sync_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .use_rustls_tls()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(300))
            .build()
            .expect("failed to build sync http client")
    })
}

/// Does NOT follow redirects, so the `Location` header is readable (googl).
fn resolve_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| build_client(false))
}

/// Response builder pre-seeded with the CORS header every scheme handler sends.
pub(crate) fn cors() -> Builder {
    HttpResponse::builder().header("Access-Control-Allow-Origin", "*")
}

pub(crate) fn cors_resp(status: u16, body: Vec<u8>) -> Reply {
    cors().status(status).body(body).unwrap()
}

pub(crate) fn proxy_error(msg: String) -> Reply {
    cors_resp(502, msg.into_bytes())
}

fn preflight(methods: &str) -> Reply {
    cors()
        .status(204)
        .header("Access-Control-Allow-Methods", methods)
        .header("Access-Control-Allow-Headers", "*")
        .body(Vec::new())
        .unwrap()
}

fn header_str(req: &Request<Vec<u8>>, name: header::HeaderName) -> Option<&str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// A custom-scheme request in one shape, whether the desktop webview or the web server received it.
#[derive(Debug, PartialEq)]
pub(crate) struct SchemeCall {
    method: Method,
    path: String,
    query: Option<String>,
    content_type: Option<String>,
    user_agent: Option<String>,
    body: Vec<u8>,
}

impl SchemeCall {
    fn from_desktop(req: &Request<Vec<u8>>) -> Self {
        Self {
            method: req.method().clone(),
            path: req.uri().path().to_string(),
            query: req.uri().query().map(str::to_string),
            content_type: header_str(req, header::CONTENT_TYPE).map(str::to_string),
            user_agent: header_str(req, header::USER_AGENT).map(str::to_string),
            body: req.body().clone(),
        }
    }

    /// The web server strips the leading slash and sends empty strings for absent parts.
    #[cfg(any(test, feature = "web-serve"))]
    pub(crate) fn from_web(
        method: &str,
        path: &str,
        query: String,
        content_type: String,
        user_agent: String,
        body: Vec<u8>,
    ) -> Self {
        let present = |s: String| (!s.is_empty()).then_some(s);
        Self {
            method: Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET),
            path: format!("/{path}"),
            query: present(query),
            content_type: present(content_type),
            user_agent: present(user_agent),
            body,
        }
    }

    fn decoded_path(&self) -> String {
        percent_encoding::percent_decode_str(&self.path)
            .decode_utf8_lossy()
            .into_owned()
    }

    fn query_suffix(&self) -> String {
        self.query
            .as_deref()
            .map(|q| format!("?{q}"))
            .unwrap_or_default()
    }

    fn id(&self) -> &str {
        self.path.trim_start_matches('/')
    }
}

/// Run a blocking scheme-handler body off the webview thread, on Tauri's bounded
/// blocking thread pool rather than an unbounded OS thread per request.
fn respond_async(responder: UriSchemeResponder, f: impl FnOnce() -> Reply + Send + 'static) {
    async_runtime::spawn_blocking(move || responder.respond(f()));
}

/// Relays an upstream response body + content-type back to the webview with CORS.
pub(crate) fn relay(resp: Response, default_ct: &str) -> Reply {
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(default_ct)
        .to_string();
    match resp.bytes() {
        Ok(body) => cors()
            .status(status)
            .header("Content-Type", content_type)
            .body(body.to_vec())
            .unwrap(),
        Err(e) => proxy_error(format!("read error: {e}")),
    }
}

/// mma-buf POST: write an uploaded file into its session dir. The target must
/// sit directly inside a valid `mma_upload_*` session dir (see
/// [`crate::io::export::upload_session_dir`]) -- anything else is rejected.
pub(crate) fn write_upload(path: &str, body: &[u8]) -> Reply {
    let target = Path::new(path);
    let session_ok = target
        .parent()
        .and_then(|p| p.to_str())
        .is_some_and(|p| export::upload_session_dir(p).is_ok());
    if !session_ok {
        return cors_resp(403, b"upload outside session dir".to_vec());
    }
    match fs::write(target, body) {
        Ok(()) => cors_resp(200, vec![]),
        Err(e) => cors_resp(500, format!("upload write failed: {e}").into_bytes()),
    }
}

/// mma-buf paths arrive with a leading slash that must go in front of a Windows drive letter.
fn local_path(raw: &str) -> &str {
    let trimmed = raw.trim_start_matches('/');
    let is_drive = trimmed.starts_with(|c: char| c.is_ascii_alphabetic())
        && trimmed.as_bytes().get(1) == Some(&b':');
    if is_drive {
        trimmed
    } else {
        raw
    }
}

fn read_local(clean: &str) -> Reply {
    let t = Instant::now();
    match fs::read(clean) {
        Ok(data) => {
            log::debug!(
                "[mma-buf] read {} bytes in {:.1}ms",
                data.len(),
                t.elapsed().as_secs_f64() * 1000.0
            );
            cors()
                .header("Content-Type", "application/octet-stream")
                .body(data)
                .unwrap()
        }
        Err(e) => cors_resp(404, format!("file not found: {clean} - {e}").into_bytes()),
    }
}

fn svtile_url(path: &str, query: &str) -> String {
    format!(
        "https://lh3.ggpht.com/jsapi2/a/b/c/{}{query}",
        path.trim_start_matches('/')
    )
}

/// svtile: StreetView photosphere tiles via lh3.ggpht.com.
pub(crate) fn fetch_svtile(url: &str) -> Reply {
    match proxy_client().get(url).send() {
        Ok(resp) => {
            let mut out = relay(resp, "image/jpeg");
            if let Ok(v) = "private, max-age=86400".parse() {
                out.headers_mut().insert(header::CACHE_CONTROL, v);
            }
            out
        }
        Err(e) => proxy_error(format!("svtile fetch error: {e}")),
    }
}

fn gmaps_url(path: &str, query: &str) -> String {
    format!("https://www.google.com{path}{query}")
}

/// gmaps: forward a request (POST batchexecute etc.) to www.google.com.
pub(crate) fn proxy_gmaps(
    method: Method,
    url: &str,
    content_type: String,
    user_agent: String,
    body: Vec<u8>,
) -> Reply {
    match proxy_client()
        .request(method, url)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::USER_AGENT, user_agent)
        .body(body)
        .send()
    {
        Ok(resp) => relay(resp, "text/plain"),
        Err(e) => proxy_error(format!("gmaps fetch error: {e}")),
    }
}

fn googl_url(id: &str, mapsapp: bool) -> String {
    if mapsapp {
        format!("https://maps.app.goo.gl/{id}")
    } else {
        format!("https://goo.gl/maps/{id}")
    }
}

/// The URL a goo.gl / maps.app.goo.gl short link redirects to, from its `Location`
/// header; `None` for a link that answers without one.
pub(crate) fn short_link_target(id: &str, mapsapp: bool) -> AppResult<Option<String>> {
    let resp = resolve_client()
        .get(googl_url(id, mapsapp))
        .send()
        .map_err(|e| format!("googl fetch error: {e}"))?;
    Ok(resp
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned))
}

/// googl: resolve a goo.gl / maps.app.goo.gl short link by reading its redirect
/// `Location` header; returns the target URL as a JSON string.
pub(crate) fn resolve_googl(id: &str, mapsapp: bool) -> Reply {
    match short_link_target(id, mapsapp) {
        Ok(Some(location)) => cors()
            .status(200)
            .header("Content-Type", "application/json")
            .body(
                serde_json::to_string(&location)
                    .unwrap_or_default()
                    .into_bytes(),
            )
            .unwrap(),
        Ok(None) => cors_resp(404, Vec::new()),
        Err(e) => proxy_error(e.to_string()),
    }
}

pub(crate) struct Scheme {
    pub(crate) name: &'static str,
    /// Methods a cross-origin preflight allows; schemes without one are never preflighted.
    preflight: Option<&'static str>,
    pub(crate) handle: fn(SchemeCall) -> Reply,
}

/// Every custom URI scheme, served the same way by the desktop app and the web server.
pub(crate) const SCHEMES: &[Scheme] = &[
    Scheme {
        name: "mma-buf",
        preflight: Some("GET, POST, OPTIONS"),
        handle: |c| {
            let raw = c.decoded_path();
            if c.method == Method::POST {
                write_upload(local_path(&raw), &c.body)
            } else {
                read_local(local_path(&raw))
            }
        },
    },
    Scheme {
        name: "mma-plugin",
        preflight: None,
        handle: |c| user::serve_file(&c.decoded_path()),
    },
    Scheme {
        name: "svtile",
        preflight: None,
        handle: |c| fetch_svtile(&svtile_url(&c.path, &c.query_suffix())),
    },
    Scheme {
        name: "gmaps",
        preflight: None,
        handle: |c| {
            let url = gmaps_url(&c.path, &c.query_suffix());
            let content_type = c
                .content_type
                .unwrap_or_else(|| "application/x-www-form-urlencoded".to_string());
            proxy_gmaps(
                c.method,
                &url,
                content_type,
                c.user_agent.unwrap_or_default(),
                c.body,
            )
        },
    },
    Scheme {
        name: "ggapi",
        preflight: Some("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        handle: |c| {
            geoguessr::proxy(
                c.method,
                &c.path,
                c.query.as_deref(),
                c.content_type.as_deref(),
                c.body,
            )
        },
    },
    Scheme {
        name: "gdoc",
        preflight: None,
        handle: |c| gdoc::fetch_gdoc(c.id()),
    },
    Scheme {
        name: "googl",
        preflight: None,
        handle: |c| {
            let mapsapp = c
                .query
                .as_deref()
                .unwrap_or("")
                .split('&')
                .any(|kv| kv == "source=mapsapp");
            resolve_googl(c.id(), mapsapp)
        },
    },
];

/// Register every custom URI scheme on the Tauri builder.
pub(crate) fn register_schemes(
    mut builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    for scheme in SCHEMES {
        builder = builder.register_asynchronous_uri_scheme_protocol(
            scheme.name,
            move |_ctx, req, responder| {
                if let (Some(methods), &Method::OPTIONS) = (scheme.preflight, req.method()) {
                    return responder.respond(preflight(methods));
                }
                let call = SchemeCall::from_desktop(&req);
                let handle = scheme.handle;
                respond_async(responder, move || handle(call));
            },
        );
    }
    builder
}

#[cfg(test)]
#[path = "proxy.test.rs"]
mod proxy_tests;
