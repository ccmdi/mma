//! Generic procedure executor. JS declares providers; this drives their procedures
//! over paged location batches, applies the resulting patches, and reports
//! progress. Nothing here knows what any provider actually computes.

use super::{ProcHost, ProcShape, Procedure, ResultEntry};
use crate::net::fetch::{
    self, Endpoint, HttpRequestSpec, HttpResponse, Policy, RateCost, Session, Transport,
};
use crate::selections::{neighborhood, RowRef, Selector};
use crate::store::engine::{Store, StoreState, Target, WindowLabel};
use crate::sv::pano::{self, PanoAnswer, PanoQuery};
use crate::types::{wire_str_enum, AppError, AppResult, Location};
use mma_algebra::{Edit, Id, Op, Patch, Patchable};
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::mem;
use std::ops::Deref;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tokio::task;

/// Locations materialized per lock acquisition. The engine never holds more than
/// one page of rows in memory per provider.
const PAGE_SIZE: usize = 10_000;
/// Procedure instances one provider may run at once. An instance costs a thread and an
/// interpreter, so this bounds the machine; network width is `inflight`.
const MAX_INSTANCES: u32 = 64;

/// Procedure instances a provider gets. `instances` is for procedures that cannot run beside
/// themselves -- one sidecar process, one large model in memory; everything else takes
/// one per logical CPU and draws its throughput from `inflight` instead.
fn instance_count(decl: &ProviderDecl) -> usize {
    let default = thread::available_parallelism().map_or(4, |n| n.get() as u32);
    decl.instances.unwrap_or(default).clamp(1, MAX_INSTANCES) as usize
}
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

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

wire_str_enum! {
    /// Where a provider's results go. `Patch` applies them to the locations they name;
    /// `Collect` delivers them to the caller and writes nothing. The declaration decides
    /// this, never the contents of a result.
    derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Deserialize, specta::Type)
    pub enum Sink {
        /// Results are written to the locations they name.
        #[default]
        Patch = "patch",
        /// Results are handed back and nothing is written.
        Collect = "collect",
    }
}

/// One provider as declared by the frontend. `fields` are the extra keys it produces
/// and `requires` the keys it consumes; together they gate who waits for whom.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDecl {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(flatten)]
    pub procedure: ProcedureDecl,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[specta(type = Selector<crate::selections::tree::SelectionInput>)]
    pub select: Selector,
    pub batch: BatchMode,
    #[serde(default)]
    pub sink: Sink,
    /// Re-derive this provider's fields even on a run that is not forced. For an
    /// operation whose whole point is to recompute one provider (pinning re-resolves the
    /// panorama) rather than to fill in what is missing.
    #[serde(default)]
    pub force: Option<bool>,
    /// Instances this provider may run at once. Declared only when the procedure
    /// cannot run beside itself; throughput comes from `inflight`.
    #[serde(default)]
    pub instances: Option<u32>,
}

/// A procedure module and the network limits every call to it gets, whether it runs over
/// locations or answers a question.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcedureDecl {
    /// The procedure module: an absolute path, or `res://<rel>` for one bundled with the app.
    pub entry: String,
    #[serde(flatten)]
    pub policy: Policy,
    /// Procedure-specific configuration, a JSON value as text. Passed through verbatim
    /// inside the config object every entry point receives.
    #[serde(default)]
    pub config: Option<String>,
}

impl ProcedureDecl {
    /// Where the procedure's own requests are charged: the module, under the policy it declares.
    fn endpoint(&self) -> Endpoint {
        Endpoint {
            name: self.entry.clone().into(),
            policy: self.policy.clone(),
            idempotent: false,
        }
    }
}

/// What every entry point of a procedure receives as its last argument: the engine's view of
/// the run and the procedure's own configuration.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcedureConfig<T> {
    /// The extra-field keys the run wants written. Empty means every key the procedure produces.
    pub fields: Vec<String>,
    /// Recompute rows that already hold every wanted field.
    pub force: bool,
    /// The procedure's own configuration, or null when none was declared or it did not parse.
    pub config: Option<T>,
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
    pub failed: Vec<Id<Location>>,
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

pub type ProcedureFactory = Box<dyn Fn(&str) -> AppResult<Box<dyn Procedure>> + Send + Sync>;

pub type ProgressSink = Box<dyn Fn(ProcedureProgress) + Send + Sync>;
/// Where a `Collect` provider's pages go. Production emits them; tests record them.
pub type ResultSink = Box<dyn Fn(ProcedureResult) + Send + Sync>;

/// Entries buffered before a partial page goes out.
const PARTIAL_PAGE: usize = 200;
const PARTIAL_INTERVAL: Duration = Duration::from_millis(100);

/// Partial results a query delivers while it is still running, paged and throttled so
/// thousands of single answers become a steady trickle of events.
pub struct Partials {
    run_id: u32,
    provider_id: String,
    sink: ResultSink,
    buf: Mutex<PartialBuf>,
}

struct PartialBuf {
    entries: Vec<ResultEntry>,
    last_flush: Instant,
}

