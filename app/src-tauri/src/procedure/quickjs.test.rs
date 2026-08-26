use super::*;
use serde_json::Value as Json;

/// One row, carrying every field the boundary promises a procedure.
const ROWS: &str = r#"[{"id":7,"lat":1.5,"lng":2.5,"heading":90,"pitch":-1,"zoom":3,
  "flags":2,"createdAt":1000,"modifiedAt":null,"panoId":"pano-a","tags":[4,9],
  "extra":{"k":"v"}}]"#;

fn rows() -> Vec<u8> {
    ROWS.as_bytes().to_vec()
}

fn load(src: &str) -> AppResult<JsProcedure> {
    JsProcedure::load_source(src, "fixture.js")
}

fn loaded(src: &str) -> JsProcedure {
    load(src).expect("fixture loads")
}

fn empty_response() -> HttpResponse {
    HttpResponse {
        status: 0,
        body: Vec::new(),
    }
}

/// The single patch a fixture answered with, parsed.
fn only_patch(patches: &[PatchEntry]) -> Json {
    assert_eq!(patches.len(), 1, "expected one patch, got {patches:?}");
    serde_json::from_str(&patches[0].patch).expect("patch is JSON")
}

fn extra(patches: &[PatchEntry]) -> Json {
    only_patch(patches)["extra"].clone()
}

#[derive(Default)]
struct MockProcHost {
    requests: Vec<HttpRequestSpec>,
    /// Requests per `fetch_many` call, so a test can tell one batched call from many.
    many: Vec<usize>,
    /// Canned answer; without one the mock echoes the request URL back as the body.
    response: Option<HttpResponse>,
    /// URLs the mock refuses, so a test can watch a failed request come back.
    refuse: Vec<String>,
    progress: Vec<u32>,
    failed: Vec<u32>,
    abort: bool,
    classified: Vec<(String, f64, f64)>,
    classify_answer: Option<String>,
    sidecar_calls: Vec<(String, String, String)>,
    sidecar_lines: Vec<String>,
    /// Interleaving of `line` pulls and `progress` calls, to pin that a line handler's
    /// progress reaches the host before the next line is pulled.
    trace: Arc<Mutex<Vec<&'static str>>>,
}

impl ProcHost for MockProcHost {
    fn fetch(&mut self, req: &HttpRequestSpec) -> AppResult<HttpResponse> {
        self.requests.push(req.clone());
        if self.refuse.contains(&req.url) {
            return Err(AppError(format!("mock refused {}", req.url)));
        }
        Ok(self.response.clone().unwrap_or(HttpResponse {
            status: 200,
            body: req.url.clone().into_bytes(),
        }))
    }
    fn fetch_many(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        self.many.push(reqs.len());
        reqs.iter().map(|r| self.fetch(r)).collect()
    }
    fn classify(&mut self, dataset: &str, lat: f64, lng: f64) -> AppResult<Option<String>> {
        self.classified.push((dataset.to_string(), lat, lng));
        Ok(self.classify_answer.clone())
    }
    fn sidecar(
        &mut self,
        plugin_id: &str,
        command: &str,
        payload_json: &str,
    ) -> AppResult<SidecarStream> {
        self.sidecar_calls.push((
            plugin_id.to_string(),
            command.to_string(),
            payload_json.to_string(),
        ));
        let trace = self.trace.clone();
        Ok(Box::new(self.sidecar_lines.clone().into_iter().map(move |l| {
            trace.lock().unwrap().push("line");
            Ok(l)
        })))
    }
    fn progress(&mut self, units: u32) {
        self.trace.lock().unwrap().push("progress");
        self.progress.push(units);
    }
    fn fail(&mut self, id: u32) {
        self.failed.push(id);
    }
    fn aborted(&self) -> bool {
        self.abort
    }
}

/// Answers one patch per row, carrying `payload` as the patch's `extra`.
fn echo_map(payload: &str) -> String {
    format!(
        "export function map(rows, response) {{
           return rows.map(r => ({{ id: r.id, patch: {{ extra: {payload} }} }}));
         }}"
    )
}

// -----------------------------------------------------------------------
// Shape detection
// -----------------------------------------------------------------------

#[test]
fn a_lone_map_export_is_map_only() {
    assert_eq!(loaded(&echo_map("null")).shape(), ProcShape::MapOnly);
}

