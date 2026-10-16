use super::*;
use crate::net::fetch::{RateSpec, RetrySpec, SendFn, DEFAULT_INFLIGHT, TRANSIENT_STATUSES};
use crate::procedure::quickjs::JsProcedure;
use crate::runs::run_reserve;
use crate::store::arrow;
use crate::store::engine::{render_cell_idx, Stage, Store, StoreManager, Tracked};
use crate::test_util::{loc, loc_ids, tag_ids};
use crate::types::{LocationFlags, RawExtra};
use mma_algebra::{Change, Id, Op, Patch, Patchable};
use std::{env, thread};
use tokio::time;

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

fn setup(locs: &[Location]) -> (StoreState, Id<MapMeta, String>) {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let map_id = Id::new(format!(
        "procedure-test-{}",
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let mut store = Store::new();
    store.meta = Tracked::new(MapMeta {
        id: map_id.clone(),
        ..Default::default()
    });
    store.batch = Some(arrow::locations_to_batch(&[]));
    for l in locs {
        store.put(&Change {
            added: vec![l.clone()],
            ..Change::default()
        });
        let ci = render_cell_idx(l.lat, l.lng);
        store.cell_add_render(ci, l.id);
    }
    let mut mgr = StoreManager::new();
    mgr.stores.insert(map_id.clone(), store);
    (Mutex::new(mgr), map_id)
}

fn given(state: &StoreState, map_id: &Id<MapMeta, String>, rows: Vec<Location>) -> Target {
    let target = Target::Pending {
        name: "given".into(),
    };
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map_id).unwrap();
    store.at(&target).edit(
        rows.into_iter().map(Op::Set).collect(),
        Default::default(),
        &mut None,
    );
    target
}

fn layer_rows(state: &StoreState, map_id: &Id<MapMeta, String>, target: &Target) -> Vec<Location> {
    state
        .lock()
        .unwrap()
        .store_for_map(map_id)
        .unwrap()
        .at(target)
        .rows(&Selector::Everything)
}

fn read_extra(
    state: &StoreState,
    map_id: &Id<MapMeta, String>,
    id: u32,
) -> Option<serde_json::Value> {
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map_id).unwrap();
    let rows = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Locations {
            locations: loc_ids([id]),
            name: None,
        });
    rows[0]
        .extra
        .as_ref()
        .map(|e| serde_json::from_str(e.as_str()).unwrap())
}

fn read_loc(state: &StoreState, map_id: &Id<MapMeta, String>, id: u32) -> Location {
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map_id).unwrap();
    store
        .at(&Target::Map { id: None })
        .rows(&Selector::Locations {
            locations: loc_ids([id]),
            name: None,
        })
        .remove(0)
}

fn decl(id: &str, batch: BatchMode) -> ProviderDecl {
    ProviderDecl {
        id: id.into(),
        label: None,
        procedure: procedure_decl("mock"),
        fields: Vec::new(),
        requires: Vec::new(),
        select: Selector::Everything,
        batch,
        sink: Sink::Patch,
        force: true,
        instances: Some(1),
    }
}

fn transport(send: SendFn) -> Arc<Transport> {
    Arc::new(Transport {
        send,
        backoff: Duration::from_millis(1),
    })
}

/// Wraps a synchronous answer in the async fetch seam. A test that observes how many
/// requests run together writes its own async closure instead.
fn sync_fetch(
    f: impl Fn(HttpRequestSpec) -> AppResult<HttpResponse> + Send + Sync + 'static,
) -> SendFn {
    Box::new(move |req| {
        let answer = f(req);
        Box::pin(async move { answer })
    })
}

/// The rows a batch carries, as the QuickJS host would read them.
fn batch_rows(batch: &[u8]) -> AppResult<Vec<Location>> {
    serde_json::from_slice(batch).map_err(|e| AppError(format!("batch JSON is invalid: {e}")))
}

type MapFn = Arc<dyn Fn(&[Location]) -> AppResult<Vec<ResultEntry>> + Send + Sync>;

struct MockProc {
    shape: ProcShape,
    /// Issues one request before answering, as a fetching procedure does.
    fetches: bool,
    seen: Arc<Mutex<Vec<Vec<u32>>>>,
    on_map: MapFn,
    /// Reported to the host from the batch, proving a `map` shape reaches the real host.
    fail_id: Option<u32>,
}

impl MockProc {
    fn handle(&mut self, batch: &[u8]) -> AppResult<Vec<ResultEntry>> {
        let rows = batch_rows(batch)?;
        self.seen
            .lock()
            .unwrap()
            .push(rows.iter().map(|r| r.id).map(Id::get).collect());
        (self.on_map)(&rows)
    }
}

