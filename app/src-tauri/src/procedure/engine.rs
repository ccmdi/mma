//! Generic procedure executor. JS declares providers; this drives their procedures
//! over paged location batches, applies the resulting patches, and reports
//! progress. Nothing here knows what any provider actually computes.

use super::{HttpRequestSpec, HttpResponse, PatchEntry, ProcHost, ProcShape, Procedure};
use crate::selections::{ids_within, narrow, resolve_field_loc, Selector};
use crate::store::engine::{
    apply_updates, ExternalMutation, LocationPatch, StoreState, Update, WindowLabel,
};
use crate::types::{AppError, AppResult, Location};
use futures::executor;
use futures::future;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::slice;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tokio::runtime::Builder;
use tokio::runtime::Runtime;
use tokio::sync::Semaphore;
use tokio::sync::SemaphorePermit;
use tokio::task;
use tokio::time;

/// Locations materialized per lock acquisition. The engine never holds more than
/// one page of rows in memory per provider.
const PAGE_SIZE: usize = 10_000;
/// Procedure instances one provider may run at once. An instance costs a thread and an
/// interpreter, so this bounds the machine; network width is `inflight`.
const MAX_INSTANCES: u32 = 64;
/// Requests one provider keeps in flight when it declares no `inflight`.
const DEFAULT_INFLIGHT: u32 = 48;
/// Ceiling on a provider's in-flight requests. These are futures, not threads, so it
/// bounds what the remote endpoint sees rather than what the machine can hold.
const MAX_INFLIGHT: u32 = 1024;

/// Procedure instances a provider gets. `instances` is for procedures that cannot run beside
/// themselves -- one sidecar process, one large model in memory; everything else takes
/// one per logical CPU and draws its throughput from `inflight` instead.
fn instance_count(decl: &ProviderDecl) -> usize {
    let default = thread::available_parallelism().map_or(4, |n| n.get() as u32);
    decl.instances.unwrap_or(default).clamp(1, MAX_INSTANCES) as usize
}
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const DEFAULT_BACKOFF: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Declarations (from JS)
// ---------------------------------------------------------------------------

/// How a page of rows is cut into procedure calls.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum BatchMode {
    Chunk {
        size: u32,
    },
    PerRow,
    /// Group rows by a row field; the procedure sees one representative per distinct
    /// value and its patch fans back out to every row sharing it. v1 key: `panoId`.
    DedupeBy {
        key: String,
    },
}

/// What one attempt charges the bucket: the call itself, or one per row in its batch
/// (for APIs that bill multi-row requests per row).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RateCost {
    #[default]
    Request,
    Row,
}

/// Token bucket: `units` calls per `per_ms` milliseconds, refilled continuously.
#[derive(Clone, Copy, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RateSpec {
    pub units: u32,
    pub per_ms: u32,
    #[serde(default)]
    pub cost: RateCost,
}

/// Retry only the listed HTTP statuses, up to `attempts` total tries.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RetrySpec {
    pub attempts: u32,
    pub on: Vec<u16>,
}

/// Where a provider's results go. `Patch` applies them to the locations they name;
/// `Collect` delivers them to the caller and writes nothing. The declaration decides
/// this, never the contents of a result.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Sink {
    #[default]
    Patch,
    Collect,
}

/// One provider as declared by the frontend. `fields` are the extra keys it produces
/// and `requires` the keys it consumes; together they schedule dependency waves.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDecl {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    /// The procedure module: an absolute path, or `res://<rel>` for one bundled with the app.
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    pub select: Selector,
    pub batch: BatchMode,
    #[serde(default)]
    pub sink: Sink,
    #[serde(default)]
    pub rate: Option<RateSpec>,
    #[serde(default)]
    pub retry: Option<RetrySpec>,
    /// Re-derive this provider's fields even on a run that is not forced. For an
    /// operation whose whole point is to recompute one provider (pinning re-resolves the
    /// panorama) rather than to fill in what is missing.
    #[serde(default)]
    pub force: Option<bool>,
    /// Requests this provider may have in flight at once, summed over its instances.
    #[serde(default)]
    pub inflight: Option<u32>,
    /// Instances this provider may run at once. Declared only when the procedure
    /// cannot run beside itself; throughput comes from `inflight`.
    #[serde(default)]
    pub instances: Option<u32>,
    /// Provider-specific configuration, a JSON value as text. Passed through verbatim
    /// inside the object the procedure's `configure` receives.
    #[serde(default)]
    pub config: Option<String>,
}

#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "procedure-progress")]
pub struct ProcedureProgress {
    pub run_id: u32,
    pub provider_id: String,
    pub done: u32,
    pub total: u32,
    pub failed: u32,
    /// Rows counted as done without being worked, because they already held every field
    /// the provider produces. Callers subtract these to report what a run actually did.
    pub skipped: u32,
    pub finished: bool,
}

/// One location's answer from a `Collect` provider: whatever its module emitted for
/// that row, carried as text exactly as a patch would be.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultEntry {
    pub id: u32,
    pub json: String,
}