impl Partials {
    pub fn new(run_id: u32, provider_id: String, sink: ResultSink) -> Self {
        Partials {
            run_id,
            provider_id,
            sink,
            buf: Mutex::new(PartialBuf {
                entries: Vec::new(),
                last_flush: Instant::now(),
            }),
        }
    }

    pub fn emit(&self, id: Id<Location>, json: String) {
        let page = {
            let mut buf = self.buf.lock().unwrap_or_else(PoisonError::into_inner);
            buf.entries.push(ResultEntry { id, json });
            if buf.entries.len() < PARTIAL_PAGE && buf.last_flush.elapsed() < PARTIAL_INTERVAL {
                return;
            }
            buf.last_flush = Instant::now();
            mem::take(&mut buf.entries)
        };
        self.deliver(page);
    }

    pub fn flush(&self) {
        let page = {
            let mut buf = self.buf.lock().unwrap_or_else(PoisonError::into_inner);
            buf.last_flush = Instant::now();
            mem::take(&mut buf.entries)
        };
        self.deliver(page);
    }

    fn deliver(&self, entries: Vec<ResultEntry>) {
        if entries.is_empty() {
            return;
        }
        (self.sink)(ProcedureResult {
            run_id: self.run_id,
            provider_id: self.provider_id.clone(),
            entries,
            failed: Vec::new(),
        });
    }
}

/// Everything the engine reaches outside the store. Production wires the QuickJS host
/// and the app's transport; tests inject mocks.
pub struct EngineDeps {
    pub factory: ProcedureFactory,
    pub transport: Arc<Transport>,
}

impl EngineDeps {
    pub fn production() -> Self {
        EngineDeps {
            factory: Box::new(|entry| {
                let proc = super::quickjs::checkout(&resolve_entry(entry)?)?;
                Ok(Box::new(proc) as Box<dyn Procedure>)
            }),
            transport: Transport::production(),
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

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

fn runs() -> &'static Mutex<HashMap<u32, Arc<AtomicBool>>> {
    static R: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_run_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn register_run(run_id: u32) -> AppResult<Arc<AtomicBool>> {
    let cancel = Arc::new(AtomicBool::new(false));
    runs().lock()?.insert(run_id, cancel.clone());
    Ok(cancel)
}

fn unregister_run(run_id: u32) {
    if let Ok(mut m) = runs().lock() {
        m.remove(&run_id);
    }
}

// ---------------------------------------------------------------------------
// Dependency scheduling
// ---------------------------------------------------------------------------

/// Who gates whom: `producers[i]` are the co-running providers that write a field
/// provider `i` requires. Provider `i` starts once every one of them has finished, so a
/// slow provider only ever holds up its own dependents, never the rest of the run.
pub(crate) fn producers(list: &[ProviderDecl]) -> Vec<Vec<usize>> {
    (0..list.len())
        .map(|i| {
            (0..list.len())
                .filter(|&j| {
                    j != i
                        && list[i]
                            .requires
                            .iter()
                            .any(|r| list[j].fields.iter().any(|f| f == r))
                })
                .collect()
        })
        .collect()
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
// Activity
// ---------------------------------------------------------------------------

/// Work the engine has in flight, keyed by an id nothing outside uses. An entry goes in
/// when the work starts and comes out with its guard, so a cancelled or failed piece of
/// work deregisters exactly the way a finished one does.
struct Live<T: 'static> {
    cells: OnceLock<Mutex<HashMap<u32, Arc<T>>>>,
    next: AtomicU32,
}

impl<T: 'static> Live<T> {
    const fn new() -> Self {
        Live {
            cells: OnceLock::new(),
            next: AtomicU32::new(1),
        }
    }

    fn cells(&self) -> &Mutex<HashMap<u32, Arc<T>>> {
        self.cells.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn add(&'static self, cell: T) -> LiveGuard<T> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let cell = Arc::new(cell);
        self.cells()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, cell.clone());
        LiveGuard {
            reg: self,
            id,
            cell,
        }
    }

    fn snapshot(&self) -> Vec<Arc<T>> {
        self.cells()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }
}

struct LiveGuard<T: 'static> {
    reg: &'static Live<T>,
    id: u32,
    cell: Arc<T>,
}

impl<T: 'static> Drop for LiveGuard<T> {
    fn drop(&mut self) {
        self.reg
            .cells()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}

impl<T: 'static> Deref for LiveGuard<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.cell
    }
}

static LIVE_PROVIDERS: Live<ProviderRun> = Live::new();
static LIVE_QUERIES: Live<QueryRun> = Live::new();

/// One provider working its share of a run. Counts come from the progress it already
/// keeps; network state comes from the session every one of its instances draws on.
struct ProviderRun {
    label: Option<String>,
    progress: Arc<ProviderProgress>,
    session: Arc<Session>,
    instances: AtomicU32,
}

impl ProviderRun {
    fn instance(&self) -> InstanceGuard<'_> {
        self.instances.fetch_add(1, Ordering::Relaxed);
        InstanceGuard(self)
    }
}

/// Counts one procedure instance for as long as it is working the queue.
struct InstanceGuard<'a>(&'a ProviderRun);

impl Drop for InstanceGuard<'_> {
    fn drop(&mut self) {
        self.0.instances.fetch_sub(1, Ordering::Relaxed);
    }
}

