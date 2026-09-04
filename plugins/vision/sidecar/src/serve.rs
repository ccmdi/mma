//! Resident search server. One-shot search commands pay model + tokenizer + cache
//! load on every query; `serve` holds them in memory behind a localhost HTTP
//! endpoint, so repeat searches cost only inference. Binds an ephemeral port and
//! prints `{"port":N}` on stdout for the parent to read. Exits by itself after an
//! idle period, so a parent that died without killing it never leaves an orphan.

use std::time::{Duration, Instant};

use crate::embed::{self, EmbedCache};
use crate::search::{self, ImageSearchInput, TextSearchInput, TextSearcher};

pub struct ServeState {
    model_dir: String,
    cache_dir: String,
    cache: Option<(EmbedCache, Option<std::time::SystemTime>)>,
    /// Lazy: text search loads the ONNX session on first use, image search never does.
    text: Option<TextSearcher>,
}

impl ServeState {
    pub fn new(model_dir: &str, cache_dir: &str) -> Self {
        Self {
            model_dir: model_dir.to_string(),
            cache_dir: cache_dir.to_string(),
            cache: None,
            text: None,
        }
    }

    /// (Re)load the cache when the on-disk file's mtime changes — a concurrent
    /// `embed` run may rewrite it at any time.
    fn refresh_cache(&mut self) {
        let mtime = embed::cache_mtime(&self.cache_dir);
        let stale = match &self.cache {
            Some((_, loaded)) => *loaded != mtime,
            None => true,
        };
        if stale {
            self.cache = Some((EmbedCache::load(&self.cache_dir), mtime));
        }
    }

    fn cache(&mut self) -> &EmbedCache {
        self.refresh_cache();
        &self.cache.as_ref().unwrap().0
    }

    /// Route one request. Pure over (method, path, body) so the protocol is
    /// testable without sockets. Returns (status, response body).
    pub fn handle(&mut self, method: &str, path: &str, body: &str) -> (u16, String) {
        match (method, path) {
            ("GET", "/ping") => (200, r#"{"ok":true}"#.into()),
            ("POST", "/search-text") => {
                let input: TextSearchInput = match serde_json::from_str(body) {
                    Ok(i) => i,
                    Err(e) => return (400, err_body(&format!("bad input: {e}"))),
                };
                if self.text.is_none() {
                    match TextSearcher::load(&self.model_dir) {
                        Ok(t) => self.text = Some(t),
                        Err(e) => return (500, err_body(&e)),
                    }
                }
                self.refresh_cache();
                // Direct field access so the cache (shared) and searcher (mut)
                // borrows stay disjoint.
                let cache = &self.cache.as_ref().unwrap().0;
                let results = self.text.as_mut().unwrap().search(cache, &input);
                (200, serde_json::to_string(&results).unwrap())
            }
            ("POST", "/list-cached") => {
                let ids = self.cache().pano_ids();
                (200, serde_json::to_string(&ids).unwrap())
            }
            ("POST", "/search-image") => {
                let input: ImageSearchInput = match serde_json::from_str(body) {
                    Ok(i) => i,
                    Err(e) => return (400, err_body(&format!("bad input: {e}"))),
                };
                let results = search::image_search_in(self.cache(), &input);
                (200, serde_json::to_string(&results).unwrap())
            }
            _ => (404, err_body("not found")),
        }
    }
}

fn err_body(msg: &str) -> String {
    serde_json::to_string(&serde_json::json!({ "error": msg })).unwrap()
}

/// Blocking server loop. `idle_secs` without a request exits the process.
pub fn run(model_dir: &str, cache_dir: &str, idle_secs: u64) {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("failed to bind localhost");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a.port(),
        _ => unreachable!("ip listener"),
    };
    // The parent reads this line to find the endpoint.
    println!("{{\"port\":{port}}}");
    use std::io::Write;
    std::io::stdout().flush().ok();

    let mut state = ServeState::new(model_dir, cache_dir);
    let idle = Duration::from_secs(idle_secs);
    let mut last = Instant::now();
    loop {
        match server.recv_timeout(Duration::from_secs(5)) {
            Ok(Some(mut req)) => {
                last = Instant::now();
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let (status, resp) = state.handle(
                    req.method().as_str().to_uppercase().as_str(),
                    req.url(),
                    &body,
                );
                let response = tiny_http::Response::from_string(resp)
                    .with_status_code(status)
                    .with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    );
                let _ = req.respond(response);
            }
            Ok(None) => {
                if last.elapsed() >= idle {
                    eprintln!("[vision] serve idle for {idle_secs}s, exiting");
                    return;
                }
            }
            Err(e) => {
                eprintln!("[vision] serve error: {e}");
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "serve.test.rs"]
mod tests;