/// What one page hands back to the caller: a `Collect` provider's answers, delivered
/// instead of being written, and for every sink the rows that failed. Emitted only when
/// there is something in it.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "procedure-result")]
pub struct ProcedureResult {
    pub run_id: u32,
    pub provider_id: String,
    pub entries: Vec<ResultEntry>,
    /// Rows the procedure failed, or every row of a batch whose call failed.
    pub failed: Vec<u32>,
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

pub type ProcedureFactory = Box<dyn Fn(&str) -> AppResult<Box<dyn Procedure>> + Send + Sync>;

/// The procedure module a provider names, or the error naming the provider that lacks one.
pub fn entry_of(decl: &ProviderDecl) -> AppResult<&str> {
    decl.entry.as_deref().ok_or_else(|| {
        AppError(format!(
            "provider '{}' declares no procedure module",
            decl.id
        ))
    })
}
/// One request, in flight. Async because a provider's width is counted in requests and
/// not in threads: hundreds of these can be pending on the http runtime at once.
pub type FetchFuture = Pin<Box<dyn Future<Output = AppResult<HttpResponse>> + Send>>;
pub type FetchFn = Box<dyn Fn(HttpRequestSpec) -> FetchFuture + Send + Sync>;
pub type ProgressSink = Box<dyn Fn(ProcedureProgress) + Send + Sync>;
/// Where a `Collect` provider's pages go. Production emits them; tests record them.
pub type ResultSink = Box<dyn Fn(ProcedureResult) + Send + Sync>;

/// Everything the engine reaches outside the store. Production wires the QuickJS host
/// and an async reqwest client; tests inject mocks.
pub struct EngineDeps {
    pub factory: ProcedureFactory,
    pub fetch: FetchFn,
    /// First retry delay; doubles per attempt. Tests shrink it to keep runs fast.
    pub backoff: Duration,
}

impl EngineDeps {
    pub fn production() -> Self {
        EngineDeps {
            factory: Box::new(|entry| {
                let proc = super::quickjs::checkout(&resolve_entry(entry)?)?;
                Ok(Box::new(proc) as Box<dyn Procedure>)
            }),
            fetch: Box::new(|req| Box::pin(http_fetch(req))),
            backoff: DEFAULT_BACKOFF,
        }
    }
}

/// `res://<rel>` names a module bundled with the app; anything else is a filesystem path.
/// A dev build reads the bundle from the crate: nothing copies `bundle.resources` beside
/// the dev exe, so the resource dir there is whatever an earlier build left behind.
fn resolve_entry(spec: &str) -> AppResult<PathBuf> {
    let Some(rel) = spec.strip_prefix("res://") else {
        return Ok(PathBuf::from(spec));
    };
    if tauri::is_dev() {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel));
    }
    let app = crate::app_handle()
        .ok_or_else(|| AppError("procedure: no app handle for resource lookup".to_string()))?;
    let dir = tauri::Manager::path(app)
        .resource_dir()
        .map_err(|e| AppError(format!("procedure: resource dir unavailable: {e}")))?;
    Ok(dir.join(rel))
}

fn http_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .use_rustls_tls()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build the procedure http client")
    })
}

/// Test-only: swap the origin of an outgoing URL for the local e2e Street View stub,
/// keeping path and query.
#[cfg(feature = "e2e")]
fn rewrite_origin(url: &str, origin: &str) -> String {
    let path = url
        .find("://")
        .map(|i| i + 3)
        .and_then(|start| url[start..].find('/').map(|j| &url[start + j..]))
        .unwrap_or("/");
    format!("{}{}", origin.trim_end_matches('/'), path)
}

#[cfg(feature = "e2e")]
fn e2e_origin() -> Option<&'static str> {
    static O: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    O.get_or_init(|| {
        std::env::var("MMA_E2E_SV_ORIGIN")
            .ok()
            .filter(|s| !s.is_empty())
    })
    .as_deref()
}