#[test]
fn a_run_export_is_the_run_shape() {
    let proc = loaded("export function run(rows) { return []; }");
    assert_eq!(proc.shape(), ProcShape::Run);
}

#[test]
fn request_beside_map_is_the_request_map_shape() {
    let proc = loaded(&format!(
        "export function request(rows) {{ return {{ method: 'GET', url: 'https://x.test/' }}; }}\n{}",
        echo_map("null")
    ));
    assert_eq!(proc.shape(), ProcShape::RequestMap);
}

#[test]
fn run_wins_over_map_when_both_are_exported() {
    let proc = loaded(&format!(
        "export function run(rows) {{ return []; }}\n{}",
        echo_map("null")
    ));
    assert_eq!(proc.shape(), ProcShape::Run);
}

#[test]
fn a_module_with_no_entry_point_is_rejected() {
    let err = load("export function helper() { return 1; }").expect_err("no entry point");
    assert!(
        err.0.contains("no procedure entry point"),
        "unexpected error: {}",
        err.0
    );
}

#[test]
fn request_without_map_is_rejected() {
    let err = load("export function request(rows) { return {}; }").expect_err("request alone");
    assert!(
        err.0.contains("`request` without `map`"),
        "unexpected error: {}",
        err.0
    );
}

#[test]
fn a_module_that_does_not_parse_is_rejected() {
    let err = load("export function map( {").expect_err("syntax error");
    assert!(
        err.0.starts_with("fixture.js:"),
        "unexpected error: {}",
        err.0
    );
}

// -----------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------

#[test]
fn rows_arrive_as_parsed_objects() {
    let mut proc = loaded(&echo_map(
        "{ n: rows.length, lat: r.lat, pano: r.panoId, tags: r.tags,
           carried: r.extra, mod: r.modifiedAt, flags: r.flags }",
    ));
    let mut host = MockProcHost::default();
    let patches = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect("map succeeds");
    assert_eq!(patches[0].id, 7);
    assert_eq!(
        extra(&patches),
        serde_json::json!({
            "n": 1, "lat": 1.5, "pano": "pano-a", "tags": [4, 9],
            "carried": { "k": "v" }, "mod": null, "flags": 2,
        })
    );
}

#[test]
fn run_answers_with_patches() {
    let mut proc = loaded(
        "export function run(rows) {
           return [{ id: rows[0].id, patch: { lat: 9.5, panoId: null } },
                   { id: 42, patch: { extra: { a: 1 } } }];
         }",
    );
    let mut host = MockProcHost::default();
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    assert_eq!(patches.len(), 2);
    assert_eq!(patches[0].id, 7);
    assert_eq!(patches[0].patch, r#"{"lat":9.5,"panoId":null}"#);
    assert_eq!(
        patches[1],
        PatchEntry {
            id: 42,
            patch: r#"{"extra":{"a":1}}"#.into()
        }
    );
}

#[test]
fn map_sees_the_response_status_and_body() {
    let mut proc = loaded(&echo_map(
        "{ status: response.status, body: new TextDecoder().decode(response.body),
           len: response.body.length, kind: response.body.constructor.name }",
    ));
    let mut host = MockProcHost::default();
    let patches = proc
        .map(
            &rows(),
            &HttpResponse {
                status: 207,
                body: br#"{"echo":1}"#.to_vec(),
            },
            &mut host,
        )
        .expect("map succeeds");
    assert_eq!(
        extra(&patches),
        serde_json::json!({
            "status": 207, "body": "{\"echo\":1}", "len": 10, "kind": "Uint8Array",
        })
    );
}

#[test]
fn request_becomes_an_http_request_spec() {
    let mut proc = loaded(&format!(
        "export function request(rows) {{
           return {{ method: 'POST', url: 'https://x.test/' + rows[0].id,
                    headers: {{ 'X-A': '1' }}, body: new Uint8Array([1, 2, 3]) }};
         }}\n{}",
        echo_map("null")
    ));
    let spec = proc.request(&rows()).expect("request succeeds");
    assert_eq!(spec.method, "POST");
    assert_eq!(spec.url, "https://x.test/7");
    assert_eq!(spec.headers, vec![("X-A".to_string(), "1".to_string())]);
    assert_eq!(spec.body, Some(vec![1, 2, 3]));
}