/// One procedure answering a query.
struct QueryRun {
    entry: String,
    session: Arc<Session>,
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/// The neighbor index a provider has built, and what it was built for. Rebuilt when a
/// call names a different radius or field set, so a procedure that varies either pays
/// a whole-map rescan; asking with the same arguments every row is the intended use.
#[derive(Default)]
pub(crate) struct NeighborCache {
    built: Mutex<Option<BuiltIndex>>,
}

/// An index and the call that built it.
struct BuiltIndex {
    radius_m: f64,
    fields: Vec<String>,
    index: Arc<neighborhood::Index>,
}

pub(crate) struct RunCtx<'a> {
    pub state: &'a StoreState,
    pub map_id: String,
    /// Where the run reads rows and writes results.
    pub target: Target,
    pub run_id: u32,
    pub force: bool,
    pub cancel: Arc<AtomicBool>,
    pub deps: &'a EngineDeps,
    pub progress: Arc<ProgressSink>,
    pub results: Arc<ResultSink>,
    pub neighbors: Arc<NeighborCache>,
    /// The undo entry every provider's pages share, so the whole run undoes as one step.
    pub undo_group: Arc<std::sync::Mutex<Option<u64>>>,
}

impl RunCtx<'_> {
    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> AppResult<T>) -> AppResult<T> {
        let mut mgr = self.state.lock()?;
        f(mgr.store_for_map(&self.map_id)?)
    }

    fn aborted(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// The index for this radius and field set, built over the run's rows the first
    /// time it is asked for and answered from memory after.
    fn neighbor_index(
        &self,
        radius_m: f64,
        fields: &[String],
    ) -> AppResult<Arc<neighborhood::Index>> {
        let mut held = self
            .neighbors
            .built
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(b) = held.as_ref() {
            if b.radius_m == radius_m && b.fields == fields {
                return Ok(b.index.clone());
            }
        }
        log::debug!("[procedure] building neighbor index r={radius_m}m fields={fields:?}");
        let index = self.with_store(|store| {
            let index = match &self.target {
                Target::Map => {
                    let all = store.all();
                    neighborhood::Index::build(all.rows(), radius_m, fields)
                }
                Target::Pending { .. } => {
                    let rows =
                        store.collect(&self.target, &crate::selections::Selector::Everything);
                    neighborhood::Index::build(rows.iter().map(RowRef::from_loc), radius_m, fields)
                }
            };
            Ok(Arc::new(index))
        })?;
        *held = Some(BuiltIndex {
            radius_m,
            fields: fields.to_vec(),
            index: index.clone(),
        });
        Ok(index)
    }
}

/// One procedure call's worth of work.
struct WorkBatch {
    /// Rows handed to the procedure (representatives only under `DedupeBy`).
    rows: Vec<Location>,
    /// Representative id -> every location id that shares its key.
    fanout: Option<HashMap<Id<Location>, Vec<Id<Location>>>>,
    /// Every location id this batch accounts for, sharers included.
    ids: Vec<Id<Location>>,
}

impl WorkBatch {
    /// How many locations this batch accounts for in progress and failure counts.
    fn units(&self) -> u32 {
        self.ids.len() as u32
    }
}

/// Run every provider concurrently, each starting the moment the providers that write
/// its required fields have finished. Blocking throughout: callers put this on a
/// blocking thread.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_all(
    state: &StoreState,
    map_id: &str,
    target: &Target,
    providers: &[ProviderDecl],
    force: bool,
    run_id: u32,
    cancel: &Arc<AtomicBool>,
    deps: &EngineDeps,
    progress: &Arc<ProgressSink>,
    results: &Arc<ResultSink>,
) {
    let gates = producers(providers);
    let undo_group = Arc::new(std::sync::Mutex::new(None));
    let (tx, rx) = mpsc::channel::<usize>();
    let mut pending: Vec<usize> = (0..providers.len()).collect();
    let mut done: Vec<bool> = vec![false; providers.len()];
    let mut running = 0usize;
    thread::scope(|s| {
        let start = |idx: usize, running: &mut usize| {
            let decl = &providers[idx];
            let ctx = RunCtx {
                state,
                map_id: map_id.to_string(),
                target: target.clone(),
                run_id,
                force,
                cancel: cancel.clone(),
                deps,
                progress: progress.clone(),
                results: results.clone(),
                neighbors: Arc::default(),
                undo_group: undo_group.clone(),
            };
            let tx = tx.clone();
            *running += 1;
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
                let _ = tx.send(idx);
            });
        };
        loop {
            if !cancel.load(Ordering::Relaxed) {
                let ready: Vec<usize> = pending
                    .iter()
                    .copied()
                    .filter(|&i| gates[i].iter().all(|&j| done[j]))
                    .collect();
                // A dependency cycle would wait forever; it runs as one block instead.
                let release = if ready.is_empty() && running == 0 {
                    mem::take(&mut pending)
                } else {
                    pending.retain(|i| !ready.contains(i));
                    ready
                };
                for idx in release {
                    start(idx, &mut running);
                }
            }
            if running == 0 {
                break;
            }
            let idx = rx.recv().expect("a worker cannot drop its sender");
            running -= 1;
            done[idx] = true;
        }
    });
    unregister_run(run_id);
}