async fn http_fetch(req: HttpRequestSpec) -> AppResult<HttpResponse> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| AppError(format!("procedure: bad method '{}': {e}", req.method)))?;
    #[cfg(feature = "e2e")]
    let url = match e2e_origin() {
        Some(o) => rewrite_origin(&req.url, o),
        None => req.url.clone(),
    };
    #[cfg(not(feature = "e2e"))]
    let url = &req.url;
    let mut rb = http_client().request(method, url.as_str());
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(body) = &req.body {
        rb = rb.body(body.clone());
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| AppError(format!("procedure: request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError(format!("procedure: body read failed: {e}")))?
        .to_vec();
    Ok(HttpResponse { status, body })
}

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

fn runs() -> &'static Mutex<HashMap<u32, Arc<AtomicBool>>> {
    static R: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_run() -> AppResult<(u32, Arc<AtomicBool>)> {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    runs().lock()?.insert(id, cancel.clone());
    Ok((id, cancel))
}

fn unregister_run(run_id: u32) {
    if let Ok(mut m) = runs().lock() {
        m.remove(&run_id);
    }
}

// ---------------------------------------------------------------------------
// Wave scheduling
// ---------------------------------------------------------------------------

/// A provider runs once no other unscheduled provider produces a field it requires.
/// A dependency cycle collapses the remainder into one wave.
pub(crate) fn provider_waves(list: &[ProviderDecl]) -> Vec<Vec<usize>> {
    let mut waves = Vec::new();
    let mut remaining: Vec<usize> = (0..list.len()).collect();
    while !remaining.is_empty() {
        let mut wave: Vec<usize> = remaining
            .iter()
            .copied()
            .filter(|&i| {
                !list[i].requires.iter().any(|r| {
                    remaining
                        .iter()
                        .any(|&j| j != i && list[j].fields.iter().any(|f| f == r))
                })
            })
            .collect();
        if wave.is_empty() {
            wave = remaining.clone();
        }
        remaining.retain(|i| !wave.contains(i));
        waves.push(wave);
    }
    waves
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

struct RateLimiter {
    capacity: f64,
    /// Tokens regained per millisecond.
    per_ms: f64,
    state: Mutex<(f64, Instant)>,
}

impl RateLimiter {
    fn new(spec: RateSpec) -> Option<Self> {
        if spec.units == 0 || spec.per_ms == 0 {
            return None;
        }
        Some(RateLimiter {
            capacity: spec.units as f64,
            per_ms: spec.units as f64 / spec.per_ms as f64,
            state: Mutex::new((spec.units as f64, Instant::now())),
        })
    }

    /// Waits until `cost` tokens are available. Sleeps outside the lock so waiters
    /// queue. A cost above capacity is clamped, otherwise it could never be paid.
    async fn acquire(&self, cost: u32) {
        let want = (cost.max(1) as f64).min(self.capacity);
        loop {
            let wait = {
                let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                let now = Instant::now();
                let elapsed_ms = now.duration_since(st.1).as_secs_f64() * 1000.0;
                st.0 = (st.0 + elapsed_ms * self.per_ms).min(self.capacity);
                st.1 = now;
                if st.0 >= want {
                    st.0 -= want;
                    return;
                }
                Duration::from_secs_f64((want - st.0) / self.per_ms / 1000.0)
            };
            time::sleep(wait.max(Duration::from_micros(200))).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/// What a request declined by a cancelling run answers with.
pub(super) const CANCELLED: &str = "procedure: run cancelled";

/// A provider's share of the network for the length of its run: how many requests may be
/// in flight at once, and how fast they may be issued. Every instance of the provider
/// draws on the same budget, so throughput is a property of the provider rather than of
/// how many instances happen to be running.
struct FetchBudget {
    slots: Semaphore,
    limiter: Option<RateLimiter>,
}

impl FetchBudget {
    fn new(inflight: Option<u32>, rate: Option<RateSpec>) -> Self {
        let width = inflight.unwrap_or(DEFAULT_INFLIGHT).clamp(1, MAX_INFLIGHT);
        FetchBudget {
            slots: Semaphore::new(width as usize),
            limiter: rate.and_then(RateLimiter::new),
        }
    }

    /// Waits for the rate bucket, then for a slot. The slot is held until the response
    /// lands, so `inflight` counts requests actually outstanding.
    async fn admit(&self, cost: u32) -> SemaphorePermit<'_> {
        if let Some(l) = &self.limiter {
            l.acquire(cost).await;
        }
        self.slots
            .acquire()
            .await
            .expect("the budget semaphore is never closed")
    }
}

/// The runtime every procedure request runs on. Requests are futures here, not threads,
/// which is what lets `inflight` be hundreds while `instances` stays near the core count.
fn http_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("procedure-http")
            .build()
            .expect("failed to build the procedure http runtime")
    })
}

/// Drive `f` on the calling thread with the http runtime entered, so the requests and
/// timers inside it reach that runtime's driver. Entering rather than `Runtime::block_on`
/// keeps this callable from a thread that is already inside a runtime.
fn drive<T>(f: impl Future<Output = T>) -> T {
    let _entered = http_runtime().enter();
    executor::block_on(f)
}

/// One request under a retry policy: `attempts` total tries, sleeping `backoff` and
/// doubling between the statuses `retry_on` names. Budget is paid per attempt.
async fn fetch_one(
    deps: &EngineDeps,
    budget: &FetchBudget,
    cost: u32,
    attempts: u32,
    retry_on: &[u16],
    aborted: &(dyn Fn() -> bool + Sync),
    req: &HttpRequestSpec,
) -> AppResult<HttpResponse> {
    let attempts = attempts.max(1);
    let mut delay = deps.backoff;
    for attempt in 0..attempts {
        let resp = {
            let _slot = budget.admit(cost).await;
            // Checked holding the slot: a request that waited behind a long backlog must
            // not be sent once the run is cancelling.
            if aborted() {
                return Err(AppError(CANCELLED.into()));
            }
            (deps.fetch)(req.clone()).await?
        };
        if !retry_on.contains(&resp.status) || attempt + 1 == attempts {
            return Ok(resp);
        }
        time::sleep(delay).await;
        delay *= 2;
    }
    unreachable!("attempts is at least 1")
}

/// Answer every request, in request order, as wide as the budget allows. A request that
/// fails answers with its own error: one bad request does not lose the others.
fn fetch_all(
    deps: &EngineDeps,
    budget: &FetchBudget,
    cost: u32,
    attempts: u32,
    retry_on: &[u16],
    aborted: &(dyn Fn() -> bool + Sync),
    reqs: &[HttpRequestSpec],
) -> Vec<AppResult<HttpResponse>> {
    drive(future::join_all(reqs.iter().map(|req| {
        fetch_one(deps, budget, cost, attempts, retry_on, aborted, req)
    })))
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

struct ProviderProgress {
    run_id: u32,
    provider_id: String,
    total: u32,
    done: AtomicU32,
    failed: AtomicU32,
    skipped: AtomicU32,
    last: Mutex<Instant>,
    sink: Arc<ProgressSink>,
}

impl ProviderProgress {
    fn new(run_id: u32, provider_id: String, total: u32, sink: Arc<ProgressSink>) -> Self {
        ProviderProgress {
            run_id,
            provider_id,
            total,
            done: AtomicU32::new(0),
            failed: AtomicU32::new(0),
            skipped: AtomicU32::new(0),
            last: Mutex::new(Instant::now()),
            sink,
        }
    }

    fn add_done(&self, n: u32) {
        if n == 0 {
            return;
        }
        self.done.fetch_add(n, Ordering::Relaxed);
        self.maybe_emit();
    }

    fn add_failed(&self, n: u32) {
        self.failed.fetch_add(n, Ordering::Relaxed);
    }

    /// Rows that needed nothing. They complete the bar like any other row, but they are
    /// not work, so a caller reporting what the run did subtracts them.
    fn add_skipped(&self, n: u32) {
        if n == 0 {
            return;
        }
        self.skipped.fetch_add(n, Ordering::Relaxed);
        self.add_done(n);
    }

    fn snapshot(&self, finished: bool) -> ProcedureProgress {
        ProcedureProgress {
            run_id: self.run_id,
            provider_id: self.provider_id.clone(),
            done: self.done.load(Ordering::Relaxed),
            total: self.total,
            failed: self.failed.load(Ordering::Relaxed),
            skipped: self.skipped.load(Ordering::Relaxed),
            finished,
        }
    }

    fn maybe_emit(&self) {
        {
            let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
            if last.elapsed() < PROGRESS_INTERVAL {
                return;
            }
            *last = Instant::now();
        }
        (self.sink)(self.snapshot(false));
    }

    /// Announces the provider before any batch, so a listener sees its total at once
    /// rather than the previous phase's last snapshot until the first batch returns.
    fn start(&self) {
        (self.sink)(self.snapshot(false));
    }

    fn finish(&self) {
        (self.sink)(self.snapshot(true));
    }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

pub(crate) struct RunCtx<'a> {
    pub state: &'a StoreState,
    pub map_id: String,
    pub run_id: u32,
    pub force: bool,
    pub cancel: Arc<AtomicBool>,
    pub deps: &'a EngineDeps,
    pub progress: Arc<ProgressSink>,
    pub results: Arc<ResultSink>,
}

impl RunCtx<'_> {
    fn aborted(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// One procedure call's worth of work.
struct WorkBatch {
    /// Rows handed to the procedure (representatives only under `DedupeBy`).
    rows: Vec<Location>,
    /// Representative id -> every location id that shares its key.
    fanout: Option<HashMap<u32, Vec<u32>>>,
    /// Every location id this batch accounts for, sharers included.
    ids: Vec<u32>,
}

impl WorkBatch {
    /// How many locations this batch accounts for in progress and failure counts.
    fn units(&self) -> u32 {
        self.ids.len() as u32
    }
}

/// Schedule the run's providers into dependency waves and execute each wave
/// concurrently. Blocking throughout: callers put this on a blocking thread.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_all(
    state: &StoreState,
    map_id: &str,
    providers: &[ProviderDecl],
    force: bool,
    run_id: u32,
    cancel: &Arc<AtomicBool>,
    deps: &EngineDeps,
    progress: &Arc<ProgressSink>,
    results: &Arc<ResultSink>,
) {
    for wave in provider_waves(providers) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        thread::scope(|s| {
            for idx in wave {
                let decl = &providers[idx];
                let ctx = RunCtx {
                    state,
                    map_id: map_id.to_owned(),
                    run_id,
                    force,
                    cancel: cancel.clone(),
                    deps,
                    progress: progress.clone(),
                    results: results.clone(),
                };
                s.spawn(move || {
                    if let Err(e) = run_provider(&ctx, decl) {
                        log::error!("[procedure] provider '{}' failed: {e}", decl.id);
                        // A provider that never reports finished would hang its listener.
                        (ctx.progress)(ProcedureProgress {
                            run_id,
                            provider_id: decl.id.clone(),
                            done: 0,
                            total: 0,
                            failed: 0,
                            skipped: 0,
                            finished: true,
                        });
                    }
                });
            }
        });
    }
    unregister_run(run_id);
}

pub(crate) fn run_provider(ctx: &RunCtx, decl: &ProviderDecl) -> AppResult<()> {
    let ids: Vec<u32> = {
        let mut mgr = ctx.state.lock()?;
        let store = mgr.store_for_map(&ctx.map_id)?;
        let view = store.loc_view();
        let set = narrow(&view, &decl.select);
        ids_within(&view, set.as_ref())
    };
    let total = ids.len() as u32;
    let started = Instant::now();
    log::info!(
        "[procedure] run={} provider='{}' ({}) total={}",
        ctx.run_id,
        decl.id,
        decl.label.as_deref().unwrap_or("-"),
        total
    );
    let prog = ProviderProgress::new(ctx.run_id, decl.id.clone(), total, ctx.progress.clone());
    prog.start();
    let force = decl.force.unwrap_or(ctx.force);
    let batch_mode = effective_batch_mode(ctx, decl)?;
    // One budget for the provider, not one per page or per instance.
    let budget = FetchBudget::new(decl.inflight, decl.rate);
    let config = configure_json(&decl.fields, force, decl.config.as_deref());
    // No more instances than the run can keep busy: a one-row run must not load a
    // procedure per core.
    let instances = instance_count(decl).min(batch_ceiling(&batch_mode, total).max(1));

    // Created and configured before any batch is queued: with no live consumer the
    // producer would block forever on a full queue, so a provider that cannot start a
    // single instance fails the run instead of stranding it.
    let mut procs: Vec<Box<dyn Procedure>> = Vec::with_capacity(instances);
    let mut create_err: Option<AppError> = None;
    for _ in 0..instances {
        match entry_of(decl)
            .and_then(&ctx.deps.factory)
            .and_then(|mut p| p.configure(&config).map(|_| p))
        {
            Ok(p) => procs.push(p),
            Err(e) => create_err = Some(e),
        }
    }
    if let Some(e) = create_err {
        if procs.is_empty() {
            return Err(e);
        }
        log::warn!(
            "[procedure] provider '{}': some instances failed to start: {e}",
            decl.id
        );
    }

    // Three roles, so a page boundary never drains the pipeline: this thread pages rows
    // into a bounded queue (at most a couple of pages ahead), the instances pull batches
    // across page boundaries, and one applier writes each page as its last batch lands.
    let (batch_tx, batch_rx) = mpsc::sync_channel::<Tagged>(procs.len() * 2);
    let batch_rx = Mutex::new(batch_rx);
    let (out_tx, out_rx) = mpsc::channel::<Produced>();
    let outcome = thread::scope(|s| {
        for mut proc in procs {
            let out_tx = out_tx.clone();
            let (batch_rx, budget, prog) = (&batch_rx, &budget, &prog);
            s.spawn(move || run_instance(ctx, decl, budget, prog, &mut *proc, batch_rx, &out_tx));
        }
        let applier = s.spawn(|| apply_pages(ctx, decl, out_rx));

        let mut produced = Ok(());
        for (page, chunk) in ids.chunks(PAGE_SIZE).enumerate() {
            if ctx.aborted() {
                break;
            }
            let batches = match page_batches(ctx, decl, chunk, force, &batch_mode, &prog) {
                Ok(b) => b,
                Err(e) => {
                    produced = Err(e);
                    break;
                }
            };
            if batches.is_empty() {
                continue;
            }
            let _ = out_tx.send(Produced::PageStart {
                page,
                batches: batches.len(),
            });
            for batch in batches {
                if batch_tx.send(Tagged { page, batch }).is_err() {
                    break;
                }
            }
        }
        // Closing the queue ends the instances once it drains; the applier ends when the
        // last of them has hung up.
        drop(batch_tx);
        drop(out_tx);
        let applied = applier
            .join()
            .unwrap_or_else(|_| Err(AppError("procedure: applier panicked".into())));
        produced.and(applied)
    });
    outcome?;
    prog.finish();
    log::info!(
        "[procedure] run={} provider='{}' done={} skipped={} failed={} in {}ms",
        ctx.run_id,
        decl.id,
        prog.done.load(Ordering::Relaxed),
        prog.skipped.load(Ordering::Relaxed),
        prog.failed.load(Ordering::Relaxed),
        started.elapsed().as_millis()
    );
    Ok(())
}

/// The rows of one page the procedure still has to work, cut into batches. Rows already
/// holding every field the provider produces are counted as skipped and dropped here; rows
/// missing a field it `requires` are failed here, since no procedure body can work them.
fn page_batches(
    ctx: &RunCtx,
    decl: &ProviderDecl,
    page: &[u32],
    force: bool,
    batch_mode: &BatchMode,
    prog: &ProviderProgress,
) -> AppResult<Vec<WorkBatch>> {
    let rows = {
        let mut mgr = ctx.state.lock()?;
        let store = mgr.store_for_map(&ctx.map_id)?;
        store.collect(&Selector::Locations {
            locations: page.to_vec(),
            name: None,
        })
    };
    let before = rows.len() as u32;
    let rows: Vec<Location> = if force {
        rows
    } else {
        rows.into_iter()
            .filter(|l| decl.fields.is_empty() || !has_all_fields(l, &decl.fields))
            .collect()
    };
    prog.add_skipped(before - rows.len() as u32);

    // `force` re-derives an output; it cannot supply a missing input, so the gate holds.
    let (rows, unmet): (Vec<Location>, Vec<Location>) = rows
        .into_iter()
        .partition(|l| has_all_fields(l, &decl.requires));
    if !unmet.is_empty() {
        prog.add_failed(unmet.len() as u32);
        prog.add_done(unmet.len() as u32);
        deliver_page(
            ctx,
            decl,
            PageOutput {
                failed: unmet.iter().map(|l| l.id).collect(),
                ..PageOutput::default()
            },
        )?;
    }

    if rows.is_empty() {
        return Ok(Vec::new());
    }
    split_batches(batch_mode, rows)
}

/// An upper bound on how many batches `total` rows can become, before skipping. Batches
/// are cut per page, so a chunk larger than a page still yields one batch per page.
fn batch_ceiling(mode: &BatchMode, total: u32) -> usize {
    let total = total as usize;
    let pages = total.div_ceil(PAGE_SIZE);
    match mode {
        BatchMode::PerRow => total,
        BatchMode::Chunk { size } => total.min(PAGE_SIZE).div_ceil((*size).max(1) as usize) * pages,
        BatchMode::DedupeBy { .. } => pages,
    }
}

/// A batch on the queue, tagged with the page it belongs to.
struct Tagged {
    page: usize,
    batch: WorkBatch,
}

/// What reaches the applier.
enum Produced {
    /// A page was cut into `batches` calls; the applier writes it once that many arrived.
    PageStart { page: usize, batches: usize },
    /// One batch's product, `None` when its call failed.
    Batch {
        page: usize,
        product: Option<BatchProduct>,
        failed: Vec<u32>,
    },
}

/// Write one page: patches to the store, answers and failed ids to the caller.
fn deliver_page(ctx: &RunCtx, decl: &ProviderDecl, page: PageOutput) -> AppResult<()> {
    if !page.updates.is_empty() {
        let result = {
            let mut mgr = ctx.state.lock()?;
            let store = mgr.store_for_map(&ctx.map_id)?;
            apply_updates(store, &page.updates, true)
        };
        crate::emit_event(ExternalMutation {
            result,
            map_id: ctx.map_id.clone(),
        });
    }
    if !page.entries.is_empty() || !page.failed.is_empty() {
        (ctx.results)(ProcedureResult {
            run_id: ctx.run_id,
            provider_id: decl.id.clone(),
            entries: page
                .entries
                .into_iter()
                .map(|e| ResultEntry {
                    id: e.id,
                    json: e.patch,
                })
                .collect(),
            failed: page.failed,
        });
    }
    Ok(())
}

/// Gathers batch products by page and delivers each page as it completes. Whatever has
/// completed of a page when the queue closes (a cancel) is delivered too: an applied batch
/// is never thrown away.
// The receiver rides into the applier thread, so it is owned even though only `recv` is called.
#[allow(clippy::needless_pass_by_value)]
fn apply_pages(ctx: &RunCtx, decl: &ProviderDecl, rx: mpsc::Receiver<Produced>) -> AppResult<()> {
    #[derive(Default)]
    struct Pending {
        expected: usize,
        seen: usize,
        out: PageOutput,
    }
    let mut pages: HashMap<usize, Pending> = HashMap::new();
    while let Ok(msg) = rx.recv() {
        match msg {
            Produced::PageStart { page, batches } => {
                pages.entry(page).or_default().expected = batches;
            }
            Produced::Batch {
                page,
                product,
                failed,
            } => {
                let p = pages.entry(page).or_default();
                p.seen += 1;
                match product {
                    Some(BatchProduct::Patches(u)) => p.out.updates.extend(u),
                    Some(BatchProduct::Entries(e)) => p.out.entries.extend(e),
                    None => {}
                }
                p.out.failed.extend(failed);
                if p.expected > 0 && p.seen == p.expected {
                    let done = pages.remove(&page).expect("just inserted");
                    deliver_page(ctx, decl, done.out)?;
                }
            }
        }
    }
    let mut left: Vec<(usize, Pending)> = pages.into_iter().collect();
    left.sort_by_key(|(page, _)| *page);
    for (_, p) in left {
        deliver_page(ctx, decl, p.out)?;
    }
    Ok(())
}

fn has_all_fields(loc: &Location, fields: &[String]) -> bool {
    fields.iter().all(|f| resolve_field_loc(loc, f).is_some())
}

/// A chunk only carries meaning when it becomes one request. For a MapOnly procedure
/// the declared size is just a ceiling, so a page is cut finely enough to occupy
/// every instance instead of handing one instance the whole page.
fn effective_batch_mode(ctx: &RunCtx, decl: &ProviderDecl) -> AppResult<BatchMode> {
    let BatchMode::Chunk { size } = &decl.batch else {
        return Ok(decl.batch.clone());
    };
    if (ctx.deps.factory)(entry_of(decl)?)?.shape() != ProcShape::MapOnly {
        return Ok(decl.batch.clone());
    }
    let per_instance = (PAGE_SIZE as u32).div_ceil(instance_count(decl) as u32);
    Ok(BatchMode::Chunk {
        size: (*size).min(per_instance).max(1),
    })
}

fn split_batches(mode: &BatchMode, rows: Vec<Location>) -> AppResult<Vec<WorkBatch>> {
    match mode {
        BatchMode::PerRow => Ok(rows
            .into_iter()
            .map(|r| WorkBatch {
                ids: vec![r.id],
                rows: vec![r],
                fanout: None,
            })
            .collect()),
        BatchMode::Chunk { size } => {
            let size = (*size).max(1) as usize;
            Ok(rows
                .chunks(size)
                .map(|c| WorkBatch {
                    ids: c.iter().map(|r| r.id).collect(),
                    rows: c.to_vec(),
                    fanout: None,
                })
                .collect())
        }
        BatchMode::DedupeBy { key } => {
            if key != "panoId" {
                return Err(AppError(format!(
                    "procedure: dedupeBy key '{key}' unsupported"
                )));
            }
            let ids: Vec<u32> = rows.iter().map(|r| r.id).collect();
            let mut order: Vec<String> = Vec::new();
            let mut groups: HashMap<String, Vec<u32>> = HashMap::new();
            let mut reps: Vec<Location> = Vec::new();
            for row in rows {
                // A row missing the key can't dedupe against anything, so it stands alone.
                let k = match row.pano_id.as_deref() {
                    Some(p) if !p.is_empty() => p.to_string(),
                    _ => format!("\u{0}{}", row.id),
                };
                match groups.get_mut(&k) {
                    Some(members) => members.push(row.id),
                    None => {
                        groups.insert(k.clone(), vec![row.id]);
                        order.push(k);
                        reps.push(row);
                    }
                }
            }
            let fanout = reps
                .iter()
                .zip(order)
                .map(|(rep, k)| (rep.id, groups.remove(&k).unwrap()))
                .collect();
            Ok(vec![WorkBatch {
                rows: reps,
                fanout: Some(fanout),
                ids,
            }])
        }
    }
}

/// The configuration object a procedure sees: the engine's own view of the run
/// (which fields are wanted, whether it is a forced re-run) plus the provider's
/// opaque config, spliced in verbatim. Unparseable provider config reads as null
/// rather than failing the run.
fn configure_json(fields: &[String], force: bool, config: Option<&str>) -> String {
    let config = config.and_then(|s| serde_json::from_str::<Box<RawValue>>(s).ok());
    serde_json::json!({ "fields": fields, "force": force, "config": config }).to_string()
}

/// What one page produced. Which of the first two is filled follows from the declared
/// sink: a `Patch` provider yields store updates, a `Collect` provider yields answers.
#[derive(Default)]
struct PageOutput {
    updates: Vec<Update<LocationPatch>>,
    entries: Vec<PatchEntry>,
    /// Rows the procedure failed, plus every row of a batch whose call failed.
    failed: Vec<u32>,
}

/// One procedure instance, working the queue until it closes or the run is cancelled.
fn run_instance(
    ctx: &RunCtx,
    decl: &ProviderDecl,
    budget: &FetchBudget,
    prog: &ProviderProgress,
    proc: &mut dyn Procedure,
    batches: &Mutex<mpsc::Receiver<Tagged>>,
    out: &mpsc::Sender<Produced>,
) {
    loop {
        if ctx.aborted() {
            return;
        }
        let next = batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .recv();
        let Ok(Tagged { page, batch }) = next else {
            return;
        };
        let mut host = EngineHost {
            ctx,
            decl,
            budget,
            rate_cost: match decl.rate.map(|r| r.cost) {
                Some(RateCost::Row) => batch.rows.len() as u32,
                _ => 1,
            },
            prog,
            reported: 0,
            failed: Vec::new(),
        };
        let result = run_batch(proc, &batch, &mut host)
            .map(|entries| fan_out(entries, batch.fanout.as_ref()))
            .and_then(|entries| match decl.sink {
                // Only the patch sink parses: a collected answer is the module's
                // contract with its caller, not a LocationPatch.
                Sink::Patch => to_updates(&entries).map(BatchProduct::Patches),
                Sink::Collect => Ok(BatchProduct::Entries(entries)),
            });
        let units = batch.units();
        let reported = host.reported.min(units);
        let (product, failed) = match result {
            Ok(p) => (Some(p), host.failed),
            Err(e) => {
                // A batch cut short by a cancel is not a failure worth a warning.
                if ctx.aborted() {
                    log::debug!("[procedure] provider '{}' batch cancelled: {e}", decl.id);
                } else {
                    log::warn!("[procedure] provider '{}' batch failed: {e}", decl.id);
                }
                prog.add_failed(units);
                (None, batch.ids)
            }
        };
        let _ = out.send(Produced::Batch {
            page,
            product,
            failed,
        });
        prog.add_done(units - reported);
    }
}

/// One batch's product, before it joins the page.
enum BatchProduct {
    Patches(Vec<Update<LocationPatch>>),
    Entries(Vec<PatchEntry>),
}

fn run_batch(
    proc: &mut dyn Procedure,
    batch: &WorkBatch,
    host: &mut EngineHost,
) -> AppResult<Vec<PatchEntry>> {
    let blob = serde_json::to_vec(&batch.rows)
        .map_err(|e| AppError(format!("batch could not be serialized: {e}")))?;
    match proc.shape() {
        ProcShape::MapOnly => proc.map(
            &blob,
            &HttpResponse {
                status: 0,
                body: Vec::new(),
            },
            host,
        ),
        ProcShape::RequestMap => {
            let req = proc.request(&blob)?;
            let resp = host.fetch(&req)?;
            proc.map(&blob, &resp, host)
        }
        ProcShape::Run => proc.run(&blob, host),
    }
}

/// The camelCase wire names of every `LocationPatch` field, read off the type itself so
/// the two cannot drift. A patch entry carrying anything else fails its batch rather than
/// being silently ignored.
fn patch_keys() -> &'static [String] {
    static KEYS: OnceLock<Vec<String>> = OnceLock::new();
    KEYS.get_or_init(|| match serde_json::to_value(LocationPatch::default()) {
        Ok(serde_json::Value::Object(map)) => map.into_iter().map(|(k, _)| k).collect(),
        _ => unreachable!("LocationPatch serializes as an object"),
    })
}

/// Validate one entry's JSON and hand back its object. `None` when the patch sets
/// nothing, which is dropped rather than applied -- an empty `extra` merge patch in
/// particular must not reach the store, where it would read as "clear extra".
fn patch_object(
    entry: &PatchEntry,
) -> AppResult<Option<serde_json::Map<String, serde_json::Value>>> {
    let err = |msg: String| AppError(format!("patch for location {}: {msg}", entry.id));
    let value: serde_json::Value =
        serde_json::from_str(&entry.patch).map_err(|e| err(e.to_string()))?;
    let serde_json::Value::Object(mut map) = value else {
        return Err(err("expected a LocationPatch object".into()));
    };
    if let Some(key) = map.keys().find(|k| !patch_keys().iter().any(|p| p == *k)) {
        return Err(err(format!("unknown field `{key}`")));
    }
    let empty_extra = map.get("extra").and_then(|v| v.as_object());
    if empty_extra.is_some_and(serde_json::Map::is_empty) {
        map.remove("extra");
    }
    Ok((!map.is_empty()).then_some(map))
}

/// Repeat a deduped representative's answer for every row it stood for. Without a
/// fanout map the entries already name their own rows and pass through untouched.
fn fan_out(entries: Vec<PatchEntry>, fanout: Option<&HashMap<u32, Vec<u32>>>) -> Vec<PatchEntry> {
    let Some(fanout) = fanout else {
        return entries;
    };
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        match fanout.get(&e.id) {
            Some(ids) => out.extend(ids.iter().map(|&id| PatchEntry {
                id,
                patch: e.patch.clone(),
            })),
            None => out.push(e),
        }
    }
    out
}