#[test]
fn a_request_body_may_be_a_string_and_headers_may_be_absent() {
    let mut proc = loaded(&format!(
        "export function request(rows) {{
           return {{ method: 'GET', url: 'https://x.test/', body: 'hi' }};
         }}\n{}",
        echo_map("null")
    ));
    let spec = proc.request(&rows()).expect("request succeeds");
    assert!(spec.headers.is_empty());
    assert_eq!(spec.body, Some(b"hi".to_vec()));
}

#[test]
fn query_round_trips_json() {
    let mut proc = loaded(&format!(
        "export function query(input) {{ return {{ doubled: input.n * 2, list: input.list }}; }}\n{}",
        echo_map("null")
    ));
    let mut host = MockProcHost::default();
    let out = proc
        .query(br#"{"n":21,"list":["a"]}"#, &mut host)
        .expect("query succeeds");
    assert_eq!(
        serde_json::from_slice::<Json>(&out).expect("answer is JSON"),
        serde_json::json!({ "doubled": 42, "list": ["a"] })
    );
}

#[test]
fn a_module_without_query_says_so() {
    let mut proc = loaded(&echo_map("null"));
    let mut host = MockProcHost::default();
    let err = proc.query(b"{}", &mut host).expect_err("no query export");
    assert!(err.0.contains("no `query`"), "unexpected error: {}", err.0);
}

#[test]
fn a_shape_only_answers_its_own_entry_points() {
    let mut proc = loaded(&echo_map("null"));
    let mut host = MockProcHost::default();
    assert!(proc.run(&rows(), &mut host).is_err());
    assert!(proc.request(&rows()).is_err());
}

#[test]
fn an_async_entry_point_settles_before_it_answers() {
    let mut proc = loaded(
        "export async function run(rows) {
           await Promise.resolve();
           return [{ id: rows[0].id, patch: { extra: { awaited: true } } }];
         }",
    );
    let mut host = MockProcHost::default();
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    assert_eq!(extra(&patches), serde_json::json!({ "awaited": true }));
}

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------

const CONFIGURABLE: &str = "
  let cfg = null;
  export function configure(c) { cfg = c; }
  export function map(rows, response) {
    return [{ id: rows[0].id, patch: { extra: cfg } }];
  }";

#[test]
fn configuration_reaches_the_module_before_the_entry_point() {
    let mut proc = loaded(CONFIGURABLE);
    proc.configure(r#"{"fields":["a"],"force":true,"config":{"k":1}}"#)
        .expect("configure");
    let mut host = MockProcHost::default();
    let patches = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect("map succeeds");
    assert_eq!(
        extra(&patches),
        serde_json::json!({ "fields": ["a"], "force": true, "config": { "k": 1 } })
    );
}

#[test]
fn a_module_without_configure_ignores_configuration() {
    let mut proc = loaded(&echo_map("1"));
    proc.configure(r#"{"fields":[],"force":false,"config":null}"#)
        .expect("configure");
    let mut host = MockProcHost::default();
    assert!(proc.map(&rows(), &empty_response(), &mut host).is_ok());
}

// -----------------------------------------------------------------------
// Host services
// -----------------------------------------------------------------------

#[test]
fn a_run_shape_reaches_fetch() {
    let mut proc = loaded(
        "export function run(rows) {
           const r = mma.fetch({ method: 'POST', url: 'https://example.test/v1',
                                 headers: { 'X-Test': '1' }, body: 'hello' });
           return [{ id: rows[0].id, patch: { extra: {
             status: r.status, body: new TextDecoder().decode(r.body) } } }];
         }",
    );
    let mut host = MockProcHost {
        response: Some(HttpResponse {
            status: 207,
            body: br#"{"echo":1}"#.to_vec(),
        }),
        ..Default::default()
    };
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    assert_eq!(host.requests.len(), 1);
    assert_eq!(host.requests[0].method, "POST");
    assert_eq!(host.requests[0].url, "https://example.test/v1");
    assert_eq!(
        host.requests[0].headers,
        vec![("X-Test".to_string(), "1".to_string())]
    );
    assert_eq!(host.requests[0].body, Some(b"hello".to_vec()));
    assert_eq!(
        extra(&patches),
        serde_json::json!({ "status": 207, "body": "{\"echo\":1}" })
    );
}

#[test]
fn fetch_many_answers_in_order_and_reports_a_failure_as_status_zero() {
    let mut proc = loaded(
        "export function run(rows) {
           const d = new TextDecoder();
           const rs = mma.fetchMany([
             { method: 'GET', url: 'https://example.test/a' },
             { method: 'GET', url: 'https://example.test/b' },
             { method: 'GET', url: 'https://example.test/c' },
           ]);
           return [{ id: rows[0].id, patch: { extra: {
             bodies: rs.map(r => d.decode(r.body)),
             statuses: rs.map(r => r.status) } } }];
         }",
    );
    let mut host = MockProcHost {
        refuse: vec!["https://example.test/b".into()],
        ..Default::default()
    };
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    // One batched call, not three serial ones: that is the whole point of fetchMany.
    assert_eq!(host.many, vec![3]);
    assert_eq!(
        extra(&patches),
        serde_json::json!({
            "bodies": ["https://example.test/a", "", "https://example.test/c"],
            "statuses": [200, 0, 200],
        })
    );
}

