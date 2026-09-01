use super::*;
use crate::procedure::quickjs::JsProcedure;
use crate::store::arrow;
use crate::store::engine::{render_cell_idx, Store, StoreManager};
use crate::test_util::loc;
use crate::types::LocationFlags;
use crate::types::RawExtra;
use std::env;
use std::thread;
use tokio::time;

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

fn setup(locs: &[Location]) -> (StoreState, String) {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let map_id = format!("procedure-test-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let mut store = Store::new();
    store.map_id = Some(map_id.clone());
    store.batch = Some(arrow::locations_to_batch(&[]));
    for l in locs {
        store.overlay_add(vec![l.clone()]);
        let ci = render_cell_idx(l.lat, l.lng);
        store.cell_add_render(ci, l.id);
    }
    store.alive_count = locs.len();
    let mut mgr = StoreManager::new();
    mgr.stores.insert(map_id.clone(), store);
    (Mutex::new(mgr), map_id)
}

fn read_extra(state: &StoreState, map_id: &str, id: u32) -> Option<serde_json::Value> {
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map_id).unwrap();
    let rows = store.collect(&Selector::Locations {
        locations: vec![id],
        name: None,
    });
    rows[0]
        .extra
        .as_ref()
        .map(|e| serde_json::from_str(e.as_str()).unwrap())
}

fn read_loc(state: &StoreState, map_id: &str, id: u32) -> Location {
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map_id).unwrap();
    store
        .collect(&Selector::Locations {
            locations: vec![id],
            name: None,
        })
        .remove(0)
}

fn decl(id: &str, batch: BatchMode) -> ProviderDecl {
    ProviderDecl {
        id: id.into(),
        label: None,
        entry: Some("mock".into()),
        fields: Vec::new(),
        requires: Vec::new(),
        select: Selector::Everything,
        batch,
        sink: Sink::Patch,
        rate: None,
        retry: None,
        force: None,
        inflight: None,
        instances: Some(1),
        config: None,
    }
}

/// Wraps a synchronous answer in the async fetch seam. A test that observes how many
/// requests run together writes its own async closure instead.
fn sync_fetch(
    f: impl Fn(HttpRequestSpec) -> AppResult<HttpResponse> + Send + Sync + 'static,
) -> FetchFn {
    Box::new(move |req| {
        let answer = f(req);
        Box::pin(async move { answer })
    })
}

/// The rows a batch carries, as the QuickJS host would read them.
fn batch_rows(batch: &[u8]) -> AppResult<Vec<Location>> {
    serde_json::from_slice(batch).map_err(|e| AppError(format!("batch JSON is invalid: {e}")))
}

type MapFn = Arc<dyn Fn(&[Location]) -> AppResult<Vec<PatchEntry>> + Send + Sync>;

struct MockProc {
    shape: ProcShape,
    seen: Arc<Mutex<Vec<Vec<u32>>>>,
    on_map: MapFn,
    /// Reported to the host from `map`, proving `map` reaches the real host.
    fail_id: Option<u32>,
}

impl MockProc {
    fn handle(&mut self, batch: &[u8]) -> AppResult<Vec<PatchEntry>> {
        let rows = batch_rows(batch)?;
        self.seen
            .lock()
            .unwrap()
            .push(rows.iter().map(|r| r.id).collect());
        (self.on_map)(&rows)
    }
}

impl Procedure for MockProc {
    fn shape(&self) -> ProcShape {
        self.shape
    }
    fn request(&mut self, _batch: &[u8]) -> AppResult<HttpRequestSpec> {
        Ok(HttpRequestSpec {
            method: "GET".into(),
            url: "https://example.invalid/".into(),
            headers: Vec::new(),
            body: None,
        })
    }
    fn map(
        &mut self,
        batch: &[u8],
        _response: &HttpResponse,
        host: &mut dyn ProcHost,
    ) -> AppResult<Vec<PatchEntry>> {
        if let Some(id) = self.fail_id {
            host.fail(id);
        }
        self.handle(batch)
    }
    fn run(&mut self, batch: &[u8], _host: &mut dyn ProcHost) -> AppResult<Vec<PatchEntry>> {
        self.handle(batch)
    }
}

struct Harness {
    deps: EngineDeps,
    seen: Arc<Mutex<Vec<Vec<u32>>>>,
    cancel: Arc<AtomicBool>,
    /// Pages a `Collect` provider delivered, in the order they arrived.
    delivered: Arc<Mutex<Vec<ProcedureResult>>>,
}

/// Collects every progress event a run emits.
fn recording_sink() -> (Arc<ProgressSink>, Arc<Mutex<Vec<ProcedureProgress>>>) {
    let events: Arc<Mutex<Vec<ProcedureProgress>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (
        Arc::new(Box::new(move |e| sink.lock().unwrap().push(e))),
        events,
    )
}

impl Harness {
    fn new(shape: ProcShape, on_map: MapFn, fetch: FetchFn) -> Self {
        Harness::with_fail(shape, on_map, fetch, None)
    }