/// Parse each entry's JSON into a store patch. A patch that sets nothing is dropped;
/// one that does not parse fails the whole batch.
fn to_updates(entries: &[PatchEntry]) -> AppResult<Vec<Update<LocationPatch>>> {
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        let Some(map) = patch_object(e)? else {
            continue;
        };
        let patch = serde_json::from_value(serde_json::Value::Object(map))
            .map_err(|err| AppError(format!("patch for location {}: {err}", e.id)))?;
        out.push(Update { id: e.id, patch });
    }
    Ok(out)
}

struct EngineHost<'a> {
    ctx: &'a RunCtx<'a>,
    decl: &'a ProviderDecl,
    /// The provider's, not this instance's: every instance shares one budget.
    budget: &'a FetchBudget,
    /// Tokens one fetch attempt charges, per the declared `RateCost`.
    rate_cost: u32,
    prog: &'a ProviderProgress,
    /// Units this batch's procedure already claimed, so the engine doesn't double-count.
    reported: u32,
    /// Rows this batch's procedure failed, handed back to the caller with the page.
    failed: Vec<u32>,
}

impl EngineHost<'_> {
    /// The declared retry policy, or a single attempt when the provider declares none.
    fn retry_policy(&self) -> (u32, &[u16]) {
        match self.decl.retry.as_ref() {
            Some(r) => (r.attempts, r.on.as_slice()),
            None => (1, &[]),
        }
    }
}