#[test]
fn classify_reaches_the_host_from_map() {
    let mut proc = loaded(&echo_map("{ name: mma.classify('borders', r.lat, r.lng) }"));
    let mut host = MockProcHost {
        classify_answer: Some("FR".into()),
        ..Default::default()
    };
    let patches = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect("map succeeds");
    assert_eq!(host.classified, vec![("borders".to_string(), 1.5, 2.5)]);
    assert_eq!(extra(&patches), serde_json::json!({ "name": "FR" }));
}

#[test]
fn classify_answers_null_outside_every_feature() {
    let mut proc = loaded(&echo_map("{ name: mma.classify('borders', 0, 0) }"));
    let mut host = MockProcHost::default();
    let patches = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect("map succeeds");
    assert_eq!(extra(&patches), serde_json::json!({ "name": null }));
}

#[test]
fn sidecar_lines_reach_a_run_shape() {
    let mut proc = loaded(
        "export function run(rows) {
           const lines = mma.sidecar('plug', 'cmd', JSON.stringify({ a: 1 }));
           return [{ id: rows[0].id, patch: { extra: { lines } } }];
         }",
    );
    let mut host = MockProcHost {
        sidecar_lines: vec!["one".into(), "two".into()],
        ..Default::default()
    };
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    assert_eq!(
        host.sidecar_calls,
        vec![(
            "plug".to_string(),
            "cmd".to_string(),
            r#"{"a":1}"#.to_string()
        )]
    );
    assert_eq!(
        extra(&patches),
        serde_json::json!({ "lines": ["one", "two"] })
    );
}

#[test]
fn sidecar_lines_stream_to_a_handler_with_progress_serviced_between_them() {
    let mut proc = loaded(
        "export function run(rows) {
           const seen = [];
           const lines = mma.sidecar('plug', 'cmd', '{}', (line) => {
             seen.push(line + '!');
             mma.progress(1);
           });
           return [{ id: rows[0].id, patch: { extra: { seen, lines } } }];
         }",
    );
    let mut host = MockProcHost {
        sidecar_lines: vec!["one".into(), "two".into()],
        ..Default::default()
    };
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    assert_eq!(
        extra(&patches),
        serde_json::json!({ "seen": ["one!", "two!"], "lines": ["one", "two"] })
    );
    assert_eq!(host.progress, vec![1, 1]);
    assert_eq!(
        *host.trace.lock().unwrap(),
        vec!["line", "progress", "line", "progress"]
    );
}

#[test]
fn a_throwing_line_handler_fails_the_sidecar_call() {
    let mut proc = loaded(
        "export function run(rows) {
           mma.sidecar('plug', 'cmd', '{}', () => { throw new Error('bad line'); });
           return [];
         }",
    );
    let mut host = MockProcHost {
        sidecar_lines: vec!["one".into()],
        ..Default::default()
    };
    let err = proc.run(&rows(), &mut host).expect_err("handler error surfaces");
    assert!(err.0.contains("bad line"), "{}", err.0);
}