impl Procedure for MockProc {
    fn shape(&self) -> ProcShape {
        self.shape
    }
    fn batch(
        &mut self,
        batch: &[u8],
        host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        if let Some(id) = self.fail_id {
            host.fail(Id::new(id));
        }
        if self.fetches {
            fetch_one(host, "https://example.invalid/")?;
        }
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
    fn new(shape: ProcShape, on_map: MapFn, fetch: SendFn) -> Self {
        Harness::build(shape, false, on_map, fetch, None)
    }

    /// A `run` procedure that makes one request per batch through the host.
    fn fetching(on_map: MapFn, fetch: SendFn) -> Self {
        Harness::build(ProcShape::Run, true, on_map, fetch, None)
    }

    fn with_fail(shape: ProcShape, on_map: MapFn, fetch: SendFn, fail_id: Option<u32>) -> Self {
        Harness::build(shape, false, on_map, fetch, fail_id)
    }

    fn build(
        shape: ProcShape,
        fetches: bool,
        on_map: MapFn,
        fetch: SendFn,
        fail_id: Option<u32>,
    ) -> Self {
        let seen: Arc<Mutex<Vec<Vec<u32>>>> = Arc::new(Mutex::new(Vec::new()));
        let seen_f = seen.clone();
        Harness {
            deps: EngineDeps {
                factory: Box::new(move |_| {
                    Ok(Box::new(MockProc {
                        shape,
                        fetches,
                        seen: seen_f.clone(),
                        on_map: on_map.clone(),
                        fail_id,
                    }) as Box<dyn Procedure>)
                }),
                transport: transport(fetch),
            },
            seen,
            cancel: Arc::new(AtomicBool::new(false)),
            delivered: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn map_only(on_map: MapFn) -> Self {
        Harness::new(
            ProcShape::Map,
            on_map,
            sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        )
    }

    fn ctx<'a>(&'a self, state: &'a StoreState, map_id: &Id<MapMeta, String>) -> RunCtx<'a> {
        RunCtx {
            state,
            map_id: map_id.clone(),
            target: Target::Map { id: None },
            run_id: 1,
            cancel: self.cancel.clone(),
            deps: &self.deps,
            progress: Arc::new(Box::new(|_| {})),
            results: {
                let sink = self.delivered.clone();
                Arc::new(Box::new(move |r| sink.lock().unwrap().push(r)))
            },
            undo_group: Arc::default(),
        }
    }
}

/// Every row gets the same `Patch<Location>` JSON.
fn patch_all(json: &'static str) -> MapFn {
    Arc::new(move |rows: &[Location]| {
        Ok(rows
            .iter()
            .map(|r| ResultEntry {
                id: r.id,
                json: json.to_string(),
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
            .map(|r| ResultEntry {
                id: r.id,
                json: patch.clone(),
            })
            .collect())
    })
}

// -----------------------------------------------------------------------
// Dependency scheduling
// -----------------------------------------------------------------------

#[test]
fn a_consumer_is_gated_on_its_producer_alone() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.requires = vec!["x".into()];
    // Declared consumer-first to prove the gate comes from the graph, not the input order.
    assert_eq!(producers(&[b, a]), vec![vec![1], vec![]]);
}

#[test]
fn a_pano_resolver_gates_its_consumers_and_nothing_else() {
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

    // exactDate waits on svMeta only: pin can grind without holding it up.
    assert_eq!(
        producers(&[pin, exact, meta, resolve]),
        vec![vec![3], vec![2], vec![3], vec![]]
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
    d.force = false;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

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
    d.force = false;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert_eq!(*h.seen.lock().unwrap(), vec![vec![1]]);
}

#[test]
fn independent_providers_gate_nothing() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    assert_eq!(producers(&[a, b]), vec![Vec::<usize>::new(), Vec::new()]);
}

#[test]
fn a_slow_provider_holds_up_only_its_own_dependents() {
    // c blocks until b has run. Under a wave barrier b could never start (c shares a's
    // wave and gates b's), so completing at all proves per-provider gating.
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    a.select = Selector::Locations {
        locations: loc_ids([1]),
        name: None,
    };
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    b.requires = vec!["x".into()];
    b.select = a.select.clone();
    let mut c = decl("c", BatchMode::PerRow);
    c.fields = vec!["z".into()];
    c.select = Selector::Locations {
        locations: loc_ids([2]),
        name: None,
    };
    let (b_ran_tx, b_ran) = mpsc::channel::<()>();
    let b_ran = Mutex::new(b_ran);
    let h = Harness::map_only(Arc::new(move |rows: &[Location]| {
        Ok(rows
            .iter()
            .map(|r| ResultEntry {
                id: r.id,
                json: if r.id == Id::new(2) {
                    b_ran
                        .lock()
                        .unwrap()
                        .recv()
                        .expect("b never ran; the scheduler barriered");
                    r#"{"extra":{"z":3}}"#.into()
                } else if r
                    .extra
                    .as_ref()
                    .is_some_and(|e| e.as_str().contains("\"x\""))
                {
                    b_ran_tx.send(()).unwrap();
                    r#"{"extra":{"y":2}}"#.into()
                } else {
                    r#"{"extra":{"x":1}}"#.into()
                },
            })
            .collect())
    }));
    let (state, map_id) = setup(&[]);
    let target = given(&state, &map_id, vec![loc(1, 1.0, 0.0), loc(2, 2.0, 0.0)]);
    let progress: Arc<ProgressSink> = Arc::new(Box::new(|_| {}));
    let results: Arc<ResultSink> = Arc::new(Box::new(|_| {}));
    run_all(
        &RunCtx {
            target: target.clone(),
            run_id: 97,
            progress,
            results,
            ..h.ctx(&state, &map_id)
        },
        &[c, b, a].map(|d| ProviderDecl { force: false, ..d }),
    );

    let out = layer_rows(&state, &map_id, &target);
    let extra = |id: usize| {
        serde_json::from_str::<serde_json::Value>(out[id - 1].extra.as_ref().unwrap().as_str())
            .unwrap()
    };
    assert_eq!(extra(1), serde_json::json!({"x": 1, "y": 2}));
    assert_eq!(extra(2), serde_json::json!({"z": 3}));
}

#[test]
fn cancellation_finishes_providers_still_held_by_dependency_gates() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    b.requires = vec!["x".into()];
    let h = Harness::map_only(patch_all(r#"{"extra":{"ran":true}}"#));
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0)]);
    let target = Target::Map { id: None };
    let events: Arc<Mutex<Vec<ProcedureProgress>>> = Arc::default();
    let events_sink = events.clone();
    let cancel = h.cancel.clone();
    let progress: Arc<ProgressSink> = Arc::new(Box::new(move |p| {
        if p.provider_id == "a" && !p.finished {
            cancel.store(true, Ordering::Relaxed);
        }
        events_sink.lock().unwrap().push(p);
    }));
    let results: Arc<ResultSink> = Arc::new(Box::new(|_| {}));

    run_all(
        &RunCtx {
            target: target.clone(),
            run_id: 95,
            progress,
            results,
            ..h.ctx(&state, &map_id)
        },
        &[a, b].map(|d| ProviderDecl { force: false, ..d }),
    );

    let events = events.lock().unwrap();
    let finished: Vec<_> = events
        .iter()
        .filter(|event| event.finished)
        .map(|event| event.provider_id.as_str())
        .collect();
    assert_eq!(finished, vec!["a", "b"]);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.provider_id == "b")
            .count(),
        1,
        "the dependent never started, so it should only receive the terminal fallback"
    );
    assert!(events
        .iter()
        .any(|event| event.provider_id == "b" && event.finished && event.total == 0));
}