    fn with_fail(shape: ProcShape, on_map: MapFn, fetch: FetchFn, fail_id: Option<u32>) -> Self {
        let seen: Arc<Mutex<Vec<Vec<u32>>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_f = seen.clone();
        Harness {
            deps: EngineDeps {
                factory: Box::new(move |_| {
                    Ok(Box::new(MockProc {
                        shape,
                        seen: seen_f.clone(),
                        on_map: on_map.clone(),
                        fail_id,
                    }) as Box<dyn Procedure>)
                }),
                fetch,
                backoff: Duration::from_millis(1),
            },
            seen,
            cancel: Arc::new(AtomicBool::new(false)),
            delivered: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn map_only(on_map: MapFn) -> Self {
        Harness::new(
            ProcShape::MapOnly,
            on_map,
            sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        )
    }

    fn ctx<'a>(&'a self, state: &'a StoreState, map_id: &str) -> RunCtx<'a> {
        RunCtx {
            state,
            map_id: map_id.to_string(),
            run_id: 1,
            force: true,
            cancel: self.cancel.clone(),
            deps: &self.deps,
            progress: Arc::new(Box::new(|_| {})),
            results: {
                let sink = self.delivered.clone();
                Arc::new(Box::new(move |r| sink.lock().unwrap().push(r)))
            },
        }
    }
}

/// Every row gets the same `LocationPatch` JSON.
fn patch_all(json: &'static str) -> MapFn {
    Arc::new(move |rows: &[Location]| {
        Ok(rows
            .iter()
            .map(|r| PatchEntry {
                id: r.id,
                patch: json.to_string(),
            })
            .collect())
    })
}

/// Every row gets the same merge patch over `extra`.
fn patch_extra_all(json: &'static str) -> MapFn {
    Arc::new(move |rows: &[Location]| {
        let patch = format!(r#"{{"extra":{json}}}"#);
        Ok(rows
            .iter()
            .map(|r| PatchEntry {
                id: r.id,
                patch: patch.clone(),
            })
            .collect())
    })
}

// -----------------------------------------------------------------------
// Wave scheduling
// -----------------------------------------------------------------------

#[test]
fn waves_order_producers_before_consumers() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.requires = vec!["x".into()];
    // Declared consumer-first to prove ordering comes from the graph, not the input order.
    assert_eq!(provider_waves(&[b, a]), vec![vec![1], vec![0]]);
}

#[test]
fn waves_order_a_pano_resolver_before_its_consumers() {
    // `panoId` is a core column, not an `extra` key, but it schedules like any other:
    // the resolver declares it as a field and its consumers as a requirement.
    let mut resolve = decl("panoResolve", BatchMode::Chunk { size: 2 });
    resolve.fields = vec!["panoId".into()];
    let mut pin = decl("pinPano", BatchMode::PerRow);
    pin.requires = vec!["panoId".into()];
    let mut meta = decl("svMeta", BatchMode::PerRow);
    meta.fields = vec!["imageDate".into()];
    meta.requires = vec!["panoId".into()];
    let mut exact = decl("exactDate", BatchMode::PerRow);
    exact.requires = vec!["imageDate".into()];

    assert_eq!(
        provider_waves(&[pin, exact, meta, resolve]),
        vec![vec![3], vec![0, 2], vec![1]]
    );
}

#[test]
fn force_false_skips_rows_that_already_hold_a_core_column() {
    let mut resolved = loc(1, 1.0, 0.0);
    resolved.pano_id = Some("ABC".into());
    let (state, map_id) = setup(&[resolved, loc(2, 2.0, 0.0)]);
    let mut d = decl("panoResolve", BatchMode::PerRow);
    d.fields = vec!["panoId".into()];
    let h = Harness::map_only(patch_all(r#"{"panoId":"NEW"}"#));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.force = false;
    run_provider(&ctx, &d).unwrap();

    assert_eq!(*h.seen.lock().unwrap(), vec![vec![2]]);
    assert_eq!(read_loc(&state, &map_id, 1).pano_id.as_deref(), Some("ABC"));
    assert_eq!(read_loc(&state, &map_id, 2).pano_id.as_deref(), Some("NEW"));
}

#[test]
fn an_empty_pano_id_does_not_count_as_present() {
    let mut blank = loc(1, 1.0, 0.0);
    blank.pano_id = Some("".into());
    let (state, map_id) = setup(&[blank]);
    let mut d = decl("panoResolve", BatchMode::PerRow);
    d.fields = vec!["panoId".into()];
    let h = Harness::map_only(patch_all(r#"{"panoId":"NEW"}"#));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.force = false;
    run_provider(&ctx, &d).unwrap();

    assert_eq!(*h.seen.lock().unwrap(), vec![vec![1]]);
}

#[test]
fn waves_run_independent_providers_together() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    assert_eq!(provider_waves(&[a, b]), vec![vec![0, 1]]);
}

#[test]
fn waves_collapse_a_dependency_cycle() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    a.requires = vec!["y".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    b.requires = vec!["x".into()];
    assert_eq!(provider_waves(&[a, b]), vec![vec![0, 1]]);
}

#[test]
fn waves_ignore_a_providers_own_output() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    a.requires = vec!["x".into()];
    assert_eq!(provider_waves(&[a]), vec![vec![0]]);
}

// -----------------------------------------------------------------------
// Paging
// -----------------------------------------------------------------------

#[test]
fn pages_cap_at_page_size() {
    let locs: Vec<Location> = (1..=25_000u32)
        .map(|i| loc(i, i as f64 * 0.0001, 0.0))
        .collect();
    let (state, map_id) = setup(&locs);
    // One batch per page, so an observed batch is exactly one page.
    let d = decl("pager", BatchMode::Chunk { size: 1_000_000 });
    let h = Harness::map_only(Arc::new(|_| Ok(Vec::new())));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let seen = h.seen.lock().unwrap();
    let sizes: Vec<usize> = seen.iter().map(Vec::len).collect();
    assert_eq!(sizes, vec![PAGE_SIZE, PAGE_SIZE, 5_000]);
    assert_eq!(seen[0][0], 1);
    assert_eq!(*seen[0].last().unwrap(), 10_000);
    assert_eq!(seen[1][0], 10_001);
    assert_eq!(seen[2][0], 20_001);
}

#[test]
fn a_page_boundary_does_not_drain_the_pipeline() {
    // Two pages of one batch each. The first page's batch waits until the second page's
    // batch is running beside it, which a drain between pages would never allow.
    let locs: Vec<Location> = (1..=(PAGE_SIZE as u32 + 1))
        .map(|i| loc(i, i as f64 * 0.0001, 0.0))
        .collect();
    let (state, map_id) = setup(&locs);
    let d = decl("overlap", BatchMode::Chunk { size: 1_000_000 });
    let running = Arc::new(AtomicU32::new(0));
    let overlapped = Arc::new(AtomicBool::new(false));
    let (r, o) = (running.clone(), overlapped.clone());
    let h = Harness::new(
        ProcShape::Run,
        Arc::new(move |_| {
            r.fetch_add(1, Ordering::SeqCst);
            let t0 = Instant::now();
            while r.load(Ordering::SeqCst) < 2 && t0.elapsed() < Duration::from_secs(3) {
                thread::sleep(Duration::from_millis(5));
            }
            if r.load(Ordering::SeqCst) >= 2 {
                o.store(true, Ordering::SeqCst);
            }
            Ok(Vec::new())
        }),
        sync_fetch(|_| Err(AppError("no fetch expected".into()))),
    );
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    assert!(
        overlapped.load(Ordering::SeqCst),
        "the second page's batch never ran beside the first"
    );
}

#[test]
fn chunk_mode_splits_a_page_into_batches() {
    let locs: Vec<Location> = (1..=10u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("chunker", BatchMode::Chunk { size: 4 });
    let h = Harness::map_only(Arc::new(|_| Ok(Vec::new())));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let sizes: Vec<usize> = h.seen.lock().unwrap().iter().map(Vec::len).collect();
    assert_eq!(sizes, vec![4, 4, 2]);
}

// -----------------------------------------------------------------------
// Dedupe fan-out
// -----------------------------------------------------------------------

#[test]
fn dedupe_by_pano_fans_the_patch_out_to_every_sharer() {
    let with_pano = |id: u32, pano: &str| Location {
        pano_id: Some(pano.into()),
        ..loc(id, id as f64, 0.0)
    };
    let locs = vec![
        with_pano(1, "PANO_A"),
        with_pano(2, "PANO_A"),
        with_pano(3, "PANO_B"),
    ];
    let (state, map_id) = setup(&locs);
    let d = decl(
        "dedupe",
        BatchMode::DedupeBy {
            key: "panoId".into(),
        },
    );
    let h = Harness::map_only(patch_extra_all(r#"{"country":"JP"}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    // One representative per distinct pano id reaches the procedure.
    assert_eq!(*h.seen.lock().unwrap(), vec![vec![1, 3]]);
    for id in [1, 2, 3] {
        assert_eq!(
            read_extra(&state, &map_id, id).unwrap()["country"],
            serde_json::json!("JP"),
            "location {id}"
        );
    }
}

#[test]
fn dedupe_by_rejects_unsupported_keys() {
    let err = split_batches(
        &BatchMode::DedupeBy { key: "lat".into() },
        vec![loc(1, 0.0, 0.0)],
    )
    .err()
    .expect("unsupported key must be rejected");
    assert!(err.0.contains("unsupported"), "{}", err.0);
}

// -----------------------------------------------------------------------
// Retry
// -----------------------------------------------------------------------

fn status_sequence(statuses: Vec<u16>) -> (FetchFn, Arc<AtomicU32>) {
    let calls = Arc::new(AtomicU32::new(0));
    let c = calls.clone();
    let fetch: FetchFn = sync_fetch(move |_| {
        let i = c.fetch_add(1, Ordering::Relaxed) as usize;
        Ok(HttpResponse {
            status: *statuses.get(i).unwrap_or(statuses.last().unwrap()),
            body: Vec::new(),
        })
    });
    (fetch, calls)
}

fn run_retry(retry: RetrySpec, statuses: Vec<u16>) -> u32 {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let mut d = decl("retrier", BatchMode::PerRow);
    d.retry = Some(retry);
    let (fetch, calls) = status_sequence(statuses);
    let h = Harness::new(ProcShape::RequestMap, Arc::new(|_| Ok(Vec::new())), fetch);
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    calls.load(Ordering::Relaxed)
}

#[test]
fn retry_repeats_a_declared_status() {
    let calls = run_retry(
        RetrySpec {
            attempts: 3,
            on: vec![500],
        },
        vec![500, 200],
    );
    assert_eq!(calls, 2);
}

#[test]
fn retry_skips_an_undeclared_status() {
    let calls = run_retry(
        RetrySpec {
            attempts: 3,
            on: vec![429],
        },
        vec![500, 200],
    );
    assert_eq!(calls, 1);
}

#[test]
fn retry_stops_at_the_attempt_cap() {
    let calls = run_retry(
        RetrySpec {
            attempts: 3,
            on: vec![500],
        },
        vec![500],
    );
    assert_eq!(calls, 3);
}

#[test]
fn no_retry_spec_means_one_attempt() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let d = decl("once", BatchMode::PerRow);
    let (fetch, calls) = status_sequence(vec![500]);
    let h = Harness::new(ProcShape::RequestMap, Arc::new(|_| Ok(Vec::new())), fetch);
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

// -----------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------

#[test]
fn rate_limiter_holds_the_declared_floor() {
    // Bucket starts full (2), so 6 acquires wait for 4 refills at 2 per 100ms = 200ms.
    let l = RateLimiter::new(RateSpec {
        units: 2,
        per_ms: 100,
        cost: RateCost::Request,
    })
    .unwrap();
    let t = Instant::now();
    drive(async {
        for _ in 0..6 {
            l.acquire(1).await;
        }
    });
    let ms = t.elapsed().as_millis();
    assert!(ms >= 180, "6 acquires took only {ms}ms");
}

#[test]
fn rate_limiter_rejects_a_degenerate_spec() {
    assert!(RateLimiter::new(RateSpec {
        units: 0,
        per_ms: 100,
        cost: RateCost::Request,
    })
    .is_none());
}

#[test]
fn rate_cost_defaults_to_request() {
    let spec: RateSpec = serde_json::from_str(r#"{"units":10,"perMs":100}"#).unwrap();
    assert_eq!(spec.cost, RateCost::Request);
    let spec: RateSpec = serde_json::from_str(r#"{"units":10,"perMs":100,"cost":"row"}"#).unwrap();
    assert_eq!(spec.cost, RateCost::Row);
}

/// Runs `rows` locations as chunks of `chunk` through a RequestMap provider at the
/// given rate spec and returns how long the whole provider took.
fn timed_chunk_run(rows: u32, chunk: u32, rate: RateSpec) -> u128 {
    let locs: Vec<Location> = (1..=rows).map(|i| loc(i, i as f64 * 0.001, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let mut d = decl("rated", BatchMode::Chunk { size: chunk });
    d.rate = Some(rate);
    let (fetch, _) = status_sequence(vec![200]);
    let h = Harness::new(ProcShape::RequestMap, Arc::new(|_| Ok(Vec::new())), fetch);
    let t = Instant::now();
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    t.elapsed().as_millis()
}

#[test]
fn rate_cost_row_charges_one_token_per_row() {
    // Bucket holds 6. The first 6-row chunk drains it; the second waits a full refill.
    let ms = timed_chunk_run(
        12,
        6,
        RateSpec {
            units: 6,
            per_ms: 100,
            cost: RateCost::Row,
        },
    );
    assert!(ms >= 90, "two 6-row chunks at cost row took only {ms}ms");
}

#[test]
fn rate_cost_request_charges_one_token_per_batch() {
    // Same bucket and chunks, but 1 token each: both come out of the full bucket.
    let ms = timed_chunk_run(
        12,
        6,
        RateSpec {
            units: 6,
            per_ms: 100,
            cost: RateCost::Request,
        },
    );
    assert!(ms < 90, "two 6-row chunks at cost request took {ms}ms");
}

// -----------------------------------------------------------------------
// Cancel
// -----------------------------------------------------------------------

#[test]
fn cancel_stops_before_the_next_batch_and_keeps_applied_patches() {
    let locs: Vec<Location> = (1..=3u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("canceller", BatchMode::PerRow);
    let flag = Arc::new(AtomicBool::new(false));
    let f = flag.clone();
    let on_map: MapFn = Arc::new(move |rows: &[Location]| {
        f.store(true, Ordering::Relaxed);
        Ok(rows
            .iter()
            .map(|r| PatchEntry {
                id: r.id,
                patch: r#"{"extra":{"hit":true}}"#.into(),
            })
            .collect())
    });
    let mut h = Harness::map_only(on_map);
    h.cancel = flag;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert_eq!(h.seen.lock().unwrap().len(), 1, "only one batch should run");
    assert_eq!(
        read_extra(&state, &map_id, 1).unwrap()["hit"],
        serde_json::json!(true)
    );
    assert!(read_extra(&state, &map_id, 2).is_none());
    assert!(read_extra(&state, &map_id, 3).is_none());
}

// -----------------------------------------------------------------------
// Patch application
// -----------------------------------------------------------------------

#[test]
fn null_in_a_merge_patch_deletes_the_key() {
    let seeded = Location {
        extra: RawExtra::from_string(r#"{"a":1,"b":2}"#.into()),
        ..loc(1, 0.0, 0.0)
    };
    let (state, map_id) = setup(&[seeded]);
    let d = decl("deleter", BatchMode::PerRow);
    let h = Harness::map_only(patch_extra_all(r#"{"b":null,"c":3}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let extra = read_extra(&state, &map_id, 1).unwrap();
    assert_eq!(extra["a"], serde_json::json!(1));
    assert_eq!(extra["c"], serde_json::json!(3));
    assert!(extra.get("b").is_none(), "b should be deleted: {extra}");
}

#[test]
fn a_patch_that_sets_nothing_is_dropped() {
    for json in [r#"{}"#, r#"{"extra":{}}"#] {
        let updates = to_updates(&[PatchEntry {
            id: 1,
            patch: json.into(),
        }])
        .unwrap();
        assert!(updates.is_empty(), "{json} should produce no update");
    }
}

/// Every key `patch_keys()` reports must actually deserialize into its field: the keys
/// come from serializing the type, so a `rename_all` or attribute mismatch between the
/// two directions would otherwise pass silently. The destructuring below has no `..`,
/// so a new `LocationPatch` field breaks this test at compile time.
#[test]
fn patch_keys_cover_every_location_patch_field() {
    let mut obj = serde_json::Map::new();
    for key in patch_keys() {
        let sample = match key.as_str() {
            "lat" | "lng" | "heading" | "pitch" | "zoom" => serde_json::json!(1.5),
            "panoId" => serde_json::json!("PANO_X"),
            "flags" | "createdAt" | "modifiedAt" => serde_json::json!(3),
            "tags" => serde_json::json!([1, 2]),
            "extra" => serde_json::json!({ "a": 1 }),
            other => panic!("no sample value for patch key `{other}`"),
        };
        obj.insert(key.clone(), sample);
    }
    let json = serde_json::Value::Object(obj).to_string();
    let p: LocationPatch = serde_json::from_str(&json).unwrap();
    let LocationPatch {
        lat,
        lng,
        heading,
        pitch,
        zoom,
        pano_id,
        flags,
        tags,
        extra,
        created_at,
        modified_at,
    } = p;
    for (name, set) in [
        ("lat", lat.is_some()),
        ("lng", lng.is_some()),
        ("heading", heading.is_some()),
        ("pitch", pitch.is_some()),
        ("zoom", zoom.is_some()),
        ("panoId", pano_id.is_some()),
        ("flags", flags.is_some()),
        ("tags", tags.is_some()),
        ("extra", extra.is_some()),
        ("createdAt", created_at.is_some()),
        ("modifiedAt", modified_at.is_some()),
    ] {
        assert!(set, "`{name}` was not set by its wire key");
    }
}

#[test]
fn an_unknown_key_names_itself_in_the_error() {
    let Err(err) = to_updates(&[PatchEntry {
        id: 1,
        patch: r#"{"lat":1,"nope":2}"#.into(),
    }]) else {
        panic!("an unknown key must fail the batch");
    };
    assert!(err.0.contains("nope"), "{}", err.0);
}

#[test]
fn a_patch_that_is_not_an_object_is_an_error() {
    for json in [r#"[{"lat":1}]"#, r#""lat""#, "7"] {
        assert!(
            to_updates(&[PatchEntry {
                id: 1,
                patch: json.into()
            }])
            .is_err(),
            "{json} should not parse as a patch"
        );
    }
}

#[test]
fn a_patch_can_set_core_columns() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let d = decl("core", BatchMode::PerRow);
    let h = Harness::map_only(patch_all(
        r#"{"panoId":"PANO_X","lat":10.5,"lng":-20.25,"heading":42.0,"flags":1}"#,
    ));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let l = read_loc(&state, &map_id, 1);
    assert_eq!(l.pano_id.as_deref(), Some("PANO_X"));
    assert_eq!((l.lat, l.lng, l.heading), (10.5, -20.25, 42.0));
    assert_eq!(l.flags.bits(), 1);
}

#[test]
fn pano_id_null_clears_it() {
    let seeded = Location {
        pano_id: Some("PANO_A".into()),
        ..loc(1, 0.0, 0.0)
    };
    let (state, map_id) = setup(&[seeded]);
    let d = decl("clearer", BatchMode::PerRow);
    let h = Harness::map_only(patch_all(r#"{"panoId":null}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert_eq!(read_loc(&state, &map_id, 1).pano_id, None);
}

/// ABI v1 emitted a bare merge patch over `extra`; under v2 that reads as unknown
/// keys, and the batch must fail rather than write nothing and look successful.
#[test]
fn an_old_style_flat_patch_fails_the_batch() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let d = decl("stale", BatchMode::PerRow);
    let (sink, events) = recording_sink();
    let h = Harness::map_only(patch_all(r#"{"sunAzimuth":1}"#));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert_eq!((last.done, last.total, last.failed), (1, 1, 1));
    assert!(read_loc(&state, &map_id, 1).extra.is_none());
}

#[test]
fn a_provider_announces_its_total_before_its_first_batch() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0), loc(2, 1.0, 0.0)]);
    let d = decl("announcer", BatchMode::PerRow);
    let (sink, events) = recording_sink();
    let h = Harness::map_only(patch_all(r#"{"panoId":"x"}"#));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let events = events.lock().unwrap();
    let first = &events[0];
    assert_eq!((first.done, first.total, first.finished), (0, 2, false));
    assert!(events.last().unwrap().finished);
}

#[test]
fn force_false_skips_rows_that_already_hold_every_field() {
    let done = Location {
        extra: RawExtra::from_string(r#"{"country":"JP"}"#.into()),
        ..loc(1, 1.0, 0.0)
    };
    let (state, map_id) = setup(&[done, loc(2, 2.0, 0.0)]);
    let mut d = decl("skipper", BatchMode::PerRow);
    d.fields = vec!["country".into()];
    let h = Harness::map_only(patch_extra_all(r#"{"country":"US"}"#));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.force = false;
    run_provider(&ctx, &d).unwrap();

    assert_eq!(*h.seen.lock().unwrap(), vec![vec![2]]);
    assert_eq!(
        read_extra(&state, &map_id, 1).unwrap()["country"],
        serde_json::json!("JP")
    );
}

// -----------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------

#[test]
fn run_shape_reaches_the_host_fetch() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let d = decl("runner", BatchMode::PerRow);
    let (fetch, calls) = status_sequence(vec![200]);
    let hits = Arc::new(AtomicU32::new(0));
    let deps = EngineDeps {
        factory: {
            let hits = hits.clone();
            Box::new(move |_| Ok(Box::new(RunProc { hits: hits.clone() }) as Box<dyn Procedure>))
        },
        fetch,
        backoff: Duration::from_millis(1),
    };
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        run_id: 7,
        force: true,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
    };
    run_provider(&ctx, &d).unwrap();
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    assert_eq!(hits.load(Ordering::Relaxed), 1);
    assert_eq!(
        read_extra(&state, &map_id, 1).unwrap()["ok"],
        serde_json::json!(true)
    );
}

struct RunProc {
    hits: Arc<AtomicU32>,
}

impl Procedure for RunProc {
    fn shape(&self) -> ProcShape {
        ProcShape::Run
    }
    fn run(&mut self, batch: &[u8], host: &mut dyn ProcHost) -> AppResult<Vec<PatchEntry>> {
        let rows = batch_rows(batch)?;
        host.fetch(&HttpRequestSpec {
            method: "GET".into(),
            url: "https://example.invalid/".into(),
            headers: Vec::new(),
            body: None,
        })?;
        self.hits.fetch_add(1, Ordering::Relaxed);
        host.progress(rows.len() as u32);
        Ok(rows
            .iter()
            .map(|r| PatchEntry {
                id: r.id,
                patch: r#"{"extra":{"ok":true}}"#.into(),
            })
            .collect())
    }
}

// -----------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------

#[test]
fn progress_always_ends_with_a_final_event_at_total() {
    let locs: Vec<Location> = (1..=5u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("progresser", BatchMode::PerRow);
    let (sink, events) = recording_sink();
    let h = Harness::map_only(Arc::new(|_| Ok(Vec::new())));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert!(last.finished);
    assert_eq!((last.done, last.total, last.failed), (5, 5, 0));
}

#[test]
fn a_failing_batch_counts_as_failed_and_done() {
    let locs: Vec<Location> = (1..=2u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("failer", BatchMode::PerRow);
    let (sink, events) = recording_sink();
    let h = Harness::map_only(Arc::new(|_| Err(AppError("boom".into()))));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert_eq!((last.done, last.total, last.failed), (2, 2, 2));
    // Every row of a failed batch is handed back by id, entries empty.
    let pages = delivered(&h);
    assert_eq!(pages.len(), 1, "one page, whatever the batch count");
    let mut failed = pages[0].failed.clone();
    failed.sort();
    assert_eq!(failed, vec![1, 2]);
    assert!(pages[0].entries.is_empty());
}

#[test]
fn a_row_the_procedure_fails_is_delivered_by_id() {
    let locs: Vec<Location> = (1..=3u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("partial", BatchMode::Chunk { size: 10 });
    let h = Harness::with_fail(
        ProcShape::MapOnly,
        patch_extra_all(r#"{"a":1}"#),
        sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        Some(2),
    );
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].failed, vec![2]);
    assert!(pages[0].entries.is_empty());
    // The patch still landed: failing a row reports it, it does not veto the batch.
    assert_eq!(read_extra(&state, &map_id, 2).unwrap()["a"], 1);
}

#[test]
fn a_map_only_procedure_reaches_the_real_host() {
    let locs: Vec<Location> = (1..=2u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("maponly-failer", BatchMode::PerRow);
    let (sink, events) = recording_sink();
    let h = Harness::with_fail(
        ProcShape::MapOnly,
        Arc::new(|_| Ok(Vec::new())),
        sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        Some(1),
    );
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert_eq!((last.done, last.total, last.failed), (2, 2, 2));
}

// -----------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------

#[test]
fn configure_json_carries_fields_force_and_the_provider_config() {
    let mut d = decl("cfg", BatchMode::PerRow);
    d.fields = vec!["a".into(), "b".into()];
    d.config = Some(r#"{"units":"metric \"x\"","n":[1,2]}"#.into());
    let v: serde_json::Value =
        serde_json::from_str(&configure_json(&d.fields, true, d.config.as_deref())).unwrap();
    assert_eq!(v["fields"], serde_json::json!(["a", "b"]));
    assert_eq!(v["force"], serde_json::json!(true));
    assert_eq!(v["config"]["units"], serde_json::json!("metric \"x\""));
    assert_eq!(v["config"]["n"], serde_json::json!([1, 2]));
}

#[test]
fn configure_json_reads_absent_or_malformed_config_as_null() {
    let d = decl("cfg", BatchMode::PerRow);
    let v: serde_json::Value =
        serde_json::from_str(&configure_json(&d.fields, false, d.config.as_deref())).unwrap();
    assert_eq!(v["config"], serde_json::Value::Null);
    assert_eq!(v["force"], serde_json::json!(false));

    let mut bad = decl("cfg", BatchMode::PerRow);
    bad.config = Some("{not json".into());
    let v: serde_json::Value =
        serde_json::from_str(&configure_json(&bad.fields, false, bad.config.as_deref())).unwrap();
    assert_eq!(v["config"], serde_json::Value::Null);
}

struct CfgProc {
    seen: Arc<Mutex<Vec<String>>>,
}

impl Procedure for CfgProc {
    fn shape(&self) -> ProcShape {
        ProcShape::MapOnly
    }
    fn configure(&mut self, config_json: &str) -> AppResult<()> {
        self.seen.lock().unwrap().push(config_json.to_string());
        Ok(())
    }
    fn map(
        &mut self,
        _batch: &[u8],
        _response: &HttpResponse,
        _host: &mut dyn ProcHost,
    ) -> AppResult<Vec<PatchEntry>> {
        Ok(Vec::new())
    }
}

#[test]
fn every_procedure_the_engine_creates_is_configured() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let mut d = decl("cfg", BatchMode::PerRow);
    d.fields = vec!["timezone".into()];
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let deps = EngineDeps {
        factory: {
            let seen = seen.clone();
            Box::new(move |_| Ok(Box::new(CfgProc { seen: seen.clone() }) as Box<dyn Procedure>))
        },
        fetch: sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        backoff: Duration::from_millis(1),
    };
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        run_id: 5,
        force: true,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
    };
    run_provider(&ctx, &d).unwrap();

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0],
        r#"{"fields":["timezone"],"force":true,"config":null}"#
    );
}

// Instances are created before any batch is queued: a provider that cannot start one
// must fail the run rather than strand the producer on a queue nobody drains (or, on a
// small map, complete as a silent no-op).

#[test]
fn a_provider_with_no_startable_instance_fails_the_run() {
    // Enough rows that a stranded producer would block forever on the batch queue.
    let locs: Vec<Location> = (1..=100u32).map(|i| loc(i, i as f64 / 10.0, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let mut h = Harness::map_only(patch_all("{}"));
    h.deps.factory = Box::new(|_| Err(AppError("no interpreter".into())));
    let err = run_provider(&h.ctx(&state, &map_id), &decl("dead", BatchMode::PerRow)).unwrap_err();
    assert!(err.to_string().contains("no interpreter"), "{err}");
}

#[test]
fn a_provider_declaring_no_procedure_module_fails_the_run() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let h = Harness::map_only(patch_all("{}"));
    let mut d = decl("moduleless", BatchMode::PerRow);
    d.entry = None;
    let err = run_provider(&h.ctx(&state, &map_id), &d).unwrap_err();
    assert!(
        err.to_string().contains("declares no procedure module"),
        "{err}"
    );
}

struct BadCfgProc;

impl Procedure for BadCfgProc {
    fn shape(&self) -> ProcShape {
        ProcShape::MapOnly
    }
    fn configure(&mut self, _config_json: &str) -> AppResult<()> {
        Err(AppError("config rejected".into()))
    }
    fn map(
        &mut self,
        _batch: &[u8],
        _response: &HttpResponse,
        _host: &mut dyn ProcHost,
    ) -> AppResult<Vec<PatchEntry>> {
        Ok(Vec::new())
    }
}

#[test]
fn a_procedure_whose_configure_fails_fails_the_run() {
    let locs: Vec<Location> = (1..=100u32).map(|i| loc(i, i as f64 / 10.0, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let mut h = Harness::map_only(patch_all("{}"));
    h.deps.factory = Box::new(|_| Ok(Box::new(BadCfgProc) as Box<dyn Procedure>));
    let err = run_provider(&h.ctx(&state, &map_id), &decl("cfg", BatchMode::PerRow)).unwrap_err();
    assert!(err.to_string().contains("config rejected"), "{err}");
}

#[test]
fn a_partly_started_provider_runs_on_the_instances_that_did_start() {
    let locs: Vec<Location> = (1..=10u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let mut h = Harness::map_only(patch_all("{}"));
    let seen = h.seen.clone();
    let calls = Arc::new(AtomicU32::new(0));
    h.deps.factory = Box::new(move |_| {
        if calls.fetch_add(1, Ordering::Relaxed) == 0 {
            return Err(AppError("first instance dies".into()));
        }
        Ok(Box::new(MockProc {
            shape: ProcShape::MapOnly,
            seen: seen.clone(),
            on_map: patch_all("{}"),
            fail_id: None,
        }) as Box<dyn Procedure>)
    });
    let mut d = decl("half", BatchMode::PerRow);
    d.instances = Some(2);
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    let worked: usize = h.seen.lock().unwrap().iter().map(Vec::len).sum();
    assert_eq!(worked, 10);
}

/// The batch a real procedure sees, end to end through `run_provider`: the engine
/// serializes rows as JSON and the QuickJS host parses them. Pins the wire shape --
/// camelCase names, `flags` as a number, `extra` as an object, absent `panoId` and
/// `modifiedAt` as null.
#[test]
fn a_real_js_procedure_reads_the_batch_as_json_rows() {
    const SRC: &str = r#"
      export function map(rows) {
        return rows.map((r) => ({ id: r.id, patch: { extra: { row: JSON.stringify(r) } } }));
      }
    "#;
    let rows = vec![
        Location {
            pano_id: Some("pano-a".into()),
            tags: vec![4, 9],
            extra: RawExtra::from_string(r#"{"k":"v"}"#.into()),
            modified_at: Some(1234),
            flags: LocationFlags::INFORMATIONAL,
            ..loc(1, 1.5, 2.5)
        },
        loc(2, 3.5, 4.5),
    ];
    let (state, map_id) = setup(&rows);
    let deps = EngineDeps {
        factory: Box::new(|_| {
            let p = JsProcedure::load_source(SRC, "fixture.js")?;
            Ok(Box::new(p) as Box<dyn Procedure>)
        }),
        fetch: sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        backoff: Duration::from_millis(1),
    };
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        run_id: 1,
        force: true,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
    };
    run_provider(&ctx, &decl("p", BatchMode::Chunk { size: 10 })).unwrap();

    let seen = |id: u32| -> serde_json::Value {
        let extra = read_extra(&state, &map_id, id).unwrap();
        serde_json::from_str(extra["row"].as_str().unwrap()).unwrap()
    };
    let a = seen(1);
    assert_eq!(a["id"], serde_json::json!(1));
    assert_eq!(a["lat"], serde_json::json!(1.5));
    assert_eq!(a["lng"], serde_json::json!(2.5));
    assert_eq!(a["zoom"].as_f64(), Some(1.0));
    assert_eq!(a["panoId"], serde_json::json!("pano-a"));
    assert_eq!(a["flags"], serde_json::json!(2));
    assert_eq!(a["tags"], serde_json::json!([4, 9]));
    assert_eq!(a["extra"], serde_json::json!({"k": "v"}));
    assert_eq!(a["createdAt"], serde_json::json!(0));
    assert_eq!(a["modifiedAt"], serde_json::json!(1234));
    let b = seen(2);
    assert_eq!(b["panoId"], serde_json::Value::Null);
    assert_eq!(b["modifiedAt"], serde_json::Value::Null);
    assert_eq!(b["extra"], serde_json::Value::Null);
    assert_eq!(b["tags"], serde_json::json!([]));
}

#[test]
fn map_only_chunks_are_cut_to_keep_every_worker_busy() {
    let locs: Vec<Location> = (0..PAGE_SIZE as u32)
        .map(|i| loc(i + 1, 1.0, 2.0))
        .collect();
    let (state, map_id) = setup(&locs);
    let h = Harness::map_only(patch_extra_all(r#"{"a":1}"#));
    let mut d = decl(
        "p",
        BatchMode::Chunk {
            size: PAGE_SIZE as u32,
        },
    );
    d.instances = Some(4);
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    let sizes: Vec<usize> = h.seen.lock().unwrap().iter().map(Vec::len).collect();
    assert_eq!(sizes.len(), 4);
    assert!(sizes.iter().all(|&n| n == PAGE_SIZE / 4));
}

#[test]
fn request_map_chunks_keep_the_declared_size() {
    let locs: Vec<Location> = (0..PAGE_SIZE as u32)
        .map(|i| loc(i + 1, 1.0, 2.0))
        .collect();
    let (state, map_id) = setup(&locs);
    let h = Harness::new(
        ProcShape::RequestMap,
        patch_extra_all(r#"{"a":1}"#),
        sync_fetch(|_| {
            Ok(HttpResponse {
                status: 200,
                body: vec![],
            })
        }),
    );
    let mut d = decl(
        "p",
        BatchMode::Chunk {
            size: PAGE_SIZE as u32,
        },
    );
    d.instances = Some(4);
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    assert_eq!(h.seen.lock().unwrap().len(), 1);
}

/// Timing probe: `ENRICH_PROBE=1 N=100000 cargo test --lib procedure::engine -- --ignored engine_throughput_probe --nocapture`
#[test]
#[ignore]
fn engine_throughput_probe() {
    let n: u32 = env::var("N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000);
    let locs: Vec<Location> = (0..n)
        .map(|i| {
            let mut l = loc(
                i + 1,
                -60.0 + (i as f64 % 1200.0) * 0.1,
                -180.0 + (i as f64 % 3600.0) * 0.1,
            );
            l.extra = RawExtra::from_string(format!(
                r#"{{"datetime":{},"countryCode":"US"}}"#,
                1_700_000_000 + i * 60
            ));
            l
        })
        .collect();
    let mut d = decl("sun", BatchMode::Chunk { size: 1000 });
    d.fields = vec!["sunAzimuth".into(), "sunAltitude".into()];
    // Stands in for a real compute procedure: the number this arm reports is the
    // QuickJS host's per-call cost, not the module's arithmetic.
    const SRC: &str = r#"
      export function map(rows) {
        return rows.map((r) => ({
          id: r.id,
          patch: { extra: { sunAzimuth: (r.lat + r.lng) % 360, sunAltitude: r.lat - 45 } },
        }));
      }
    "#;
    let ws: Vec<u32> = env::var("INSTANCES")
        .map(|v| v.split(',').map(|x| x.parse().unwrap()).collect())
        .unwrap_or(vec![4, 8]);
    let chunk: u32 = env::var("CHUNK")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1000);
    for workers in ws {
        d.instances = if workers == 0 { None } else { Some(workers) };
        d.batch = BatchMode::Chunk { size: chunk };
        if env::var_os("SKIP_MOCK").is_none() {
            let (state, map_id) = setup(&locs);
            let h = Harness::map_only(patch_extra_all(
                r#"{"sunAzimuth":20.1,"sunAltitude":-54.8}"#,
            ));
            let t = Instant::now();
            run_provider(&h.ctx(&state, &map_id), &d).unwrap();
            let s = t.elapsed().as_secs_f64();
            eprintln!(
                "mock  workers={workers}: {s:.3}s = {:.0} rows/s",
                n as f64 / s
            );
        }

        let (state, map_id) = setup(&locs);
        let deps = EngineDeps {
            factory: Box::new(move |_| {
                let p = JsProcedure::load_source(SRC, "probe.js")?;
                Ok(Box::new(p) as Box<dyn Procedure>)
            }),
            fetch: sync_fetch(|_| Err(AppError("no fetch".into()))),
            backoff: Duration::from_millis(1),
        };
        let ctx = RunCtx {
            state: &state,
            map_id: map_id.clone(),
            run_id: 1,
            force: true,
            cancel: Arc::new(AtomicBool::new(false)),
            deps: &deps,
            progress: Arc::new(Box::new(|_| {})),
            results: Arc::new(Box::new(|_| {})),
        };
        let t = Instant::now();
        run_provider(&ctx, &d).unwrap();
        let s = t.elapsed().as_secs_f64();
        eprintln!(
            "js    workers={workers}: {s:.3}s = {:.0} rows/s",
            n as f64 / s
        );
        assert!(read_extra(&state, &map_id, 1)
            .unwrap()
            .get("sunAzimuth")
            .is_some());
    }
}

// -----------------------------------------------------------------------
// e2e Street View stub origin rewrite
// -----------------------------------------------------------------------

#[cfg(feature = "e2e")]
mod e2e_rewrite {
    use super::*;

    const GET_METADATA: &str = "https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata";

    #[test]
    fn keeps_path_and_query() {
        assert_eq!(
            rewrite_origin(GET_METADATA, "http://127.0.0.1:4599"),
            "http://127.0.0.1:4599/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata"
        );
        assert_eq!(
            rewrite_origin(
                "https://www.google.com/maps/photometa/ac/v1?pb=!1m1",
                "http://127.0.0.1:4599"
            ),
            "http://127.0.0.1:4599/maps/photometa/ac/v1?pb=!1m1"
        );
    }

    #[test]
    fn origin_without_path_becomes_root() {
        assert_eq!(
            rewrite_origin("https://example.com", "http://127.0.0.1:1"),
            "http://127.0.0.1:1/"
        );
    }

    #[test]
    fn trailing_slash_on_origin_does_not_double_up() {
        assert_eq!(
            rewrite_origin("https://example.com/a/b", "http://127.0.0.1:1/"),
            "http://127.0.0.1:1/a/b"
        );
    }
}

// -----------------------------------------------------------------------
// Query
// -----------------------------------------------------------------------

/// Answers a query by reporting what it was configured with, the input it saw, and the
/// body of one host fetch. Every shape method is unreachable: a query needs none.
struct QueryProc {
    config: String,
    entry: String,
}

impl Procedure for QueryProc {
    fn shape(&self) -> ProcShape {
        ProcShape::Run
    }
    fn configure(&mut self, config_json: &str) -> AppResult<()> {
        self.config = config_json.to_string();
        Ok(())
    }
    fn query(&mut self, input: &[u8], host: &mut dyn ProcHost) -> AppResult<Vec<u8>> {
        let fetched = host.fetch(&HttpRequestSpec {
            method: "GET".into(),
            url: "https://example.invalid/q".into(),
            headers: Vec::new(),
            body: None,
        })?;
        // Progress and failures are no-ops here; calling them proves they do not panic.
        host.progress(1);
        host.fail(1);
        assert!(!host.aborted());
        Ok(serde_json::json!({
            "entry": self.entry,
            "config": serde_json::from_str::<serde_json::Value>(&self.config).unwrap(),
            "input": String::from_utf8_lossy(input),
            "fetched": String::from_utf8_lossy(&fetched.body),
        })
        .to_string()
        .into_bytes())
    }
}

fn query_deps(fetch: FetchFn) -> EngineDeps {
    EngineDeps {
        factory: Box::new(|entry| {
            Ok(Box::new(QueryProc {
                config: "null".into(),
                entry: entry.to_string(),
            }) as Box<dyn Procedure>)
        }),
        fetch,
        backoff: Duration::from_millis(1),
    }
}

#[test]
fn run_query_returns_the_module_output_and_reaches_fetch() {
    let deps = query_deps(sync_fetch(|_| {
        Ok(HttpResponse {
            status: 200,
            body: b"pong".to_vec(),
        })
    }));
    let out = run_query(
        &deps,
        "res://procedures/svMeta.js",
        r#"{"op":"metadata","panoIds":["a"]}"#,
        Some(r#"{"units":"metric"}"#.into()),
        &|| false,
    )
    .expect("query succeeds");

    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["entry"], serde_json::json!("res://procedures/svMeta.js"));
    assert_eq!(
        v["input"],
        serde_json::json!(r#"{"op":"metadata","panoIds":["a"]}"#)
    );
    assert_eq!(v["fetched"], serde_json::json!("pong"));
    // A query wants every field and never forces: only the caller's config carries through.
    assert_eq!(v["config"]["fields"], serde_json::json!([]));
    assert_eq!(v["config"]["force"], serde_json::json!(false));
    assert_eq!(v["config"]["config"]["units"], serde_json::json!("metric"));
}

#[test]
fn run_query_retries_a_throttled_fetch() {
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    let deps = query_deps(sync_fetch(move |_| {
        let n = seen.fetch_add(1, Ordering::Relaxed);
        Ok(HttpResponse {
            status: if n == 0 { 429 } else { 200 },
            body: b"pong".to_vec(),
        })
    }));
    let out = run_query(&deps, "q.js", "{}", None, &|| false).expect("query succeeds");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["fetched"], serde_json::json!("pong"));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[test]
fn a_cancelled_query_has_its_requests_declined() {
    let calls = Arc::new(AtomicU32::new(0));
    let c = calls.clone();
    let deps = query_deps(sync_fetch(move |_| {
        c.fetch_add(1, Ordering::Relaxed);
        Ok(HttpResponse {
            status: 200,
            body: b"never".to_vec(),
        })
    }));
    let err = run_query(&deps, "q.js", "{}", None, &|| true).unwrap_err();
    assert!(err.0.contains("cancelled"), "{}", err.0);
    assert_eq!(
        calls.load(Ordering::Relaxed),
        0,
        "a declined request is never sent"
    );
}

#[test]
fn run_query_surfaces_a_module_without_the_export() {
    let deps = EngineDeps {
        factory: Box::new(|_| {
            Ok(Box::new(MockProc {
                shape: ProcShape::Run,
                seen: Arc::new(Mutex::new(Vec::new())),
                on_map: patch_all("{}"),
                fail_id: None,
            }) as Box<dyn Procedure>)
        }),
        fetch: sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        backoff: Duration::from_millis(1),
    };
    let err = run_query(&deps, "plain.js", "{}", None, &|| false).expect_err("rejected");
    assert!(err.0.contains("does not implement query"), "{}", err.0);
}

// -----------------------------------------------------------------------
// fetch_many
// -----------------------------------------------------------------------

fn get(url: &str) -> HttpRequestSpec {
    HttpRequestSpec {
        method: "GET".into(),
        url: url.into(),
        headers: Vec::new(),
        body: None,
    }
}

fn gets(n: usize) -> Vec<HttpRequestSpec> {
    (0..n)
        .map(|i| get(&format!("https://x.test/{i}")))
        .collect()
}

/// A fetch that holds each request until `target` are in flight (or `wait` passes),
/// recording the most it ever saw at once. The body echoes the url, so a caller can
/// check the answers came back in request order.
fn barrier_fetch(target: u32, wait: Duration, peak: Arc<AtomicU32>) -> FetchFn {
    let live = Arc::new(AtomicU32::new(0));
    Box::new(move |req: HttpRequestSpec| {
        let (live, peak) = (live.clone(), peak.clone());
        Box::pin(async move {
            let n = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            let deadline = Instant::now() + wait;
            while live.load(Ordering::SeqCst) < target && Instant::now() < deadline {
                time::sleep(Duration::from_millis(1)).await;
            }
            live.fetch_sub(1, Ordering::SeqCst);
            Ok(HttpResponse {
                status: 200,
                body: req.url.as_bytes().to_vec(),
            })
        })
    })
}

/// Runs `body` against an `EngineHost` built outside a run, so the host imports can be
/// exercised on their own.
fn with_engine_host<R>(
    fetch: FetchFn,
    decl: &ProviderDecl,
    rate: Option<RateSpec>,
    body: impl FnOnce(&mut EngineHost) -> R,
) -> R {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let h = Harness::new(ProcShape::Run, patch_all("{}"), fetch);
    let ctx = h.ctx(&state, &map_id);
    let prog = ProviderProgress::new(1, decl.id.clone(), 1, Arc::new(Box::new(|_| {})));
    let budget = FetchBudget::new(decl.inflight, rate);
    let mut host = EngineHost {
        ctx: &ctx,
        decl,
        budget: &budget,
        rate_cost: 1,
        prog: &prog,
        reported: 0,
        failed: Vec::new(),
    };
    body(&mut host)
}

fn bodies(res: Vec<AppResult<HttpResponse>>) -> Vec<String> {
    res.into_iter()
        .map(|r| String::from_utf8(r.expect("answered").body).unwrap())
        .collect()
}

#[test]
fn fetch_many_puts_every_request_in_flight_at_once() {
    let peak = Arc::new(AtomicU32::new(0));
    let d = decl("many", BatchMode::PerRow);
    let reqs = gets(8);
    let out = with_engine_host(
        barrier_fetch(8, Duration::from_secs(5), peak.clone()),
        &d,
        None,
        |h| h.fetch_many(&reqs),
    );
    assert_eq!(peak.load(Ordering::SeqCst), 8);
    // Answers come back in request order, not completion order.
    assert_eq!(
        bodies(out),
        (0..8)
            .map(|i| format!("https://x.test/{i}"))
            .collect::<Vec<_>>()
    );
}

#[test]
fn fetch_many_holds_the_declared_inflight_ceiling() {
    let peak = Arc::new(AtomicU32::new(0));
    let mut d = decl("many", BatchMode::PerRow);
    d.inflight = Some(8);
    let n = 20;
    let reqs = gets(n);
    // Nothing releases the barrier, so every request waits out the same short window:
    // whatever runs together is what the budget allows.
    let out = with_engine_host(
        barrier_fetch(u32::MAX, Duration::from_millis(150), peak.clone()),
        &d,
        None,
        |h| h.fetch_many(&reqs),
    );
    assert_eq!(out.len(), n);
    assert_eq!(peak.load(Ordering::SeqCst), 8);
}

#[test]
fn a_provider_declaring_no_inflight_takes_the_default_width() {
    let peak = Arc::new(AtomicU32::new(0));
    let d = decl("many", BatchMode::PerRow);
    assert!(d.inflight.is_none());
    let n = DEFAULT_INFLIGHT as usize + 12;
    let reqs = gets(n);
    let out = with_engine_host(
        barrier_fetch(u32::MAX, Duration::from_millis(150), peak.clone()),
        &d,
        None,
        |h| h.fetch_many(&reqs),
    );
    assert_eq!(out.len(), n);
    assert_eq!(peak.load(Ordering::SeqCst), DEFAULT_INFLIGHT);
}

/// The budget belongs to the provider, so more instances buy no more network: two hosts
/// sharing one budget hold its ceiling between them.
#[test]
fn instances_sharing_a_budget_do_not_widen_it() {
    let peak = Arc::new(AtomicU32::new(0));
    let fetch = barrier_fetch(u32::MAX, Duration::from_millis(150), peak.clone());
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let h = Harness::new(ProcShape::Run, patch_all("{}"), fetch);
    let ctx = h.ctx(&state, &map_id);
    let d = decl("many", BatchMode::PerRow);
    let prog = ProviderProgress::new(1, d.id.clone(), 1, Arc::new(Box::new(|_| {})));
    let budget = FetchBudget::new(Some(6), None);
    let reqs = gets(10);
    thread::scope(|s| {
        for _ in 0..2 {
            let (budget, prog, ctx, d, reqs) = (&budget, &prog, &ctx, &d, &reqs);
            s.spawn(move || {
                let mut host = EngineHost {
                    ctx,
                    decl: d,
                    budget,
                    rate_cost: 1,
                    prog,
                    reported: 0,
                    failed: Vec::new(),
                };
                assert_eq!(host.fetch_many(reqs).len(), 10);
            });
        }
    });
    assert_eq!(peak.load(Ordering::SeqCst), 6);
}

#[test]
fn fetch_many_retries_a_declared_status_per_request() {
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let fetch: FetchFn = sync_fetch(move |req: HttpRequestSpec| {
        let mut log = log.lock().unwrap();
        log.push(req.url.clone());
        // The first request is throttled once, then answers.
        let first_try =
            req.url.ends_with('0') && log.iter().filter(|u| **u == req.url).count() == 1;
        Ok(HttpResponse {
            status: if first_try { 429 } else { 200 },
            body: req.url.as_bytes().to_vec(),
        })
    });
    let mut d = decl("many", BatchMode::PerRow);
    d.retry = Some(RetrySpec {
        attempts: 3,
        on: vec![429],
    });
    let reqs = gets(2);
    let out = with_engine_host(fetch, &d, None, |h| h.fetch_many(&reqs));

    assert_eq!(
        bodies(out),
        vec![
            "https://x.test/0".to_string(),
            "https://x.test/1".to_string()
        ]
    );
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[test]
fn fetch_many_pays_the_rate_limiter_per_request() {
    let d = decl("many", BatchMode::PerRow);
    let reqs = gets(8);
    // Two tokens up front, then one every 2ms: eight requests cannot beat 12ms.
    let rate = RateSpec {
        units: 2,
        per_ms: 4,
        cost: RateCost::Request,
    };
    let start = Instant::now();
    let out = with_engine_host(
        sync_fetch(|_| {
            Ok(HttpResponse {
                status: 200,
                body: Vec::new(),
            })
        }),
        &d,
        Some(rate),
        |h| h.fetch_many(&reqs),
    );
    assert_eq!(out.len(), 8);
    assert!(
        start.elapsed() >= Duration::from_millis(10),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn fetch_many_declines_every_request_once_cancelled() {
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    let fetch: FetchFn = sync_fetch(move |_: HttpRequestSpec| {
        seen.fetch_add(1, Ordering::SeqCst);
        Ok(HttpResponse {
            status: 200,
            body: Vec::new(),
        })
    });
    let d = decl("many", BatchMode::PerRow);
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let h = Harness::new(ProcShape::Run, patch_all("{}"), fetch);
    h.cancel.store(true, Ordering::Relaxed);
    let ctx = h.ctx(&state, &map_id);
    let prog = ProviderProgress::new(1, "many".into(), 1, Arc::new(Box::new(|_| {})));
    let budget = FetchBudget::new(None, None);
    let mut host = EngineHost {
        ctx: &ctx,
        decl: &d,
        budget: &budget,
        rate_cost: 1,
        prog: &prog,
        reported: 0,
        failed: Vec::new(),
    };
    for n in [1, 4] {
        let out = host.fetch_many(&gets(n));
        assert_eq!(out.len(), n);
        assert!(out.iter().all(Result::is_err), "{n} requests");
    }
    // Including the single-request path, which takes the same slot and the same check.
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

// -----------------------------------------------------------------------
// Sinks
// -----------------------------------------------------------------------

/// A provider whose answers are delivered rather than written.
fn collect_decl(id: &str, batch: BatchMode) -> ProviderDecl {
    let mut d = decl(id, batch);
    d.sink = Sink::Collect;
    d
}

fn delivered(h: &Harness) -> Vec<ProcedureResult> {
    h.delivered.lock().unwrap().clone()
}

#[test]
fn a_collect_provider_delivers_its_answers_and_writes_nothing() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0), loc(2, 2.0, 0.0)]);
    let d = collect_decl("validate", BatchMode::PerRow);
    // Not a LocationPatch at all: a collected answer is the module's own contract.
    let h = Harness::map_only(Arc::new(|rows: &[Location]| {
        Ok(rows
            .iter()
            .map(|r| PatchEntry {
                id: r.id,
                patch: r.id.to_string(),
            })
            .collect())
    }));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].provider_id, "validate");
    assert_eq!(pages[0].run_id, 1);
    assert_eq!(
        pages[0]
            .entries
            .iter()
            .map(|e| (e.id, e.json.as_str()))
            .collect::<Vec<_>>(),
        vec![(1, "1"), (2, "2")]
    );
    // Nothing reached the store: the sink decides delivery, and this one never writes.
    assert!(read_extra(&state, &map_id, 1).is_none());
    assert!(read_extra(&state, &map_id, 2).is_none());
    assert_eq!(read_loc(&state, &map_id, 1).modified_at, None);
}

#[test]
fn a_patch_provider_writes_and_delivers_nothing() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0)]);
    let d = decl("fields", BatchMode::PerRow);
    let h = Harness::map_only(patch_extra_all(r#"{"a":1}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert_eq!(read_extra(&state, &map_id, 1).unwrap()["a"], 1);
    assert!(delivered(&h).is_empty());
}

#[test]
fn collected_pages_arrive_in_page_order() {
    let rows: Vec<Location> = (1..=(PAGE_SIZE as u32 + 3))
        .map(|i| loc(i, i as f64 * 0.0001, 0.0))
        .collect();
    let (state, map_id) = setup(&rows);
    let d = collect_decl(
        "paged",
        BatchMode::Chunk {
            size: PAGE_SIZE as u32,
        },
    );
    let h = Harness::map_only(patch_all("7"));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].entries.len(), PAGE_SIZE);
    assert_eq!(pages[1].entries.len(), 3);
    assert_eq!(pages[0].entries[0].id, 1);
    assert_eq!(pages[1].entries[0].id, PAGE_SIZE as u32 + 1);
}

#[test]
fn cancelling_stops_delivery() {
    // One instance, one batch per page. The first batch cancels the run as it works, so
    // the instance never starts the second page and only the first page is delivered.
    let rows: Vec<Location> = (1..=(PAGE_SIZE as u32 + 3))
        .map(|i| loc(i, i as f64 * 0.0001, 0.0))
        .collect();
    let (state, map_id) = setup(&rows);
    let mut d = collect_decl(
        "paged",
        BatchMode::Chunk {
            size: PAGE_SIZE as u32,
        },
    );
    d.instances = Some(1);
    let cancel = Arc::new(AtomicBool::new(false));
    let c = cancel.clone();
    let mut h = Harness::map_only(Arc::new(move |rows: &[Location]| {
        c.store(true, Ordering::Relaxed);
        Ok(rows
            .iter()
            .map(|r| PatchEntry {
                id: r.id,
                patch: "7".into(),
            })
            .collect())
    }));
    h.cancel = cancel;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].entries.len(), PAGE_SIZE);
}

#[test]
fn a_collect_provider_fans_a_deduped_answer_out_to_every_sharer() {
    let mut a = loc(1, 1.0, 0.0);
    a.pano_id = Some("SHARED".into());
    let mut b = loc(2, 2.0, 0.0);
    b.pano_id = Some("SHARED".into());
    let (state, map_id) = setup(&[a, b, loc(3, 3.0, 0.0)]);
    let d = collect_decl(
        "resolve",
        BatchMode::DedupeBy {
            key: "panoId".into(),
        },
    );
    let h = Harness::map_only(patch_all(r#"{"panoId":"P"}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(
        pages[0].entries.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    // The answer was delivered, not written: the rows keep the panos they had.
    assert_eq!(read_loc(&state, &map_id, 3).pano_id, None);
}

#[test]
fn a_collect_provider_never_validates_its_answers_as_patches() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0)]);
    let d = collect_decl("odd", BatchMode::PerRow);
    // An unknown key would fail the batch on the patch sink; here it is just an answer.
    let h = Harness::map_only(patch_all(r#"{"state":3,"why":"nope"}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(pages[0].entries[0].json, r#"{"state":3,"why":"nope"}"#);
}