#[test]
fn a_line_handler_cannot_start_another_sidecar() {
    let mut proc = loaded(
        "export function run(rows) {
           mma.sidecar('plug', 'cmd', '{}', () => { mma.sidecar('plug', 'other', '{}'); });
           return [];
         }",
    );
    let mut host = MockProcHost {
        sidecar_lines: vec!["one".into()],
        ..Default::default()
    };
    let err = proc.run(&rows(), &mut host).expect_err("nested sidecar is refused");
    assert!(err.0.contains("line handler"), "{}", err.0);
}

#[test]
fn progress_and_fail_reach_the_host() {
    let mut proc = loaded(
        "export function run(rows) {
           mma.progress(3);
           mma.progress(1);
           mma.fail(9);
           return [];
         }",
    );
    let mut host = MockProcHost::default();
    assert!(proc
        .run(&rows(), &mut host)
        .expect("run succeeds")
        .is_empty());
    assert_eq!(host.progress, vec![3, 1]);
    assert_eq!(host.failed, vec![9]);
}

#[test]
fn aborted_reports_the_hosts_answer() {
    let src = "export function run(rows) {
                 let n = 0;
                 while (!mma.aborted() && n < 5) n++;
                 return [{ id: rows[0].id, patch: { extra: { n } } }];
               }";
    let mut host = MockProcHost {
        abort: true,
        ..Default::default()
    };
    let patches = loaded(src).run(&rows(), &mut host).expect("run succeeds");
    assert_eq!(extra(&patches), serde_json::json!({ "n": 0 }));

    let mut open = MockProcHost::default();
    let patches = loaded(src).run(&rows(), &mut open).expect("run succeeds");
    assert_eq!(extra(&patches), serde_json::json!({ "n": 5 }));
}

// -----------------------------------------------------------------------
// Effects gate
// -----------------------------------------------------------------------

/// The calls that reach outside the process, and the guest expression for each.
const EFFECTS: [(&str, &str); 3] = [
    (
        "fetch",
        "mma.fetch({ method: 'GET', url: 'https://x.test/' })",
    ),
    ("fetchMany", "mma.fetchMany([])"),
    ("sidecar", "mma.sidecar('p', 'c', '{}')"),
];

fn assert_gated(name: &str, err: &AppError) {
    let want = format!("mma.{name} is only available to `run`-shaped procedures");
    assert!(
        err.0.contains(&want),
        "unexpected error for {name}: {}",
        err.0
    );
}

#[test]
fn map_cannot_reach_the_effectful_host_calls() {
    for (name, call) in EFFECTS {
        let mut proc = loaded(&echo_map(&format!("{{ v: {call} }}")));
        let mut host = MockProcHost::default();
        let err = proc
            .map(&rows(), &empty_response(), &mut host)
            .expect_err("gate rejects the call");
        assert_gated(name, &err);
        assert!(host.requests.is_empty());
    }
}

#[test]
fn request_cannot_reach_the_effectful_host_calls() {
    for (name, call) in EFFECTS {
        let mut proc = loaded(&format!(
            "export function request(rows) {{ {call}; return {{ method: 'GET', url: '/' }}; }}\n{}",
            echo_map("null")
        ));
        let err = proc.request(&rows()).expect_err("gate rejects the call");
        assert_gated(name, &err);
    }
}

/// `request` is pure by construction: even the calls open to `map` have no host.
#[test]
fn request_has_no_host_for_the_calls_that_are_otherwise_open() {
    let mut proc = loaded(&format!(
        "export function request(rows) {{
           mma.classify('borders', 0, 0);
           return {{ method: 'GET', url: '/' }};
         }}\n{}",
        echo_map("null")
    ));
    let err = proc.request(&rows()).expect_err("no host attached");
    assert!(
        err.0.contains("no host attached"),
        "unexpected error: {}",
        err.0
    );
}

#[test]
fn query_reaches_the_effectful_host_calls() {
    let mut proc = loaded(&format!(
        "export function query(input) {{
           const r = mma.fetch({{ method: 'GET', url: 'https://example.test/q' }});
           return {{ status: r.status }};
         }}\n{}",
        echo_map("null")
    ));
    let mut host = MockProcHost::default();
    let out = proc.query(b"{}", &mut host).expect("query succeeds");
    assert_eq!(host.requests.len(), 1);
    assert_eq!(host.requests[0].url, "https://example.test/q");
    assert_eq!(out, br#"{"status":200}"#);
}

