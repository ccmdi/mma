//! Outbound HTTP clients and the custom URI schemes that proxy the webview's
//! cross-origin requests (tiles, Google RPCs, GeoGuessr, short links, local files).

use reqwest::blocking::{Client, Response};
use tauri::http::{header, Method, Request, Response as HttpResponse};
use tauri::UriSchemeResponder;

type Reply = HttpResponse<Vec<u8>>;

fn build_client(follow_redirects: bool) -> Client {
    let redirect = if follow_redirects {
        reqwest::redirect::Policy::default()
    } else {
        reqwest::redirect::Policy::none()
    };
    Client::builder()
        .use_rustls_tls()
        .redirect(redirect)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("failed to build http client")
}

/// Follows redirects (svtile tiles, gmaps RPC, gdoc).
pub(crate) fn proxy_client() -> &'static Client {
    static C: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    C.get_or_init(|| build_client(true))
}

/// Sync transfers move whole maps, far past the proxy client's 15s total cap, so this client
/// bounds the CONNECT, not the transfer.
pub(crate) fn sync_client() -> &'static Client {
    static C: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .use_rustls_tls()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .expect("failed to build sync http client")
    })
}

/// Does NOT follow redirects, so the `Location` header is readable (googl).
fn resolve_client() -> &'static Client {
    static C: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    C.get_or_init(|| build_client(false))
}

/// Response builder pre-seeded with the CORS header every scheme handler sends.
pub(crate) fn cors() -> tauri::http::response::Builder {
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

fn path_and_query(req: &Request<Vec<u8>>) -> (String, String) {
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    (req.uri().path().to_string(), query)
}

/// Run a blocking scheme-handler body off the webview thread.
fn respond_async(responder: UriSchemeResponder, f: impl FnOnce() -> Reply + Send + 'static) {
    std::thread::spawn(move || responder.respond(f()));
}

/// Relays an upstream response body + content-type back to the webview with CORS.
pub(crate) fn relay(resp: Response, default_ct: &str) -> Reply {
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
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
/// [`crate::export::upload_session_dir`]) -- anything else is rejected.
pub(crate) fn write_upload(path: &str, body: &[u8]) -> Reply {
    let target = std::path::Path::new(path);
    let session_ok = target
        .parent()
        .and_then(|p| p.to_str())
        .is_some_and(|p| crate::export::upload_session_dir(p).is_ok());
    if !session_ok {
        return cors_resp(403, b"upload outside session dir".to_vec());
    }
    match std::fs::write(target, body) {
        Ok(()) => cors_resp(200, vec![]),
        Err(e) => cors_resp(500, format!("upload write failed: {e}").into_bytes()),
    }
}

/// mma-buf paths arrive with a leading slash that must go in front of a Windows drive letter.
fn local_path(raw: &str) -> &str {
    let trimmed = raw.trim_start_matches('/');
    let is_drive = trimmed.starts_with(|c: char| c.is_ascii_alphabetic())
        && trimmed.as_bytes().get(1) == Some(&b':');
    if is_drive { trimmed } else { raw }
}

fn read_local(clean: &str) -> Reply {
    let t = std::time::Instant::now();
    match std::fs::read(clean) {
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

/// gmaps: forward a request (POST batchexecute etc.) to www.google.com.
pub(crate) fn proxy_gmaps(
    method: reqwest::Method,
    url: &str,
    content_type: String,
    user_agent: String,
    body: Vec<u8>,
) -> Reply {
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
pub(crate) fn resolve_googl(id: &str, mapsapp: bool) -> Reply {
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
            Some(location) => cors()
                .status(200)
                .header("Content-Type", "application/json")
                .body(serde_json::to_string(location).unwrap_or_default().into_bytes())
                .unwrap(),
            None => cors_resp(404, Vec::new()),
        },
        Err(e) => proxy_error(format!("googl fetch error: {e}")),
    }
}

/// Register every custom URI scheme on the Tauri builder.
pub(crate) fn register_schemes(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .register_asynchronous_uri_scheme_protocol("mma-buf", |_ctx, req, responder| {
            if req.method() == Method::OPTIONS {
                return responder.respond(preflight("GET, POST, OPTIONS"));
            }
            let raw = percent_encoding::percent_decode_str(req.uri().path())
                .decode_utf8_lossy()
                .into_owned();
            let post_body = (req.method() == Method::POST).then(|| req.body().clone());
            respond_async(responder, move || match post_body {
                Some(body) => write_upload(local_path(&raw), &body),
                None => read_local(local_path(&raw)),
            });
        })
        .register_asynchronous_uri_scheme_protocol("mma-plugin", |_ctx, req, responder| {
            let path = percent_encoding::percent_decode_str(req.uri().path())
                .decode_utf8_lossy()
                .into_owned();
            respond_async(responder, move || crate::user_plugins::serve_file(&path));
        })
        .register_asynchronous_uri_scheme_protocol("svtile", |_ctx, req, responder| {
            let (path, query) = path_and_query(&req);
            let url = format!(
                "https://lh3.ggpht.com/jsapi2/a/b/c/{}{query}",
                path.trim_start_matches('/')
            );
            respond_async(responder, move || fetch_svtile(&url));
        })
        .register_asynchronous_uri_scheme_protocol("gmaps", |_ctx, req, responder| {
            let (path, query) = path_and_query(&req);
            let url = format!("https://www.google.com{path}{query}");
            let method = req.method().clone();
            let content_type = header_str(&req, header::CONTENT_TYPE)
                .unwrap_or("application/x-www-form-urlencoded")
                .to_string();
            let user_agent = header_str(&req, header::USER_AGENT).unwrap_or("").to_string();
            let body = req.body().clone();
            respond_async(responder, move || {
                proxy_gmaps(method, &url, content_type, user_agent, body)
            });
        })
        .register_asynchronous_uri_scheme_protocol("ggapi", |_ctx, req, responder| {
            if req.method() == Method::OPTIONS {
                return responder.respond(preflight("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
            }
            let path = req.uri().path().to_string();
            let query = req.uri().query().map(str::to_string);
            let method = req.method().clone();
            let content_type = header_str(&req, header::CONTENT_TYPE).map(str::to_string);
            let body = req.body().clone();
            respond_async(responder, move || {
                crate::geoguessr::proxy(method, &path, query.as_deref(), content_type, body)
            });
        })
        .register_asynchronous_uri_scheme_protocol("gdoc", |_ctx, req, responder| {
            let doc_id = req.uri().path().trim_start_matches('/').to_string();
            respond_async(responder, move || crate::gdoc::fetch_gdoc(&doc_id));
        })
        .register_asynchronous_uri_scheme_protocol("googl", |_ctx, req, responder| {
            let id = req.uri().path().trim_start_matches('/').to_string();
            let mapsapp = req
                .uri()
                .query()
                .unwrap_or("")
                .split('&')
                .any(|kv| kv == "source=mapsapp");
            respond_async(responder, move || resolve_googl(&id, mapsapp));
        })
}