pub(crate) fn run_provider(ctx: &RunCtx, decl: &ProviderDecl) -> AppResult<()> {
    let ids: Vec<Id<Location>> = ctx.with_store(|store| {
        Ok(store
            .collect(&ctx.target, &decl.select)
            .into_iter()
            .map(|row| row.id)
            .collect())
    })?;
    let total = ids.len() as u32;
    let started = Instant::now();
    log::info!(
        "[procedure] run={} provider='{}' ({}) total={}",
        ctx.run_id,
        decl.id,
        decl.label.as_deref().unwrap_or("-"),
        total
    );
    let prog = Arc::new(ProviderProgress::new(
        ctx.run_id,
        decl.id.clone(),
        total,
        ctx.progress.clone(),
    ));
    prog.start();
    let force = decl.force.unwrap_or(ctx.force);
    let batch_mode = effective_batch_mode(ctx, decl)?;
    // One session for the provider, not one per page or per instance.
    let session = Arc::new(Session::new(ctx.deps.transport.clone(), ctx.cancel.clone()));
    let endpoint = decl.procedure.endpoint();
    let live = LIVE_PROVIDERS.add(ProviderRun {
        label: decl.label.clone(),
        progress: prog.clone(),
        session: session.clone(),
        instances: AtomicU32::new(0),
    });
    let config = config_json(&decl.fields, force, decl.procedure.config.as_deref());
    // No more instances than the run can keep busy: a one-row run must not load a
    // procedure per core.
    let per_instance = rows_per_instance(decl);
    let instances =
        instance_count(decl).min(batch_ceiling(&batch_mode, total, per_instance).max(1));

    // Created before any batch is queued: a full queue with no consumer never drains.
    let mut procs: Vec<Box<dyn Procedure>> = Vec::with_capacity(instances);
    let mut create_err: Option<AppError> = None;
    for _ in 0..instances {
        match (ctx.deps.factory)(&decl.procedure.entry) {
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
            let (batch_rx, session, endpoint, prog, live, config) = (
                &batch_rx,
                &*session,
                &endpoint,
                &prog,
                &live,
                config.as_str(),
            );
            s.spawn(move || {
                let _alive = live.instance();
                run_instance(
                    ctx, decl, session, endpoint, prog, &mut *proc, batch_rx, &out_tx, config,
                )
            });
        }
        let applier = s.spawn(|| apply_pages(ctx, decl, out_rx));

        let mut produced = Ok(());
        for (page, chunk) in ids.chunks(PAGE_SIZE).enumerate() {
            if ctx.aborted() {
                break;
            }
            let batches =
                match page_batches(ctx, decl, chunk, force, &batch_mode, per_instance, &prog) {
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
/// Both gates are selectors, so "has this field" means what a filter means.
fn page_batches(
    ctx: &RunCtx,
    decl: &ProviderDecl,
    page: &[Id<Location>],
    force: bool,
    batch_mode: &BatchMode,
    per_instance: usize,
    prog: &ProviderProgress,
) -> AppResult<Vec<WorkBatch>> {
    let has_every = |fields: &[String]| Selector::all(fields.iter().map(|f| Selector::has(f)));
    let page_sel = Selector::Locations {
        locations: page.to_vec(),
        name: None,
    };
    // A provider with no outputs never skips a row, and `force` re-derives an output but
    // cannot supply a missing input, so only the skip gate lifts.
    let todo = if force || decl.fields.is_empty() {
        page_sel.clone()
    } else {
        Selector::all([page_sel.clone(), has_every(&decl.fields).not()])
    };
    let (rows, unmet) = ctx.with_store(|store| match &ctx.target {
        Target::Map => {
            let alive = store.scope(&page_sel).ids();
            let todo_ids = store.scope(&todo).ids();
            prog.add_skipped((alive.len() - todo_ids.len()) as u32);
            let workable = if decl.requires.is_empty() {
                todo_ids.clone()
            } else {
                store
                    .scope(&Selector::all([todo, has_every(&decl.requires)]))
                    .ids()
            };
            let unmet: Vec<Id<Location>> = page
                .iter()
                .copied()
                .filter(|id| todo_ids.contains(*id) && !workable.contains(*id))
                .collect();
            let rows = store.collect(
                &crate::store::engine::Target::Map,
                &Selector::Locations {
                    locations: page
                        .iter()
                        .copied()
                        .filter(|id| workable.contains(*id))
                        .collect(),
                    name: None,
                },
            );
            Ok((rows, unmet))
        }
        Target::Pending { .. } => {
            let has = |row: &Location, f: &str| RowRef::from_loc(row).resolve_field(f).is_some();
            let (mut rows, mut unmet, mut skipped) = (Vec::new(), Vec::new(), 0);
            for row in store.collect(
                &ctx.target,
                &crate::selections::Selector::Locations {
                    locations: (page).to_vec(),
                    name: None,
                },
            ) {
                let todo =
                    force || decl.fields.is_empty() || !decl.fields.iter().all(|f| has(&row, f));
                if !todo {
                    skipped += 1;
                } else if decl.requires.iter().all(|f| has(&row, f)) {
                    rows.push(row);
                } else {
                    unmet.push(row.id);
                }
            }
            prog.add_skipped(skipped);
            Ok((rows, unmet))
        }
    })?;
    if !unmet.is_empty() {
        prog.add_failed(unmet.len() as u32);
        prog.add_done(unmet.len() as u32);
        deliver_page(
            ctx,
            decl,
            PageOutput {
                failed: unmet,
                ..PageOutput::default()
            },
        )?;
    }

    if rows.is_empty() {
        return Ok(Vec::new());
    }
    split_batches(batch_mode, rows, per_instance)
}

/// An upper bound on how many batches `total` rows can become, before skipping. Batches
/// are cut per page, so a chunk larger than a page still yields one batch per page.
fn batch_ceiling(mode: &BatchMode, total: u32, per_instance: usize) -> usize {
    let total = total as usize;
    let pages = total.div_ceil(PAGE_SIZE);
    match mode {
        BatchMode::PerRow => total,
        BatchMode::Chunk { size } => total.min(PAGE_SIZE).div_ceil((*size).max(1) as usize) * pages,
        BatchMode::DedupeBy { .. } => total.min(PAGE_SIZE).div_ceil(per_instance.max(1)) * pages,
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
        failed: Vec<Id<Location>>,
    },
}

/// Write one page: patches to the store, answers and failed ids to the caller.
fn deliver_page(ctx: &RunCtx, decl: &ProviderDecl, page: PageOutput) -> AppResult<()> {
    let mut entries = page.entries;
    if !page.updates.is_empty() {
        let ids: Vec<Id<Location>> = page.updates.iter().map(|(_, u)| u.id).collect();
        let held_rows = ctx.with_store(|store| {
            let edits = page
                .updates
                .iter()
                .map(|(read, patch)| {
                    let patch = match (
                        read,
                        store
                            .collect(
                                &ctx.target,
                                &crate::selections::Selector::Locations {
                                    locations: vec![patch.id],
                                    name: None,
                                },
                            )
                            .into_iter()
                            .next(),
                    ) {
                        (Some(read), Some(now)) => {
                            store.retain_valid_outputs(patch.clone(), read, &now)
                        }
                        _ => patch.clone(),
                    };
                    Op::Put(patch)
                })
                .collect();
            let mut group = ctx
                .undo_group
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            // Pending edits emit no map change event, so stream the updated rows to the caller.
            let held = match &ctx.target {
                Target::Pending { name } => {
                    store.pending.get(name).is_none_or(|p| p.landed.is_none())
                }
                Target::Map => false,
            };
            store.edit(&ctx.target, edits, false, &mut group);
            Ok(held.then(|| {
                store.collect(
                    &ctx.target,
                    &crate::selections::Selector::Locations {
                        locations: (&ids).to_vec(),
                        name: None,
                    },
                )
            }))
        })?;
        if let Some(rows) = held_rows {
            for row in rows {
                entries.push(ResultEntry {
                    id: row.id,
                    json: serde_json::to_string(&row).map_err(|e| AppError(e.to_string()))?,
                });
            }
        }
    }
    if !entries.is_empty() || !page.failed.is_empty() {
        (ctx.results)(ProcedureResult {
            run_id: ctx.run_id,
            provider_id: decl.id.clone(),
            entries,
            failed: page.failed,
        });
    }
    Ok(())
}

/// Deliver results as each page completes. On cancellation, keep completed batches
/// from partially finished pages too.
// Own the receiver so it can move into the applier thread.
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

/// A chunk only carries meaning when it becomes one request. For a map procedure
/// the declared size is just a ceiling, so a page is cut finely enough to occupy
/// every instance instead of handing one instance the whole page.
fn effective_batch_mode(ctx: &RunCtx, decl: &ProviderDecl) -> AppResult<BatchMode> {
    let BatchMode::Chunk { size } = &decl.batch else {
        return Ok(decl.batch.clone());
    };
    if (ctx.deps.factory)(&decl.procedure.entry)?.shape() != ProcShape::Map {
        return Ok(decl.batch.clone());
    }
    Ok(BatchMode::Chunk {
        size: (*size).min(rows_per_instance(decl) as u32).max(1),
    })
}

fn rows_per_instance(decl: &ProviderDecl) -> usize {
    PAGE_SIZE.div_ceil(instance_count(decl))
}

fn split_batches(
    mode: &BatchMode,
    rows: Vec<Location>,
    per_instance: usize,
) -> AppResult<Vec<WorkBatch>> {
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
            let mut order: Vec<String> = Vec::new();
            let mut groups: HashMap<String, Vec<Id<Location>>> = HashMap::new();
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
            let mut members: HashMap<Id<Location>, Vec<Id<Location>>> = reps
                .iter()
                .zip(order)
                .map(|(rep, k)| (rep.id, groups.remove(&k).unwrap()))
                .collect();
            let mut reps = reps.into_iter();
            let mut batches = Vec::new();
            loop {
                let rows: Vec<Location> = reps.by_ref().take(per_instance.max(1)).collect();
                if rows.is_empty() {
                    break;
                }
                let fanout: HashMap<Id<Location>, Vec<Id<Location>>> = rows
                    .iter()
                    .map(|r| (r.id, members.remove(&r.id).unwrap()))
                    .collect();
                let ids = rows
                    .iter()
                    .flat_map(|r| fanout[&r.id].iter().copied())
                    .collect();
                batches.push(WorkBatch {
                    rows,
                    fanout: Some(fanout),
                    ids,
                });
            }
            Ok(batches)
        }
    }
}

/// The [`ProcedureConfig`] a run hands its procedure, with the declared config spliced in
/// verbatim. Unparseable config reads as null rather than failing the run.
fn config_json(fields: &[String], force: bool, config: Option<&str>) -> String {
    let config = config.and_then(|s| serde_json::from_str::<Box<RawValue>>(s).ok());
    serde_json::to_string(&ProcedureConfig {
        fields: fields.to_vec(),
        force,
        config,
    })
    .expect("a procedure config serializes")
}

/// What one page produced. Which of the first two is filled follows from the declared
/// sink: a `Patch` provider yields store updates, a `Collect` provider yields answers.
#[derive(Default)]
struct PageOutput {
    /// Patches paired with the rows they were computed from, so delivery can discard stale fields.
    updates: Vec<(Option<Location>, Patch<Location>)>,
    entries: Vec<ResultEntry>,
    /// Rows the procedure failed, plus every row of a batch whose call failed.
    failed: Vec<Id<Location>>,
}

/// One procedure instance, working the queue until it closes or the run is cancelled.
#[allow(clippy::too_many_arguments)]
fn run_instance(
    ctx: &RunCtx,
    decl: &ProviderDecl,
    session: &Session,
    endpoint: &Endpoint,
    prog: &ProviderProgress,
    proc: &mut dyn Procedure,
    batches: &Mutex<mpsc::Receiver<Tagged>>,
    out: &mpsc::Sender<Produced>,
    config: &str,
) {
    loop {
        let next = batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .recv();
        let Ok(Tagged { page, batch }) = next else {
            return;
        };
        // A cancelled instance keeps draining: the queue is bounded, and a pager blocked
        // on a full one would never close it, so the applied batches would never land.
        if ctx.aborted() {
            continue;
        }
        let mut host = EngineHost {
            ctx,
            fanout: batch.fanout.as_ref(),
            session,
            endpoint,
            rate_cost: match decl.procedure.policy.rate.map(|r| r.cost) {
                Some(RateCost::Row) => batch.rows.len() as u32,
                _ => 1,
            },
            prog,
            reported: 0,
            failed: Vec::new(),
        };
        let result = run_batch(proc, &batch, &mut host, config)
            .map(|entries| fan_out(entries, batch.fanout.as_ref()))
            .and_then(|entries| match decl.sink {
                // Only the patch sink parses: a collected answer is the module's
                // contract with its caller, not a Patch<Location>.
                Sink::Patch => to_patches(&entries).map(|patches| {
                    let read: HashMap<Id<Location>, &Location> =
                        batch.rows.iter().map(|r| (r.id, r)).collect();
                    BatchProduct::Patches(
                        patches
                            .into_iter()
                            .map(|p| (read.get(&p.id).map(|r| (*r).clone()), p))
                            .collect(),
                    )
                }),
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
    Patches(Vec<(Option<Location>, Patch<Location>)>),
    Entries(Vec<ResultEntry>),
}

fn run_batch(
    proc: &mut dyn Procedure,
    batch: &WorkBatch,
    host: &mut EngineHost,
    config: &str,
) -> AppResult<Vec<ResultEntry>> {
    let blob = serde_json::to_vec(&batch.rows)
        .map_err(|e| AppError(format!("batch could not be serialized: {e}")))?;
    match proc.shape() {
        ProcShape::Map => proc.map(&blob, host, config),
        ProcShape::Run => proc.run(&blob, host, config),
    }
}

/// Whether a location patch can write `key`. A patch entry carrying anything else fails its
/// batch rather than being silently ignored.
fn writable(key: &str) -> bool {
    <Location as Patchable>::WRITES
        .iter()
        .any(|(k, _)| *k == key)
}

/// Repeat a deduped representative's answer for every row it stood for. Without a
/// fanout map the entries already name their own rows and pass through untouched.
fn fan_out(
    entries: Vec<ResultEntry>,
    fanout: Option<&HashMap<Id<Location>, Vec<Id<Location>>>>,
) -> Vec<ResultEntry> {
    let Some(fanout) = fanout else {
        return entries;
    };
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        match fanout.get(&e.id) {
            Some(ids) => out.extend(ids.iter().map(|&id| ResultEntry {
                id,
                json: e.json.clone(),
            })),
            None => out.push(e),
        }
    }
    out
}

/// Each answer as the patch it writes. A field a patch cannot write fails the batch.
fn to_patches(entries: &[ResultEntry]) -> AppResult<Vec<Patch<Location>>> {
    entries
        .iter()
        .map(|e| {
            let err = |msg: String| AppError(format!("patch for location {}: {msg}", e.id));
            let mut map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&e.json).map_err(|x| err(x.to_string()))?;
            if let Some(key) = map.keys().find(|k| !writable(k)) {
                return Err(err(format!("unknown field `{key}`")));
            }
            map.insert("id".into(), e.id.get().into());
            serde_json::from_value(map.into()).map_err(|x| err(x.to_string()))
        })
        .collect()
}

struct EngineHost<'a> {
    ctx: &'a RunCtx<'a>,
    /// Under `DedupeBy`, representative id -> every id sharing its key; a failure of the
    /// representative is every sharer's failure, as its answer would have been theirs.
    fanout: Option<&'a HashMap<Id<Location>, Vec<Id<Location>>>>,
    /// The provider's, not this instance's: every instance shares one session.
    session: &'a Session,
    endpoint: &'a Endpoint,
    /// Tokens one fetch attempt charges, per the declared `RateCost`.
    rate_cost: u32,
    prog: &'a ProviderProgress,
    /// Units this batch's procedure already claimed, so the engine doesn't double-count.
    reported: u32,
    /// Rows this batch's procedure failed, handed back to the caller with the page.
    failed: Vec<Id<Location>>,
}

impl ProcHost for EngineHost<'_> {
    fn fetch(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        self.session.fetch(self.endpoint, self.rate_cost, reqs)
    }

    fn panos(&mut self, queries: &[PanoQuery]) -> Vec<PanoAnswer> {
        pano::resolve_panos(self.session, queries, &mut |_, _| {})
    }

    fn neighbors(
        &mut self,
        lat: f64,
        lng: f64,
        radius_m: f64,
        fields: &[String],
    ) -> AppResult<String> {
        let index = self.ctx.neighbor_index(radius_m, fields)?;
        serde_json::to_string(&index.within(lat, lng)).map_err(|e| AppError(e.to_string()))
    }

    fn progress(&mut self, units: u32) {
        self.reported += units;
        self.prog.add_done(units);
    }

    fn fail(&mut self, id: Id<Location>) {
        match self.fanout.and_then(|f| f.get(&id)) {
            Some(ids) => {
                self.failed.extend(ids);
                self.prog.add_failed(ids.len() as u32);
            }
            None => {
                self.failed.push(id);
                self.prog.add_failed(1);
            }
        }
    }

    fn aborted(&self) -> bool {
        self.ctx.aborted()
    }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/// Host for `query`. Effects are allowed (a query exists to reach a remote API), but
/// there is no run to report into: progress and failures go nowhere. A cancelled query
/// has its requests declined, the same way a cancelled run does.
struct QueryHost {
    session: Arc<Session>,
    endpoint: Endpoint,
    partials: Option<Arc<Partials>>,
}

impl ProcHost for QueryHost {
    fn fetch(&mut self, reqs: &[HttpRequestSpec]) -> Vec<AppResult<HttpResponse>> {
        self.session.fetch(&self.endpoint, 1, reqs)
    }

    /// Stream each pano answer as it arrives, keyed by query index.
    fn panos(&mut self, queries: &[PanoQuery]) -> Vec<PanoAnswer> {
        let partials = self.partials.as_deref();
        pano::resolve_panos(&self.session, queries, &mut |i, answer| {
            if let (Some(p), Ok(json)) = (partials, serde_json::to_string(answer)) {
                p.emit(Id::new(i as u32), json);
            }
        })
    }

    fn emitter(&self) -> Option<Arc<Partials>> {
        self.partials.clone()
    }

    fn progress(&mut self, _units: u32) {}
    fn fail(&mut self, _id: Id<Location>) {}
    fn aborted(&self) -> bool {
        self.session.aborted()
    }
}

/// Load a procedure and run its `query` export over `input`. Read-only: no store and no
/// patches. With `partials`, whatever the procedure or its host calls emit streams out
/// in pages while the query runs; the last page flushes before the answer returns.
pub fn run_query(
    deps: &EngineDeps,
    decl: &ProcedureDecl,
    input: &str,
    cancel: Arc<AtomicBool>,
    partials: Option<Arc<Partials>>,
) -> AppResult<String> {
    let mut proc = (deps.factory)(&decl.entry)?;
    let config = config_json(&[], false, decl.config.as_deref());
    let session = Arc::new(Session::new(deps.transport.clone(), cancel));
    let _live = LIVE_QUERIES.add(QueryRun {
        entry: decl.entry.clone(),
        session: session.clone(),
    });
    let mut host = QueryHost {
        session,
        endpoint: decl.endpoint(),
        partials: partials.clone(),
    };
    let out = proc.query(input.as_bytes(), &mut host, &config);
    if let Some(p) = &partials {
        p.flush();
    }
    String::from_utf8(out?).map_err(|_| AppError("query result is not valid utf-8".into()))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start a procedure run over the open map's locations. Returns immediately with
/// the run id. Emits `procedure-progress` and `procedure-result` as work completes.
#[tauri::command]
#[specta::specta]
pub async fn procedure_run(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    providers: Vec<ProviderDecl>,
    force: bool,
    target: Option<Target>,
) -> AppResult<u32> {
    let map_id = state.lock()?.map_id_for_window(&label.0)?;
    let run_id = next_run_id();
    let cancel = register_run(run_id)?;
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
        let target = target.unwrap_or(Target::Map);
        run_all(
            state.inner(),
            &map_id,
            &target,
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

/// Reserve a run id up front, for a query or row run that answers only when it is over:
/// its streamed results carry the id, and `procedureCancel` stops it.
#[tauri::command]
#[specta::specta]
pub async fn procedure_reserve_run() -> u32 {
    next_run_id()
}

/// Partial pages leave through their own thread: a delivery that blocks must never
/// stall the loop that is issuing requests and collecting answers.
fn partial_emitter() -> &'static mpsc::Sender<ProcedureResult> {
    static TX: OnceLock<mpsc::Sender<ProcedureResult>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<ProcedureResult>();
        thread::spawn(move || {
            for page in rx {
                let started = Instant::now();
                crate::emit_event(page);
                let ms = started.elapsed().as_millis();
                if ms > 200 {
                    log::debug!("[procedure] partial emit took {ms}ms");
                }
            }
        });
        tx
    })
}

/// Run a procedure's read-only `query` export. `input` and the result are defined
/// by the procedure module. A `runId` from `procedureReserveRun` streams partial results
/// under it and lets `procedureCancel` stop the query.
#[tauri::command]
#[specta::specta]
pub async fn procedure_query(
    procedure: ProcedureDecl,
    input: String,
    run_id: Option<u32>,
) -> AppResult<String> {
    let flag = match run_id {
        Some(id) => register_run(id)?,
        None => Arc::new(AtomicBool::new(false)),
    };
    let out = task::spawn_blocking(move || {
        let deps = EngineDeps::production();
        let partials = run_id.map(|id| {
            Arc::new(Partials::new(
                id,
                procedure.entry.clone(),
                Box::new(|page| {
                    let _ = partial_emitter().send(page);
                }),
            ))
        });
        run_query(&deps, &procedure, &input, flag, partials)
    })
    .await;
    if let Some(id) = run_id {
        unregister_run(id);
    }
    out?
}

/// Everything the procedure engine has in flight at one instant.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProcedureActivity {
    /// The providers working right now.
    pub runs: Vec<ProviderActivity>,
    /// The procedures answering a question right now.
    pub queries: Vec<QueryActivity>,
    /// Requests answered per second over the last few seconds, across everything running.
    pub requests_per_second: f64,
}

/// One provider working its share of a run.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActivity {
    /// The run this provider belongs to.
    pub run_id: u32,
    /// The provider's id.
    pub provider_id: String,
    /// The provider's display name, where it has one.
    pub label: Option<String>,
    /// Locations the provider was handed.
    pub total: u32,
    /// Locations it has finished.
    pub done: u32,
    /// Locations it could not work.
    pub failed: u32,
    /// Locations that already held everything it produces.
    pub skipped: u32,
    /// Copies of the procedure working its queue.
    pub instances: u32,
    /// Requests outstanding at this instant.
    pub inflight: u32,
    /// The most requests the provider may keep outstanding.
    pub inflight_limit: u32,
    /// Requests parked until the provider's rate limit lets them through.
    pub rate_waiting: u32,
    /// Requests retried so far in this run.
    pub retries: u32,
}