impl ProcHost for EngineHost<'_> {
    fn fetch(&mut self, req: &HttpRequestSpec) -> AppResult<HttpResponse> {
        self.fetch_many(slice::from_ref(req))
            .pop()
            .expect("one request answers once")
    }

    fn fetch_many(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        let (attempts, on) = self.retry_policy();
        let ctx = self.ctx;
        fetch_all(
            ctx.deps,
            self.budget,
            self.rate_cost,
            attempts,
            on,
            &|| ctx.aborted(),
            reqs,
        )
    }

    fn progress(&mut self, units: u32) {
        self.reported += units;
        self.prog.add_done(units);
    }

    fn fail(&mut self, id: u32) {
        self.failed.push(id);
        self.prog.add_failed(1);
    }

    fn aborted(&self) -> bool {
        self.ctx.aborted()
    }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// A query carries no declaration, so its retry policy is fixed.
const QUERY_ATTEMPTS: u32 = 3;
const QUERY_RETRY_ON: [u16; 2] = [429, 503];

/// Host for `query`. Effects are allowed (a query exists to reach a remote API), but
/// there is no run to report into: progress and failures go nowhere. A cancelled query
/// has its requests declined, the same way a cancelled run does.
struct QueryHost<'a> {
    deps: &'a EngineDeps,
    /// A query declares nothing, so it takes the default width.
    budget: FetchBudget,
    aborted: &'a (dyn Fn() -> bool + Sync),
}