// -----------------------------------------------------------------------
// Failure modes
// -----------------------------------------------------------------------

#[test]
fn a_throwing_guest_is_an_error_not_a_panic() {
    let mut proc = loaded("export function map(rows, response) { throw new Error('boom'); }");
    let mut host = MockProcHost::default();
    let err = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect_err("guest threw");
    assert!(err.0.contains("boom"), "unexpected error: {}", err.0);
}

#[test]
fn a_rejected_async_entry_point_is_an_error() {
    let mut proc = loaded("export async function run(rows) { throw new Error('async boom'); }");
    let mut host = MockProcHost::default();
    let err = proc.run(&rows(), &mut host).expect_err("guest rejected");
    assert!(err.0.contains("async boom"), "unexpected error: {}", err.0);
}

#[test]
fn a_non_array_answer_is_rejected() {
    let mut proc = loaded("export function map(rows, response) { return 5; }");
    let mut host = MockProcHost::default();
    let err = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect_err("not an array");
    assert!(
        err.0.contains("array of patches"),
        "unexpected error: {}",
        err.0
    );
}

#[test]
fn a_fetch_the_host_refuses_throws_into_the_guest() {
    let mut proc = loaded(
        "export function run(rows) {
           try { mma.fetch({ method: 'GET', url: 'https://example.test/no' }); }
           catch (e) { return [{ id: rows[0].id, patch: { extra: { caught: String(e) } } }]; }
           return [];
         }",
    );
    let mut host = MockProcHost {
        refuse: vec!["https://example.test/no".into()],
        ..Default::default()
    };
    let patches = proc.run(&rows(), &mut host).expect("run succeeds");
    let caught = extra(&patches)["caught"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        caught.contains("mock refused"),
        "unexpected throw: {caught}"
    );
}

#[test]
fn an_aborted_run_interrupts_a_runaway_guest() {
    let mut proc = loaded("export function run(rows) { while (true) {} }");
    let mut host = MockProcHost {
        abort: true,
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let err = proc.run(&rows(), &mut host).expect_err("interrupted");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the interrupt did not stop the guest"
    );
    assert!(
        err.0.starts_with("fixture.js:"),
        "unexpected error: {}",
        err.0
    );
}

#[test]
fn a_procedure_still_works_after_an_interrupt() {
    let mut proc = loaded(
        "export function run(rows) {
           if (rows[0].id === 7) { while (true) {} }
           return [{ id: rows[0].id, patch: { extra: { ok: true } } }];
         }",
    );
    let mut aborting = MockProcHost {
        abort: true,
        ..Default::default()
    };
    assert!(proc.run(&rows(), &mut aborting).is_err());

    let mut host = MockProcHost::default();
    let other = br#"[{"id":8,"lat":0,"lng":0,"heading":0,"pitch":0,"zoom":0,"flags":0,
      "createdAt":0,"modifiedAt":null,"panoId":"","tags":[],"extra":null}]"#;
    let patches = proc.run(other, &mut host).expect("run succeeds");
    assert_eq!(extra(&patches), serde_json::json!({ "ok": true }));
}

// -----------------------------------------------------------------------
// Runtime prelude
// -----------------------------------------------------------------------

#[test]
fn the_prelude_carries_the_globals_bundled_code_expects() {
    let mut proc = loaded(&echo_map(
        r"{
          round: new TextDecoder().decode(new TextEncoder().encode('héllo 😀 ✓')),
          bytes: new TextEncoder().encode('😀').length,
          b64: btoa('Man'),
          unb64: atob(btoa('hello world')),
          padded: btoa('a'),
          replaced: new TextDecoder().decode(new Uint8Array([0xff, 0x41])),
          types: typeof console.log + typeof console.warn,
        }",
    ));
    let mut host = MockProcHost::default();
    let patches = proc
        .map(&rows(), &empty_response(), &mut host)
        .expect("map succeeds");
    assert_eq!(
        extra(&patches),
        serde_json::json!({
            "round": "héllo 😀 ✓",
            "bytes": 4,
            "b64": "TWFu",
            "unb64": "hello world",
            "padded": "YQ==",
            "replaced": "\u{fffd}A",
            "types": "functionfunction",
        })
    );
}

