//! Resident detect server. A one-shot `detect` pays process spawn + model load on
//! every request, which dominates single-pano enrichment; `serve` holds the loaded
//! [`Detector`] in memory behind a localhost HTTP endpoint. Binds an ephemeral port
//! and prints `{"port":N}` on stdout for the parent to read. Exits by itself after
//! an idle period, so a parent that died without killing it never leaves an orphan.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use crate::detect::{DetectInput, Detector};

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
    /// testable without sockets.
    pub fn handle(&self, method: &str, path: &str, body: &str) -> Reply {
        match (method, path) {
            ("GET", "/ping") => Reply::Done(200, r#"{"ok":true}"#.into()),
            ("POST", "/detect") => match serde_json::from_str(body) {
                Ok(input) => Reply::Detect(input),
                Err(e) => Reply::Done(400, err_body(&format!("bad input: {e}"))),
            },
            _ => Reply::Done(404, err_body("not found")),
        }
    }

    /// Detect `input`, writing each result to `out` as one HTTP chunk the moment it is
    /// ready, so the caller sees progress per pano rather than per request.
    pub fn stream_detect(&mut self, input: &DetectInput, out: &mut dyn Write) -> io::Result<()> {
        let detector = self
            .detector
            .get_or_insert_with(|| Detector::load(&self.model_dir));
        let mut failed: Option<io::Error> = None;
        detector.run(input, |result| {
            if failed.is_none() {
                failed = write_chunk(out, &serde_json::to_string(&result).unwrap()).err();
            }
        });
        match failed {
            Some(e) => Err(e),
            None => end_chunks(out),
        }
    }
}

fn write_chunk(out: &mut dyn Write, line: &str) -> io::Result<()> {
    write!(out, "{:x}\r\n{line}\n\r\n", line.len() + 1)?;
    out.flush()
}

fn end_chunks(out: &mut dyn Write) -> io::Result<()> {
    out.write_all(b"0\r\n\r\n")?;
    out.flush()
}

pub enum Reply {
    Done(u16, String),
    Detect(DetectInput),
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
    io::stdout().flush().ok();

    let mut state = ServeState::new(model_dir);
    let idle = Duration::from_secs(idle_secs);
    let mut last = Instant::now();
    loop {
        match server.recv_timeout(Duration::from_secs(5)) {
            Ok(Some(mut req)) => {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let method = req.method().as_str().to_uppercase();
                match state.handle(&method, req.url(), &body) {
                    Reply::Done(status, resp) => {
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
                    Reply::Detect(input) => {
                        let mut out = req.into_writer();
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                        if let Err(e) = out
                            .write_all(head.as_bytes())
                            .and_then(|()| state.stream_detect(&input, &mut out))
                        {
                            eprintln!("[copyright] detect stream broke: {e}");
                        }
                    }
                }
                last = Instant::now();
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
