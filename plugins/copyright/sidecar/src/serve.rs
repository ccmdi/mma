//! Resident detect server. A one-shot `detect` pays process spawn + model load on
//! every request, which dominates single-pano enrichment; `serve` holds the loaded
//! [`Detector`] in memory behind a localhost HTTP endpoint. Binds an ephemeral port
//! and prints `{"port":N}` on stdout for the parent to read. Exits by itself after
//! an idle period, so a parent that died without killing it never leaves an orphan.

use std::time::{Duration, Instant};

use crate::detect::{DetectInput, DetectResult, Detector};

pub struct ServeState {
    model_dir: String,
    /// Lazy: loaded on the first detect request, then reused.
    detector: Option<Detector>,
}

impl ServeState {
    pub fn new(model_dir: &str) -> Self {
        Self {
            model_dir: model_dir.to_string(),
            detector: None,
        }
    }

    /// Route one request. Pure over (method, path, body) so the protocol is
    /// testable without sockets. Returns (status, response body).
    pub fn handle(&mut self, method: &str, path: &str, body: &str) -> (u16, String) {
        match (method, path) {
            ("GET", "/ping") => (200, r#"{"ok":true}"#.into()),
            ("POST", "/detect") => {
                let input: DetectInput = match serde_json::from_str(body) {
                    Ok(i) => i,
                    Err(e) => return (400, err_body(&format!("bad input: {e}"))),
                };
                let detector = self
                    .detector
                    .get_or_insert_with(|| Detector::load(&self.model_dir));
                let mut results: Vec<DetectResult> = Vec::with_capacity(input.pano_ids.len());
                detector.run(&input, |r| results.push(r));
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
pub fn run(model_dir: &str, idle_secs: u64) {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("failed to bind localhost");
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a.port(),
        _ => unreachable!("ip listener"),
    };
    // The parent reads this line to find the endpoint.
    println!("{{\"port\":{port}}}");
    use std::io::Write;
    std::io::stdout().flush().ok();

    let mut state = ServeState::new(model_dir);
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
                    eprintln!("[copyright] serve idle for {idle_secs}s, exiting");
                    return;
                }
            }
            Err(e) => {
                eprintln!("[copyright] serve error: {e}");
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "serve.test.rs"]
mod tests;