#[test]
fn console_output_does_not_fault_at_module_scope() {
    // The module body runs before any host is attached, so `console` must work there.
    let mut proc = loaded(&format!(
        "console.log('loaded', {{ a: 1 }});\n{}",
        echo_map("null")
    ));
    let mut host = MockProcHost::default();
    assert!(proc.map(&rows(), &empty_response(), &mut host).is_ok());
}

// -----------------------------------------------------------------------
// Module cache
// -----------------------------------------------------------------------

/// Loads counted around a body, so a test reads the pool's effect directly.
fn loads(body: impl FnOnce()) -> u32 {
    let before = LOADS.with(|c| c.get());
    body();
    LOADS.with(|c| c.get()) - before
}

/// Distinguishable module bodies: same exports, different sizes, so a rewrite
/// changes both halves of the stamp.
const SMALL: &str = "export function map(rows, response) { return []; }";
const LARGE: &str = "
  const padding = 'padding that makes the file a different length';
  export function map(rows, response) { return padding.length ? [] : []; }";

fn write_module(path: &Path, src: &str) {
    std::fs::write(path, src).expect("write module");
}

#[test]
fn a_warm_path_is_loaded_once() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("warm.js");
    write_module(&path, SMALL);

    assert_eq!(loads(|| drop(checkout(&path).expect("first"))), 1);
    assert_eq!(loads(|| drop(checkout(&path).expect("second"))), 0);
    assert_eq!(loads(|| drop(checkout(&path).expect("third"))), 0);
}

#[test]
fn a_rewritten_module_is_reloaded() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("rebuilt.js");
    write_module(&path, SMALL);
    drop(checkout(&path).expect("first"));

    write_module(&path, LARGE);
    assert_eq!(loads(|| drop(checkout(&path).expect("after rebuild"))), 1);
    // The rebuilt module is now the warm one; the stale copy is not handed back out.
    assert_eq!(loads(|| drop(checkout(&path).expect("warm again"))), 0);
}

#[test]
fn a_module_rewritten_while_on_loan_is_not_pooled() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("swapped.js");
    write_module(&path, SMALL);

    let borrowed = checkout(&path).expect("first");
    write_module(&path, LARGE);
    drop(borrowed);
    assert_eq!(loads(|| drop(checkout(&path).expect("after rebuild"))), 1);
}

#[test]
fn a_second_live_checkout_gets_its_own_procedure() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("concurrent.js");
    write_module(&path, SMALL);

    let first = checkout(&path).expect("first");
    assert_eq!(loads(|| drop(checkout(&path).expect("second"))), 1);
    drop(first);
    let a = checkout(&path).expect("third");
    assert_eq!(loads(|| drop(checkout(&path).expect("fourth"))), 0);
    drop(a);
}

#[test]
fn a_pooled_procedure_carries_no_configuration_from_its_last_borrower() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("configured.js");
    write_module(&path, CONFIGURABLE);
    let mut host = MockProcHost::default();

    let mut first = checkout(&path).expect("first");
    first
        .configure(r#"{"fields":["a"],"force":true,"config":{"k":1}}"#)
        .expect("configure");
    assert_eq!(
        extra(
            &first
                .map(&rows(), &empty_response(), &mut host)
                .expect("map")
        ),
        serde_json::json!({ "fields": ["a"], "force": true, "config": { "k": 1 } })
    );
    drop(first);

    let mut second = checkout(&path).expect("second");
    assert_eq!(second.inner().config, None);
    assert_eq!(
        extra(
            &second
                .map(&rows(), &empty_response(), &mut host)
                .expect("map")
        ),
        Json::Null
    );
}

#[test]
fn a_missing_module_is_an_error_and_is_not_pooled() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("absent.js");
    assert!(checkout(&path).is_err());
    write_module(&path, SMALL);
    assert_eq!(loads(|| drop(checkout(&path).expect("present now"))), 1);
}

#[test]
fn load_from_path_matches_load_source() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("frompath.js");
    write_module(&path, SMALL);
    assert_eq!(
        JsProcedure::load(&path).expect("loads from path").shape(),
        ProcShape::MapOnly
    );
}