#[test]
fn a_dependency_cycle_still_runs_as_one_block() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    a.requires = vec!["y".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    b.requires = vec!["x".into()];
    let h = Harness::map_only(patch_all(r#"{"extra":{"ran":true}}"#));
    let (state, map_id) = setup(&[]);
    let target = given(&state, &map_id, vec![loc(1, 1.0, 0.0)]);
    let finished: Arc<Mutex<Vec<String>>> = Arc::default();
    let progress: Arc<ProgressSink> = {
        let finished = finished.clone();
        Arc::new(Box::new(move |p| {
            if p.finished {
                finished.lock().unwrap().push(p.provider_id);
            }
        }))
    };
    let results: Arc<ResultSink> = Arc::new(Box::new(|_| {}));
    // Returning at all is the point: mutual gates must release, not deadlock.
    run_all(
        &RunCtx {
            target: target.clone(),
            run_id: 96,
            progress,
            results,
            ..h.ctx(&state, &map_id)
        },
        &[a, b].map(|d| ProviderDecl { force: false, ..d }),
    );
    let mut ids = finished.lock().unwrap().clone();
    ids.sort();
    assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn gating_ignores_a_providers_own_output() {
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    a.requires = vec!["x".into()];
    assert_eq!(producers(&[a]), vec![Vec::<usize>::new()]);
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
fn a_deduped_batch_holds_each_sharers_own_row_for_the_stale_output_guard() {
    let row = |id: u32, pano: &str, lat: f64| Location {
        pano_id: Some(pano.into()),
        ..loc(id, lat, 0.0)
    };
    let rows = vec![row(1, "A", 1.0), row(2, "A", 2.0), row(3, "B", 3.0)];
    let batches = split_batches(
        &BatchMode::DedupeBy {
            key: "panoId".into(),
        },
        rows.clone(),
        10,
    )
    .unwrap();

    assert_eq!(batches.len(), 1);
    let batch = &batches[0];
    assert_eq!(
        batch.rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        [Id::new(1), Id::new(3)]
    );
    let sharers: Vec<(Id<Location>, f64)> = batch.sharers.iter().map(|r| (r.id, r.lat)).collect();
    assert_eq!(sharers, [(Id::new(2), 2.0)]);
}

#[test]
fn dedupe_by_spreads_representatives_over_every_instance() {
    let mut locs: Vec<Location> = (1..=5_001u32)
        .map(|i| Location {
            pano_id: Some(format!("PANO_{i}").into()),
            ..loc(i, i as f64 * 0.0001, 0.0)
        })
        .collect();
    locs.push(Location {
        pano_id: Some("PANO_5001".into()),
        ..loc(5_002, 0.0, 0.0)
    });
    let (state, map_id) = setup(&locs);
    let mut d = decl(
        "spread",
        BatchMode::DedupeBy {
            key: "panoId".into(),
        },
    );
    d.instances = Some(4);
    let h = Harness::map_only(patch_extra_all(r#"{"country":"JP"}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let mut sizes: Vec<usize> = h.seen.lock().unwrap().iter().map(Vec::len).collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![1, 2_500, 2_500]);
    for id in [1, 5_001, 5_002] {
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
        1,
    )
    .err()
    .expect("unsupported key must be rejected");
    assert!(err.0.contains("unsupported"), "{}", err.0);
}

// -----------------------------------------------------------------------
// Retry
// -----------------------------------------------------------------------

fn status_sequence(statuses: Vec<u16>) -> (SendFn, Arc<AtomicU32>) {
    let calls = Arc::new(AtomicU32::new(0));
    let c = calls.clone();
    let fetch: SendFn = sync_fetch(move |_| {
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
    d.procedure.policy.retry = Some(retry);
    let (fetch, calls) = status_sequence(statuses);
    let h = Harness::fetching(Arc::new(|_| Ok(Vec::new())), fetch);
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
fn declared_attempts_clamp_to_the_engine_ceiling() {
    let calls = run_retry(
        RetrySpec {
            attempts: 1000,
            on: vec![500],
        },
        vec![500],
    );
    assert_eq!(calls, 8);
}

fn run_without_retry_spec(statuses: Vec<u16>) -> u32 {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let d = decl("defaulted", BatchMode::PerRow);
    let (fetch, calls) = status_sequence(statuses);
    let h = Harness::fetching(Arc::new(|_| Ok(Vec::new())), fetch);
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();
    calls.load(Ordering::Relaxed)
}

#[test]
fn no_retry_spec_retries_every_transient_status() {
    for status in TRANSIENT_STATUSES {
        assert_eq!(
            run_without_retry_spec(vec![status, 200]),
            2,
            "status {status} should have been retried by default"
        );
    }
}

#[test]
fn no_retry_spec_leaves_a_settled_status_alone() {
    assert_eq!(run_without_retry_spec(vec![400, 200]), 1);
    assert_eq!(run_without_retry_spec(vec![403, 200]), 1);
    assert_eq!(run_without_retry_spec(vec![404, 200]), 1);
}

// -----------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------

/// Runs `rows` locations as chunks of `chunk` through a fetching provider at the
/// given rate spec and returns how long the whole provider took.
fn timed_chunk_run(rows: u32, chunk: u32, rate: RateSpec) -> u128 {
    let locs: Vec<Location> = (1..=rows).map(|i| loc(i, i as f64 * 0.001, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let mut d = decl("rated", BatchMode::Chunk { size: chunk });
    d.procedure.policy.rate = Some(rate);
    let (fetch, _) = status_sequence(vec![200]);
    let h = Harness::fetching(Arc::new(|_| Ok(Vec::new())), fetch);
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
            .map(|r| ResultEntry {
                id: r.id,
                json: r#"{"extra":{"hit":true}}"#.into(),
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

#[test]
fn cancel_with_more_batches_queued_than_the_queue_holds_still_lands_and_returns() {
    // One instance holds a queue of two; a page of twelve per-row batches overfills it.
    let locs: Vec<Location> = (1..=12u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("canceller", BatchMode::PerRow);
    let flag = Arc::new(AtomicBool::new(false));
    let f = flag.clone();
    let on_map: MapFn = Arc::new(move |rows: &[Location]| {
        f.store(true, Ordering::Relaxed);
        Ok(rows
            .iter()
            .map(|r| ResultEntry {
                id: r.id,
                json: r#"{"extra":{"hit":true}}"#.into(),
            })
            .collect())
    });
    let mut h = Harness::map_only(on_map);
    h.cancel = flag;
    // Leaked so the worker can be abandoned: a deadlocked provider must fail this test,
    // not hang it.
    let (h, state, map_id, d) = (
        &*Box::leak(Box::new(h)),
        &*Box::leak(Box::new(state)),
        &*Box::leak(Box::new(map_id)),
        &*Box::leak(Box::new(d)),
    );
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(run_provider(&h.ctx(state, map_id), d));
    });
    rx.recv_timeout(Duration::from_secs(10))
        .expect("a cancelled provider must return, not block on its own queue")
        .unwrap();

    assert_eq!(h.seen.lock().unwrap().len(), 1, "only one batch should run");
    assert_eq!(
        read_extra(state, map_id, 1).unwrap()["hit"],
        serde_json::json!(true)
    );
    assert!(read_extra(state, map_id, 2).is_none());
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
fn a_patch_that_sets_nothing_changes_nothing() {
    let mut row = loc(1, 1.0, 2.0);
    row.extra = RawExtra::from_map(&serde_json::json!({ "a": 1 }).as_object().unwrap().clone());
    for json in [r#"{}"#, r#"{"extra":{}}"#] {
        let patches = to_patches(&[ResultEntry {
            id: Id::new(1),
            json: json.into(),
        }])
        .unwrap();
        assert_eq!(row.patched(&patches[0]), row, "{json} changed the row");
    }
}

/// Every declared patch key must deserialize into its field.
/// Destructuring without `..` makes newly added fields require coverage here.
#[test]
fn patch_keys_cover_every_location_patch_field() {
    let mut obj = serde_json::Map::new();
    for (key, _) in <Location as Patchable>::WRITES {
        let sample = match *key {
            "lat" | "lng" | "heading" | "pitch" | "zoom" => serde_json::json!(1.5),
            "panoId" => serde_json::json!("PANO_X"),
            "flags" | "createdAt" | "modifiedAt" => serde_json::json!(3),
            "tags" => serde_json::json!([1, 2]),
            "extra" => serde_json::json!({ "a": 1 }),
            other => panic!("no sample value for patch key `{other}`"),
        };
        obj.insert((*key).to_string(), sample);
    }
    obj.insert("id".into(), serde_json::json!(3));
    let json = serde_json::Value::Object(obj).to_string();
    let p: Patch<Location> = serde_json::from_str(&json).unwrap();
    let Patch::<Location> {
        id: _,
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
        ("panoId", !pano_id.is_keep()),
        ("flags", flags.is_some()),
        ("tags", tags.is_some()),
        ("extra", !extra.is_keep()),
        ("createdAt", created_at.is_some()),
        ("modifiedAt", !modified_at.is_keep()),
    ] {
        assert!(set, "`{name}` was not set by its wire key");
    }
}

#[test]
fn an_unknown_key_names_itself_in_the_error() {
    let Err(err) = to_patches(&[ResultEntry {
        id: Id::new(1),
        json: r#"{"lat":1,"nope":2}"#.into(),
    }]) else {
        panic!("an unknown key must fail the batch");
    };
    assert!(err.0.contains("nope"), "{}", err.0);
}

#[test]
fn a_patch_that_is_not_an_object_is_an_error() {
    for json in [r#"[{"lat":1}]"#, r#""lat""#, "7"] {
        assert!(
            to_patches(&[ResultEntry {
                id: Id::new(1),
                json: json.into()
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
    d.force = false;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert_eq!(*h.seen.lock().unwrap(), vec![vec![2]]);
    assert_eq!(
        read_extra(&state, &map_id, 1).unwrap()["country"],
        serde_json::json!("JP")
    );
}

fn computed_from(state: &StoreState, map_id: &Id<MapMeta, String>, input: &str, outputs: &[&str]) {
    let outputs = outputs.iter().map(ToString::to_string).collect();
    let edges = HashMap::from([(input.to_string(), outputs)]);
    state
        .lock()
        .unwrap()
        .store_for_map(map_id)
        .unwrap()
        .dependents = Arc::new(mma_algebra::Dependents::new(edges));
}

#[test]
fn a_changed_value_nulls_the_fields_derived_from_it_and_a_same_value_keeps_them() {
    let row = |id: u32, month: &str| Location {
        extra: RawExtra::from_string(format!(
            r#"{{"imageDate":"{month}","datetime":123,"timezone":"Europe/Oslo","custom":"kept"}}"#
        )),
        ..loc(id, 1.0, 0.0)
    };
    let (state, map_id) = setup(&[row(1, "2020-01"), row(2, "2021-05")]);
    let mut d = decl("meta", BatchMode::PerRow);
    d.fields = vec!["imageDate".into()];
    computed_from(
        &state,
        &map_id,
        "imageDate",
        &["datetime", "timezone", "sunAzimuth"],
    );
    let h = Harness::map_only(patch_extra_all(r#"{"imageDate":"2021-05"}"#));
    d.force = true;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let moved = read_extra(&state, &map_id, 1).unwrap();
    assert_eq!(moved["imageDate"], serde_json::json!("2021-05"));
    assert!(moved.get("datetime").is_none(), "{moved}");
    assert!(moved.get("timezone").is_none(), "{moved}");
    assert!(
        moved.get("sunAzimuth").is_none(),
        "a dependent the row never held stays absent"
    );
    assert_eq!(moved["custom"], serde_json::json!("kept"));

    let same = read_extra(&state, &map_id, 2).unwrap();
    assert_eq!(same["datetime"], serde_json::json!(123));
    assert_eq!(same["timezone"], serde_json::json!("Europe/Oslo"));
}

#[test]
fn a_patch_that_writes_a_dependent_itself_keeps_that_value() {
    let one = Location {
        extra: RawExtra::from_string(r#"{"imageDate":"2020-01","datetime":123}"#.into()),
        ..loc(1, 1.0, 0.0)
    };
    let (state, map_id) = setup(&[one]);
    let mut d = decl("meta", BatchMode::PerRow);
    d.fields = vec!["imageDate".into(), "datetime".into()];
    computed_from(&state, &map_id, "imageDate", &["datetime"]);
    let h = Harness::map_only(patch_extra_all(r#"{"imageDate":"2021-05","datetime":456}"#));
    d.force = true;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let extra = read_extra(&state, &map_id, 1).unwrap();
    assert_eq!(extra["datetime"], serde_json::json!(456));
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
        transport: transport(fetch),
    };
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        target: Target::Map { id: None },
        run_id: 7,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
        undo_group: Arc::default(),
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
    fn batch(
        &mut self,
        batch: &[u8],
        host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        let rows = batch_rows(batch)?;
        fetch_one(host, "https://example.invalid/")?;
        self.hits.fetch_add(1, Ordering::Relaxed);
        host.progress(rows.len() as u32);
        Ok(rows
            .iter()
            .map(|r| ResultEntry {
                id: r.id,
                json: r#"{"extra":{"ok":true}}"#.into(),
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
    assert_eq!(failed, loc_ids([1, 2]));
    assert!(pages[0].entries.is_empty());
}

#[test]
fn a_deduped_failure_is_every_sharers_failure() {
    let mut a = loc(1, 1.0, 0.0);
    a.pano_id = Some("SHARED".into());
    let mut b = loc(2, 2.0, 0.0);
    b.pano_id = Some("SHARED".into());
    let mut c = loc(3, 3.0, 0.0);
    c.pano_id = Some("OTHER".into());
    let (state, map_id) = setup(&[a, b, c]);
    let d = decl(
        "meta",
        BatchMode::DedupeBy {
            key: "panoId".into(),
        },
    );
    // The procedure fails the representative of the shared pano, whichever row that is.
    let h = Harness::with_fail(
        ProcShape::Map,
        Arc::new(|_rows: &[Location]| Ok(Vec::new())),
        sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        Some(1),
    );
    let (sink, events) = recording_sink();
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let mut failed: Vec<u32> = delivered(&h)
        .iter()
        .flat_map(|p| p.failed.clone())
        .map(Id::get)
        .collect();
    failed.sort_unstable();
    assert_eq!(
        failed,
        vec![1, 2],
        "both sharers of the dead pano are failed"
    );
    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert_eq!((last.done, last.failed), (3, 2));
}

#[test]
fn a_row_the_procedure_fails_is_delivered_by_id() {
    let locs: Vec<Location> = (1..=3u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("partial", BatchMode::Chunk { size: 10 });
    let h = Harness::with_fail(
        ProcShape::Map,
        patch_extra_all(r#"{"a":1}"#),
        sync_fetch(|_| Err(AppError("no fetch expected".into()))),
        Some(2),
    );
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    let pages = delivered(&h);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].failed, loc_ids([2]));
    assert!(pages[0].entries.is_empty());
    // The patch still landed: failing a row reports it, it does not veto the batch.
    assert_eq!(read_extra(&state, &map_id, 2).unwrap()["a"], 1);
}

#[test]
fn a_row_missing_a_required_field_is_failed_before_the_procedure_sees_it() {
    let mut pinned = loc(1, 1.0, 0.0);
    pinned.pano_id = Some("ABC".into());
    let (state, map_id) = setup(&[pinned, loc(2, 2.0, 0.0)]);
    let mut d = decl("svMeta", BatchMode::PerRow);
    d.requires = vec!["panoId".into()];
    let h = Harness::map_only(patch_extra_all(r#"{"a":1}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    // Row 2 never reaches the procedure, and comes back as a failure rather than a pass.
    assert_eq!(*h.seen.lock().unwrap(), vec![vec![1]]);
    let failed: Vec<u32> = delivered(&h)
        .iter()
        .flat_map(|p| p.failed.clone())
        .map(Id::get)
        .collect();
    assert_eq!(failed, vec![2]);
}

#[test]
fn an_unmet_requirement_counts_as_failed_not_skipped() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0), loc(2, 2.0, 0.0)]);
    let mut d = decl("svMeta", BatchMode::PerRow);
    d.requires = vec!["panoId".into()];
    let (sink, events) = recording_sink();
    let h = Harness::map_only(patch_extra_all(r#"{"a":1}"#));
    let mut ctx = h.ctx(&state, &map_id);
    ctx.progress = sink;
    run_provider(&ctx, &d).unwrap();

    let events = events.lock().unwrap();
    let last = events.last().unwrap();
    assert_eq!((last.total, last.done, last.failed), (2, 2, 2));
}

#[test]
fn force_does_not_conjure_a_missing_requirement() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0)]);
    let mut d = decl("svMeta", BatchMode::PerRow);
    d.requires = vec!["panoId".into()];
    let h = Harness::map_only(patch_extra_all(r#"{"a":1}"#));
    d.force = true;
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert!(h.seen.lock().unwrap().is_empty());
    let failed: Vec<u32> = delivered(&h)
        .iter()
        .flat_map(|p| p.failed.clone())
        .map(Id::get)
        .collect();
    assert_eq!(failed, vec![1]);
}

#[test]
fn a_provider_requiring_nothing_works_every_row() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0), loc(2, 2.0, 0.0)]);
    let d = decl("subdivision", BatchMode::PerRow);
    let h = Harness::map_only(patch_extra_all(r#"{"a":1}"#));
    run_provider(&h.ctx(&state, &map_id), &d).unwrap();

    assert_eq!(*h.seen.lock().unwrap(), vec![vec![1], vec![2]]);
    assert!(delivered(&h).iter().all(|p| p.failed.is_empty()));
}

#[test]
fn a_map_only_procedure_reaches_the_real_host() {
    let locs: Vec<Location> = (1..=2u32).map(|i| loc(i, i as f64, 0.0)).collect();
    let (state, map_id) = setup(&locs);
    let d = decl("maponly-failer", BatchMode::PerRow);
    let (sink, events) = recording_sink();
    let h = Harness::with_fail(
        ProcShape::Map,
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
fn config_json_carries_fields_force_and_the_provider_config() {
    let mut d = decl("cfg", BatchMode::PerRow);
    d.fields = vec!["a".into(), "b".into()];
    d.procedure.config = Some(r#"{"units":"metric \"x\"","n":[1,2]}"#.into());
    let v: serde_json::Value =
        serde_json::from_str(&config_json(&d.fields, true, d.procedure.config.as_deref())).unwrap();
    assert_eq!(v["fields"], serde_json::json!(["a", "b"]));
    assert_eq!(v["force"], serde_json::json!(true));
    assert_eq!(v["config"]["units"], serde_json::json!("metric \"x\""));
    assert_eq!(v["config"]["n"], serde_json::json!([1, 2]));
}

#[test]
fn config_json_reads_absent_or_malformed_config_as_null() {
    let d = decl("cfg", BatchMode::PerRow);
    let v: serde_json::Value = serde_json::from_str(&config_json(
        &d.fields,
        false,
        d.procedure.config.as_deref(),
    ))
    .unwrap();
    assert_eq!(v["config"], serde_json::Value::Null);
    assert_eq!(v["force"], serde_json::json!(false));

    let mut bad = decl("cfg", BatchMode::PerRow);
    bad.procedure.config = Some("{not json".into());
    let v: serde_json::Value = serde_json::from_str(&config_json(
        &bad.fields,
        false,
        bad.procedure.config.as_deref(),
    ))
    .unwrap();
    assert_eq!(v["config"], serde_json::Value::Null);
}

struct CfgProc {
    seen: Arc<Mutex<Vec<String>>>,
}

impl Procedure for CfgProc {
    fn shape(&self) -> ProcShape {
        ProcShape::Map
    }
    fn batch(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        self.seen.lock().unwrap().push(config.to_string());
        Ok(Vec::new())
    }
}

#[test]
fn every_procedure_call_receives_its_config() {
    let (state, map_id) = setup(&[loc(1, 0.0, 0.0)]);
    let mut d = decl("cfg", BatchMode::PerRow);
    d.fields = vec!["timezone".into()];
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let deps = EngineDeps {
        factory: {
            let seen = seen.clone();
            Box::new(move |_| Ok(Box::new(CfgProc { seen: seen.clone() }) as Box<dyn Procedure>))
        },
        transport: transport(sync_fetch(|_| Err(AppError("no fetch expected".into())))),
    };
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        target: Target::Map { id: None },
        run_id: 5,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
        undo_group: Arc::default(),
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
            shape: ProcShape::Map,
            fetches: false,
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
        return rows.map((r) => ({ id: r.id, extra: { row: JSON.stringify(r) } }));
      }
    "#;
    let rows = vec![
        Location {
            pano_id: Some("pano-a".into()),
            tags: tag_ids([4, 9]),
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
        transport: transport(sync_fetch(|_| Err(AppError("no fetch expected".into())))),
    };
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        target: Target::Map { id: None },
        run_id: 1,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
        undo_group: Arc::default(),
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

/// `mma.neighbors` over a run's rows. Both cases share one procedure: it reports the ids
/// it can see within 200 m, minus itself.
const NEIGHBOR_SRC: &str = r#"
  export function map(rows) {
    return rows.map((r) => ({
      id: r.id,
      extra: { near: mma.neighbors(r.lat, r.lng, 200, ["heading"])
        .filter((n) => n.id !== r.id)
        .map((n) => [n.id, n.heading]) },
    }));
  }
"#;

fn neighbor_deps() -> EngineDeps {
    EngineDeps {
        factory: Box::new(|_| {
            Ok(
                Box::new(JsProcedure::load_source(NEIGHBOR_SRC, "fixture.js")?)
                    as Box<dyn Procedure>,
            )
        }),
        transport: transport(sync_fetch(|_| Err(AppError("no fetch expected".into())))),
    }
}

fn spaced(id: u32, north_m: f64, heading: f64) -> Location {
    Location {
        heading,
        ..loc(id, north_m / 111_320.0, 0.0)
    }
}

#[test]
fn neighbors_answers_a_procedure_from_the_maps_rows() {
    let (state, map_id) = setup(&[
        spaced(1, 0.0, 10.5),
        spaced(2, 50.0, 20.5),
        spaced(3, 400.0, 30.5),
    ]);
    let deps = neighbor_deps();
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        target: Target::Map { id: None },
        run_id: 1,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
        undo_group: Arc::default(),
    };
    run_provider(&ctx, &decl("p", BatchMode::Chunk { size: 10 })).unwrap();

    let near = |id: u32| read_extra(&state, &map_id, id).unwrap()["near"].clone();
    // 1 and 2 are 50 m apart and see each other, with the heading they asked for.
    assert_eq!(near(1), serde_json::json!([[2, 20.5]]));
    assert_eq!(near(2), serde_json::json!([[1, 10.5]]));
    // 3 is 350 m from the nearest and sees nobody.
    assert_eq!(near(3), serde_json::json!([]));
}

#[test]
fn neighbors_over_handed_in_rows_sees_only_those_rows() {
    let (state, map_id) = setup(&[spaced(1, 0.0, 10.5), spaced(2, 50.0, 20.5)]);
    let deps = neighbor_deps();
    let target = given(&state, &map_id, vec![spaced(2, 50.0, 20.5)]);
    let ctx = RunCtx {
        state: &state,
        map_id: map_id.clone(),
        target,
        run_id: 1,
        cancel: Arc::new(AtomicBool::new(false)),
        deps: &deps,
        progress: Arc::new(Box::new(|_| {})),
        results: Arc::new(Box::new(|_| {})),
        undo_group: Arc::default(),
    };
    run_provider(&ctx, &decl("p", BatchMode::Chunk { size: 10 })).unwrap();

    // A draft run indexes its own rows, so the map's location 1 is not a neighbour and
    // nothing the draft computed reached the map.
    assert!(read_extra(&state, &map_id, 2).is_none());
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
fn fetching_chunks_keep_the_declared_size() {
    let locs: Vec<Location> = (0..PAGE_SIZE as u32)
        .map(|i| loc(i + 1, 1.0, 2.0))
        .collect();
    let (state, map_id) = setup(&locs);
    let h = Harness::fetching(
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
          extra: { sunAzimuth: (r.lat + r.lng) % 360, sunAltitude: r.lat - 45 },
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
            transport: transport(sync_fetch(|_| Err(AppError("no fetch".into())))),
        };
        let ctx = RunCtx {
            state: &state,
            map_id: map_id.clone(),
            target: Target::Map { id: None },
            run_id: 1,
            cancel: Arc::new(AtomicBool::new(false)),
            deps: &deps,
            progress: Arc::new(Box::new(|_| {})),
            results: Arc::new(Box::new(|_| {})),
            undo_group: Arc::default(),
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
// Query
// -----------------------------------------------------------------------

/// Answers a query by reporting what it was configured with, the input it saw, and the
/// body of one host fetch. Every shape method is unreachable: a query needs none.
struct QueryProc {
    entry: String,
}

impl Procedure for QueryProc {
    fn shape(&self) -> ProcShape {
        ProcShape::Run
    }
    fn batch(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        unreachable!("a query answers no batch")
    }
    fn query(&mut self, input: &[u8], host: &mut dyn ProcHost, config: &str) -> AppResult<Vec<u8>> {
        let fetched = fetch_one(host, "https://example.invalid/q")?;
        // Progress and failures are no-ops here; calling them proves they do not panic.
        host.progress(1);
        host.fail(Id::new(1));
        assert!(!host.aborted());
        Ok(serde_json::json!({
            "entry": self.entry,
            "config": serde_json::from_str::<serde_json::Value>(config).unwrap(),
            "input": String::from_utf8_lossy(input),
            "fetched": String::from_utf8_lossy(&fetched.body),
        })
        .to_string()
        .into_bytes())
    }
}

fn procedure_decl(entry: &str) -> ProcedureDecl {
    ProcedureDecl {
        entry: entry.into(),
        policy: Policy::default(),
        config: None,
    }
}

fn query_deps(fetch: SendFn) -> EngineDeps {
    EngineDeps {
        factory: Box::new(|entry| {
            Ok(Box::new(QueryProc {
                entry: entry.to_string(),
            }) as Box<dyn Procedure>)
        }),
        transport: transport(fetch),
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
    let decl = ProcedureDecl {
        config: Some(r#"{"units":"metric"}"#.into()),
        ..procedure_decl("res://procedures/svMeta.js")
    };
    let out = run_query(
        &deps,
        &decl,
        r#"{"op":"metadata","panoIds":["a"]}"#,
        Arc::default(),
        None,
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
    let out = run_query(&deps, &procedure_decl("q.js"), "{}", Arc::default(), None)
        .expect("query succeeds");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["fetched"], serde_json::json!("pong"));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[test]
fn a_query_follows_its_declared_retry_policy() {
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    let deps = query_deps(sync_fetch(move |_| {
        seen.fetch_add(1, Ordering::Relaxed);
        Ok(HttpResponse {
            status: 429,
            body: Vec::new(),
        })
    }));
    let decl = ProcedureDecl {
        policy: Policy {
            retry: Some(RetrySpec {
                attempts: 1,
                on: vec![429],
            }),
            ..Policy::default()
        },
        ..procedure_decl("q.js")
    };
    let _ = run_query(&deps, &decl, "{}", Arc::default(), None);
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

struct WideQueryProc(usize);

impl Procedure for WideQueryProc {
    fn shape(&self) -> ProcShape {
        ProcShape::Run
    }
    fn batch(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        unreachable!("a query answers no batch")
    }
    fn query(
        &mut self,
        _input: &[u8],
        host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<u8>> {
        Ok(host.fetch(&gets(self.0)).len().to_string().into_bytes())
    }
}

#[test]
fn a_query_holds_its_declared_inflight_ceiling() {
    let peak = Arc::new(AtomicU32::new(0));
    let deps = EngineDeps {
        factory: Box::new(|_| Ok(Box::new(WideQueryProc(20)) as Box<dyn Procedure>)),
        transport: transport(barrier_fetch(
            u32::MAX,
            Duration::from_millis(150),
            peak.clone(),
        )),
    };
    let decl = ProcedureDecl {
        policy: Policy {
            inflight: Some(8),
            ..Policy::default()
        },
        ..procedure_decl("wide.js")
    };
    let out = run_query(&deps, &decl, "{}", Arc::default(), None).expect("query succeeds");
    assert_eq!(out, "20");
    assert_eq!(peak.load(Ordering::SeqCst), 8);
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
    let err = run_query(
        &deps,
        &procedure_decl("q.js"),
        "{}",
        Arc::new(AtomicBool::new(true)),
        None,
    )
    .unwrap_err();
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
                fetches: false,
                seen: Arc::new(Mutex::new(Vec::new())),
                on_map: patch_all("{}"),
                fail_id: None,
            }) as Box<dyn Procedure>)
        }),
        transport: transport(sync_fetch(|_| Err(AppError("no fetch expected".into())))),
    };
    let err = run_query(
        &deps,
        &procedure_decl("plain.js"),
        "{}",
        Arc::default(),
        None,
    )
    .expect_err("rejected");
    assert!(err.0.contains("does not implement query"), "{}", err.0);
}

// -----------------------------------------------------------------------
// Query partials
// -----------------------------------------------------------------------

/// Emits `count` partials through the host's emitter, when there is one, then answers.
struct EmittingQueryProc {
    count: u32,
}

impl Procedure for EmittingQueryProc {
    fn shape(&self) -> ProcShape {
        ProcShape::Run
    }
    fn batch(
        &mut self,
        _batch: &[u8],
        _host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<ResultEntry>> {
        unreachable!("a query answers no batch")
    }
    fn query(
        &mut self,
        _input: &[u8],
        host: &mut dyn ProcHost,
        _config: &str,
    ) -> AppResult<Vec<u8>> {
        if let Some(e) = host.emitter() {
            for i in 0..self.count {
                e.emit(Id::new(i), format!("\"p{i}\""));
            }
        }
        Ok(b"[]".to_vec())
    }
}

fn emitting_deps(count: u32) -> EngineDeps {
    EngineDeps {
        factory: Box::new(move |_| Ok(Box::new(EmittingQueryProc { count }) as Box<dyn Procedure>)),
        transport: transport(sync_fetch(|_| Err(AppError("no fetch expected".into())))),
    }
}

fn recording_partials(pages: &Arc<Mutex<Vec<ProcedureResult>>>) -> Arc<Partials> {
    let seen = pages.clone();
    Arc::new(Partials::new(
        7,
        "e.js".into(),
        Box::new(move |r| seen.lock().unwrap().push(r)),
    ))
}

#[test]
fn a_query_streams_partials_under_the_callers_token() {
    let pages = Arc::new(Mutex::new(Vec::new()));
    let deps = emitting_deps(5);
    run_query(
        &deps,
        &procedure_decl("e.js"),
        "{}",
        Arc::default(),
        Some(recording_partials(&pages)),
    )
    .expect("query succeeds");

    let pages = pages.lock().unwrap();
    let entries: Vec<ResultEntry> = pages.iter().flat_map(|p| p.entries.clone()).collect();
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[0].id, Id::new(0));
    assert_eq!(entries[0].json, "\"p0\"");
    assert_eq!(entries[4].id, Id::new(4));
    assert!(pages
        .iter()
        .all(|p| p.run_id == 7 && p.provider_id == "e.js" && p.failed.is_empty()));
}

#[test]
fn a_full_partial_page_leaves_before_the_query_ends() {
    let pages = Arc::new(Mutex::new(Vec::new()));
    let deps = emitting_deps(450);
    run_query(
        &deps,
        &procedure_decl("e.js"),
        "{}",
        Arc::default(),
        Some(recording_partials(&pages)),
    )
    .expect("query succeeds");

    let pages = pages.lock().unwrap();
    assert_eq!(pages.len(), 3, "two full pages and the flushed tail");
    assert_eq!(pages[0].entries.len(), 200);
    assert_eq!(pages.iter().map(|p| p.entries.len()).sum::<usize>(), 450);
}

#[test]
fn an_untokened_query_answers_with_nothing_streamed() {
    let deps = emitting_deps(3);
    let out = run_query(&deps, &procedure_decl("e.js"), "{}", Arc::default(), None)
        .expect("query succeeds without an emitter");
    assert_eq!(out, "[]");
}

// -----------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------

/// One request through the host, the way a procedure's single `mma.fetch` goes.
fn fetch_one(host: &mut dyn ProcHost, url: &str) -> AppResult<HttpResponse> {
    host.fetch(&[get(url)])
        .pop()
        .expect("one request answers once")
}

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
fn barrier_fetch(target: u32, wait: Duration, peak: Arc<AtomicU32>) -> SendFn {
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
    // Not a Patch<Location> at all: a collected answer is the module's own contract.
    let h = Harness::map_only(Arc::new(|rows: &[Location]| {
        Ok(rows
            .iter()
            .map(|r| ResultEntry {
                id: r.id,
                json: r.id.to_string(),
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
        vec![(Id::new(1), "1"), (Id::new(2), "2")]
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
    assert_eq!(pages[0].entries[0].id, Id::new(1));
    assert_eq!(pages[1].entries[0].id, Id::new(PAGE_SIZE as u32 + 1));
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
            .map(|r| ResultEntry {
                id: r.id,
                json: "7".into(),
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
        loc_ids([1, 2, 3])
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

// -----------------------------------------------------------------------
// Rows handed in
// -----------------------------------------------------------------------

#[test]
fn a_run_over_given_rows_chains_waves_in_its_own_store_and_leaves_the_map_alone() {
    let (state, map_id) = setup(&[loc(1, 1.0, 0.0)]);
    let mut a = decl("a", BatchMode::PerRow);
    a.fields = vec!["x".into()];
    let mut b = decl("b", BatchMode::PerRow);
    b.fields = vec!["y".into()];
    b.requires = vec!["x".into()];
    // One mock serves both: it writes `y` to a row that already carries `x`, else `x`.
    let h = Harness::map_only(Arc::new(|rows: &[Location]| {
        Ok(rows
            .iter()
            .map(|r| ResultEntry {
                id: r.id,
                json: if r
                    .extra
                    .as_ref()
                    .is_some_and(|e| e.as_str().contains("\"x\""))
                {
                    r#"{"extra":{"y":2}}"#.into()
                } else {
                    r#"{"extra":{"x":1}}"#.into()
                },
            })
            .collect())
    }));
    let target = given(&state, &map_id, vec![loc(1, 1.0, 0.0), loc(2, 2.0, 0.0)]);
    let progress: Arc<ProgressSink> = Arc::new(Box::new(|_| {}));
    // Pending edits emit no map change event, so results must include the updated rows.
    let streamed: Arc<Mutex<Vec<(String, Vec<u32>)>>> = Arc::default();
    let results: Arc<ResultSink> = {
        let streamed = streamed.clone();
        Arc::new(Box::new(move |r| {
            for e in &r.entries {
                let row: Location = serde_json::from_str(&e.json).unwrap();
                assert_eq!(row.id, e.id);
            }
            let ids = r.entries.iter().map(|e| e.id).map(Id::get).collect();
            streamed.lock().unwrap().push((r.provider_id, ids));
        }))
    };
    run_all(
        &RunCtx {
            target: target.clone(),
            run_id: 99,
            progress,
            results,
            ..h.ctx(&state, &map_id)
        },
        &[b, a].map(|d| ProviderDecl { force: false, ..d }),
    );

    let out = layer_rows(&state, &map_id, &target);
    assert_eq!(out.len(), 2);
    for row in &out {
        let extra: serde_json::Value =
            serde_json::from_str(row.extra.as_ref().unwrap().as_str()).unwrap();
        assert_eq!(extra, serde_json::json!({"x": 1, "y": 2}));
    }
    assert_eq!(
        *h.seen.lock().unwrap(),
        vec![vec![1], vec![2], vec![1], vec![2]]
    );
    assert_eq!(
        *streamed.lock().unwrap(),
        vec![("a".to_string(), vec![1, 2]), ("b".to_string(), vec![1, 2])]
    );
    assert_eq!(read_extra(&state, &map_id, 1), None);
}

#[test]
fn given_rows_do_not_write_to_the_open_map() {
    let seeded = Location {
        extra: RawExtra::from_string(r#"{"before":true}"#.into()),
        ..loc(1, 1.0, 0.0)
    };
    let (state, map_id) = setup(&[seeded]);
    let d = decl("writer", BatchMode::PerRow);
    let h = Harness::map_only(patch_extra_all(r#"{"written":true}"#));
    let target = given(&state, &map_id, vec![loc(1, 1.0, 0.0)]);
    let progress: Arc<ProgressSink> = Arc::new(Box::new(|_| {}));
    let results: Arc<ResultSink> = Arc::new(Box::new(|_| {}));
    run_all(
        &RunCtx {
            target: target.clone(),
            run_id: 50,
            progress,
            results,
            ..h.ctx(&state, &map_id)
        },
        &[d],
    );

    let held = layer_rows(&state, &map_id, &target);
    let given_extra: serde_json::Value =
        serde_json::from_str(held[0].extra.as_ref().unwrap().as_str()).unwrap();
    assert_eq!(given_extra["written"], serde_json::json!(true));

    let map_extra = read_extra(&state, &map_id, 1).unwrap();
    assert_eq!(map_extra["before"], serde_json::json!(true));
    assert!(
        map_extra.get("written").is_none(),
        "patch leaked to the map store: {map_extra}"
    );
}

// -----------------------------------------------------------------------
// Activity
// -----------------------------------------------------------------------

/// Polls the snapshot until `want` holds. Work that never reaches that state answers with
/// the last snapshot, so the test fails on its assertion rather than hanging.
fn await_activity(want: impl Fn(&ProcedureActivity) -> bool) -> ProcedureActivity {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = procedure_activity();
        if want(&snapshot) || Instant::now() > deadline {
            return snapshot;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn eight_rows() -> Vec<Location> {
    (1..=8).map(|i| loc(i, i as f64, 0.0)).collect()
}

#[test]
fn a_working_provider_reports_its_requests_in_flight() {
    let peak = Arc::new(AtomicU32::new(0));
    let (state, map_id) = setup(&eight_rows());
    let h = Harness::fetching(
        patch_all("{}"),
        barrier_fetch(u32::MAX, Duration::from_millis(800), peak.clone()),
    );
    let mut d = decl("activityHeld", BatchMode::PerRow);
    d.label = Some("Held".into());
    d.procedure.policy.inflight = Some(4);
    d.instances = Some(8);
    let ctx = h.ctx(&state, &map_id);

    let row = thread::scope(|s| {
        let run = s.spawn(|| run_provider(&ctx, &d));
        let snapshot = await_activity(|a| {
            a.runs
                .iter()
                .any(|r| r.provider_id == "activityHeld" && r.inflight == 4)
        });
        let row = snapshot
            .runs
            .into_iter()
            .find(|r| r.provider_id == "activityHeld");
        run.join().unwrap().unwrap();
        row
    })
    .expect("the provider is reported while it works");

    assert_eq!(row.label.as_deref(), Some("Held"));
    assert_eq!(row.total, 8);
    assert_eq!(row.inflight, 4);
    assert_eq!(row.inflight_limit, 4);
    assert_eq!(
        peak.load(Ordering::SeqCst),
        4,
        "the provider's instances share one session"
    );
    assert!(row.instances > 0, "no instance was counted alive");
    assert!(
        procedure_activity()
            .runs
            .iter()
            .all(|r| r.provider_id != "activityHeld"),
        "the provider outlived its run"
    );
}

#[test]
fn a_query_in_flight_is_reported_under_its_entry() {
    let peak = Arc::new(AtomicU32::new(0));
    let deps = query_deps(barrier_fetch(u32::MAX, Duration::from_millis(800), peak));
    let entry = "res://procedures/activityProbe.js";

    let row = thread::scope(|s| {
        let run = s.spawn(|| run_query(&deps, &procedure_decl(entry), "{}", Arc::default(), None));
        let snapshot = await_activity(|a| {
            a.queries
                .iter()
                .any(|q| q.entry == entry && q.inflight == 1)
        });
        let row = snapshot.queries.into_iter().find(|q| q.entry == entry);
        run.join().unwrap().unwrap();
        row
    })
    .expect("the query is reported while it runs");

    assert_eq!(row.inflight, 1);
    assert_eq!(row.inflight_limit, DEFAULT_INFLIGHT);
    assert!(
        procedure_activity()
            .queries
            .iter()
            .all(|q| q.entry != entry),
        "the query outlived its answer"
    );
}

#[test]
fn a_cancelled_run_leaves_nothing_reported() {
    let peak = Arc::new(AtomicU32::new(0));
    let (state, map_id) = setup(&eight_rows());
    let h = Harness::fetching(
        patch_all("{}"),
        barrier_fetch(u32::MAX, Duration::from_millis(800), peak),
    );
    let mut d = decl("activityCancelled", BatchMode::PerRow);
    d.procedure.policy.inflight = Some(2);
    d.instances = Some(4);
    let ctx = h.ctx(&state, &map_id);

    thread::scope(|s| {
        let run = s.spawn(|| run_provider(&ctx, &d));
        await_activity(|a| a.runs.iter().any(|r| r.provider_id == "activityCancelled"));
        h.cancel.store(true, Ordering::Relaxed);
        run.join().unwrap().unwrap();
    });

    assert!(
        procedure_activity()
            .runs
            .iter()
            .all(|r| r.provider_id != "activityCancelled"),
        "a cancelled run stayed registered"
    );
}

#[test]
fn a_released_pending_layer_waits_for_its_last_registered_writer() {
    let (state, map_id) = setup(&[]);
    let label = WindowLabel("pending-layer-lifetime".into());
    let target = Target::Pending {
        name: "draft".into(),
    };
    {
        let mut manager = state.lock().unwrap();
        manager.window_map.insert(label.clone(), map_id.clone());
        manager.store_for_map(&map_id).unwrap().at(&target).edit(
            vec![Op::Set(loc(1, 1.0, 1.0))],
            Default::default(),
            &mut None,
        );
    }

    let first = run_reserve();
    let second = run_reserve();
    let (_, first_cancel) = register_store_run(&state, &label, first, target.clone()).unwrap();
    let (_, second_cancel) = register_store_run(&state, &label, second, target.clone()).unwrap();
    {
        let mut manager = state.lock().unwrap();
        manager.store_for_map(&map_id).unwrap().close_layer("draft");
    }
    assert!(first_cancel.load(Ordering::Relaxed));
    assert!(second_cancel.load(Ordering::Relaxed));

    let late = run_reserve();
    assert!(register_store_run(&state, &label, late, target.clone()).is_err());
    assert!(unregister_run(late).is_none());

    {
        let mut manager = state.lock().unwrap();
        let store = manager.store_for_map(&map_id).unwrap();
        store.land("draft", &mut None);
        let pending = store.pending.get("draft").unwrap();
        assert_eq!(pending.stage, Stage::Discarded);
        assert!(
            store.get_loc_by_id(Id::new(1)).is_none(),
            "a discarded layer never lands"
        );
    }

    drop(RunGuard {
        state: &state,
        run_id: first,
    });
    assert!(state
        .lock()
        .unwrap()
        .store_for_map(&map_id)
        .unwrap()
        .pending
        .contains_key("draft"));

    drop(RunGuard {
        state: &state,
        run_id: second,
    });
    assert!(!state
        .lock()
        .unwrap()
        .store_for_map(&map_id)
        .unwrap()
        .pending
        .contains_key("draft"));
}

#[test]
fn dropping_a_landed_pending_layer_does_not_cancel_its_writer() {
    let (state, map_id) = setup(&[]);
    let label = WindowLabel("landed-pending-layer-lifetime".into());
    let target = Target::Pending {
        name: "draft".into(),
    };
    {
        let mut manager = state.lock().unwrap();
        manager.window_map.insert(label.clone(), map_id.clone());
        let store = manager.store_for_map(&map_id).unwrap();
        store.at(&target).edit(
            vec![Op::Set(loc(1, 1.0, 1.0))],
            Default::default(),
            &mut None,
        );
        store.land("draft", &mut None);
    }

    let run_id = run_reserve();
    let (_, cancel) = register_store_run(&state, &label, run_id, target).unwrap();
    {
        let mut manager = state.lock().unwrap();
        manager.store_for_map(&map_id).unwrap().close_layer("draft");
    }
    assert!(!cancel.load(Ordering::Relaxed));
    assert!(state
        .lock()
        .unwrap()
        .store_for_map(&map_id)
        .unwrap()
        .pending
        .get("draft")
        .unwrap()
        .stage
        .closed());

    drop(RunGuard {
        state: &state,
        run_id: run_id,
    });
    assert!(!state
        .lock()
        .unwrap()
        .store_for_map(&map_id)
        .unwrap()
        .pending
        .contains_key("draft"));
}