impl ProcHost for QueryHost<'_> {
    fn fetch(&mut self, req: &HttpRequestSpec) -> AppResult<HttpResponse> {
        self.fetch_many(slice::from_ref(req))
            .pop()
            .expect("one request answers once")
    }

    fn fetch_many(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        fetch_all(
            self.deps,
            &self.budget,
            1,
            QUERY_ATTEMPTS,
            &QUERY_RETRY_ON,
            self.aborted,
            reqs,
        )
    }

    fn progress(&mut self, _units: u32) {}
    fn fail(&mut self, _id: u32) {}
    fn aborted(&self) -> bool {
        (self.aborted)()
    }
}

/// Load a procedure and run its `query` export over `input`. Read-only: no store, no
/// patches, no progress events.
pub fn run_query(
    deps: &EngineDeps,
    entry: &str,
    input: &str,
    config: Option<String>,
    aborted: &(dyn Fn() -> bool + Sync),
) -> AppResult<String> {
    let mut proc = (deps.factory)(entry)?;
    proc.configure(&configure_json(&[], false, config.as_deref()))?;
    let mut host = QueryHost {
        deps,
        budget: FetchBudget::new(None, None),
        aborted,
    };
    let out = proc.query(input.as_bytes(), &mut host)?;
    String::from_utf8(out).map_err(|_| AppError("query result is not valid utf-8".into()))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start a procedure run. Returns immediately with the run id; the work continues
/// on a background thread and reports through `procedure-progress`.
#[tauri::command]
#[specta::specta]
pub async fn procedure_run(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    providers: Vec<ProviderDecl>,
    force: bool,
) -> AppResult<u32> {
    let map_id = state.lock()?.map_id_for_window(&label.0)?;
    let (run_id, cancel) = register_run()?;
    task::spawn_blocking(move || {
        let Some(app) = crate::app_handle() else {
            log::error!("[procedure] no app handle; run {run_id} aborted");
            unregister_run(run_id);
            return;
        };
        let state: tauri::State<'_, StoreState> = tauri::Manager::state(app);
        let deps = EngineDeps::production();
        let progress: Arc<ProgressSink> =
            Arc::new(Box::new(crate::emit_event::<ProcedureProgress>));
        let results: Arc<ResultSink> = Arc::new(Box::new(crate::emit_event::<ProcedureResult>));
        run_all(
            state.inner(),
            &map_id,
            &providers,
            force,
            run_id,
            &cancel,
            &deps,
            &progress,
            &results,
        );
    });
    Ok(run_id)
}

/// Stop a run before its next batch. Already-applied patches stay applied.
#[tauri::command]
#[specta::specta]
pub async fn procedure_cancel(run_id: u32) -> AppResult<()> {
    if let Some(flag) = runs().lock()?.get(&run_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Cancel flags for queries in flight, keyed by the token the caller chose. A query
/// answers only when it is over, so the caller has to name it up front to cancel it.
fn query_tokens() -> &'static Mutex<HashMap<u32, Arc<AtomicBool>>> {
    static T: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ask a procedure a read-only question. `input` and the result are whatever the
/// module's `query` export agrees with its caller; the engine only carries the bytes.
/// `cancel` is a token the caller may later hand to `procedure_query_cancel`.
#[tauri::command]
#[specta::specta]
pub async fn procedure_query(
    entry: String,
    input: String,
    config: Option<String>,
    cancel: Option<u32>,
) -> AppResult<String> {
    let flag = Arc::new(AtomicBool::new(false));
    if let Some(token) = cancel {
        query_tokens().lock()?.insert(token, flag.clone());
    }
    let out = task::spawn_blocking(move || {
        let deps = EngineDeps::production();
        run_query(&deps, &entry, &input, config, &|| {
            flag.load(Ordering::Relaxed)
        })
    })
    .await;
    if let Some(token) = cancel {
        if let Ok(mut m) = query_tokens().lock() {
            m.remove(&token);
        }
    }
    out?
}

/// Decline every request a query still has to make. The query then answers whatever
/// its module answers for declined requests, which the caller discards.
#[tauri::command]
#[specta::specta]
pub async fn procedure_query_cancel(cancel: u32) -> AppResult<()> {
    if let Some(flag) = query_tokens().lock()?.get(&cancel) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::print_stdout, clippy::print_stderr)]
#[path = "engine.test.rs"]
mod tests;