/// The questions one procedure is answering, taken together.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryActivity {
    /// The procedure answering.
    pub entry: String,
    /// Requests outstanding at this instant.
    pub inflight: u32,
    /// The most requests it may keep outstanding.
    pub inflight_limit: u32,
    /// Requests retried so far by the queries in flight.
    pub retries: u32,
}

/// What the procedure engine is working on right now.
#[tauri::command]
#[specta::specta]
pub fn procedure_activity() -> ProcedureActivity {
    let runs = LIVE_PROVIDERS
        .snapshot()
        .iter()
        .map(|r| {
            let net = r.session.usage();
            ProviderActivity {
                run_id: r.progress.run_id,
                provider_id: r.progress.provider_id.clone(),
                label: r.label.clone(),
                total: r.progress.total,
                done: r.progress.done.load(Ordering::Relaxed),
                failed: r.progress.failed.load(Ordering::Relaxed),
                skipped: r.progress.skipped.load(Ordering::Relaxed),
                instances: r.instances.load(Ordering::Relaxed),
                inflight: net.inflight,
                inflight_limit: net.inflight_limit,
                rate_waiting: net.rate_waiting,
                retries: net.retries,
            }
        })
        .collect();
    let mut queries: Vec<QueryActivity> = Vec::new();
    for q in LIVE_QUERIES.snapshot() {
        let net = q.session.usage();
        match queries.iter_mut().find(|a| a.entry == q.entry) {
            Some(a) => {
                a.inflight += net.inflight;
                a.inflight_limit += net.inflight_limit;
                a.retries += net.retries;
            }
            None => queries.push(QueryActivity {
                entry: q.entry.clone(),
                inflight: net.inflight,
                inflight_limit: net.inflight_limit,
                retries: net.retries,
            }),
        }
    }
    ProcedureActivity {
        runs,
        queries,
        requests_per_second: fetch::requests_per_second(),
    }
}

#[cfg(test)]
#[allow(clippy::print_stdout, clippy::print_stderr)]
#[path = "engine.test.rs"]
mod tests;
