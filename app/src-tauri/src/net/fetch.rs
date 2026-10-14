//! Requests sent at volume. An [`Endpoint`] declares how hard it may be pushed, a
//! [`Session`] is one caller's share of every endpoint it reaches, and the [`Transport`]
//! carries the requests.

use std::borrow::Cow;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use futures::executor;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::runtime::{Builder, Runtime};
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio::time;

use crate::types::wire_str_enum;
use crate::types::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct HttpRequestSpec {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// What a request declined by a cancelled session answers with.
pub const CANCELLED: &str = "request cancelled";

/// Requests one caller keeps in flight to an endpoint that declares no `inflight`.
pub(crate) const DEFAULT_INFLIGHT: u32 = 48;
/// Ceiling on a declared `inflight`. These are futures, not threads, so it bounds what
/// the remote endpoint sees rather than what the machine can hold.
const MAX_INFLIGHT: u32 = 1024;
/// Ceiling on a declared retry policy's total tries per request.
const MAX_ATTEMPTS: u32 = 8;
/// Tries a request gets when its endpoint declares no retry policy.
const DEFAULT_ATTEMPTS: u32 = 3;
const DEFAULT_BACKOFF: Duration = Duration::from_secs(2);

/// The statuses a request is worth re-sending on: the endpoint is overloaded or wedged
/// rather than answering the request it was given. Google's frontend sheds a burst with
/// 502 as readily as with 429, so a list that omits it drops rows a second try would
/// have resolved.
pub const TRANSIENT_STATUSES: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];

wire_str_enum! {
    /// What one attempt charges the bucket: the call itself, or one per row in its batch
    /// (for APIs that bill multi-row requests per row).
    derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Deserialize, specta::Type)
    pub enum RateCost {
        /// Each attempt charges the rate limit once, however many rows it carries.
        #[default]
        Request = "request",
        /// Each attempt charges the rate limit once per row it carries; a query carries no rows and charges once.
        Row = "row",
    }
}

/// Rate limit: `units` calls per `perMs` milliseconds, refilled continuously.
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

/// How hard one caller may push an endpoint.
#[derive(Clone, Default, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(default)]
    pub rate: Option<RateSpec>,
    #[serde(default)]
    pub retry: Option<RetrySpec>,
    /// Requests one run or one query may have in flight at once. A run's instances share
    /// the budget; a separate run or query gets its own.
    #[serde(default)]
    pub inflight: Option<u32>,
}

/// A remote service as its callers reach it: a name, and the policy every request to it obeys.
pub struct Endpoint {
    pub name: Cow<'static, str>,
    pub policy: Policy,
    /// Every request to it only reads, so one lost in transit (a timeout, a reset
    /// connection) is sent again under the retry policy, as a retried status is.
    pub idempotent: bool,
}

/// One request, in flight. Async because width is counted in requests and not in
/// threads: hundreds of these can be pending on the http runtime at once.
pub type FetchFuture = Pin<Box<dyn Future<Output = AppResult<HttpResponse>> + Send>>;
pub type SendFn = Box<dyn Fn(HttpRequestSpec) -> FetchFuture + Send + Sync>;

/// How a request leaves the machine. Production sends over the shared connection pool;
/// tests answer in place.
pub struct Transport {
    pub send: SendFn,
    /// First retry delay; doubles per attempt. Tests shrink it to keep runs fast.
    pub backoff: Duration,
}

impl Transport {
    pub fn production() -> Arc<Transport> {
        static T: OnceLock<Arc<Transport>> = OnceLock::new();
        T.get_or_init(|| {
            let send: SendFn = Box::new(|req| Box::pin(http_fetch(req)));
            #[cfg(feature = "e2e")]
            let send = crate::e2e::stub_origin(send);
            Arc::new(Transport {
                send,
                backoff: DEFAULT_BACKOFF,
            })
        })
        .clone()
    }
}

/// Connections the client spreads requests over. Google caps concurrent streams per
/// HTTP/2 connection (~100), so one connection silently throttles a wide `inflight`;
/// each client holds its own connection and requests deal round-robin.
const HTTP_CONNECTIONS: usize = 8;

fn http_client() -> &'static reqwest::Client {
    static POOL: OnceLock<Vec<reqwest::Client>> = OnceLock::new();
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let pool = POOL.get_or_init(|| {
        (0..HTTP_CONNECTIONS)
            .map(|_| {
                reqwest::Client::builder()
                    .use_rustls_tls()
                    .timeout(Duration::from_secs(30))
                    .build()
                    .expect("failed to build the http client")
            })
            .collect()
    });
    &pool[NEXT.fetch_add(1, Ordering::Relaxed) % pool.len()]
}

async fn http_fetch(req: HttpRequestSpec) -> AppResult<HttpResponse> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| AppError(format!("bad method '{}': {e}", req.method)))?;
    let mut rb = http_client().request(method, req.url.as_str());
    for (k, v) in &req.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }
    if let Some(body) = &req.body {
        rb = rb.body(body.clone());
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| AppError(format!("request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .bytes()
        .await
        .map_err(|e| AppError(format!("body read failed: {e}")))?
        .to_vec();
    Ok(HttpResponse { status, body })
}

/// The runtime every request runs on. Requests are futures here, not threads, which is
/// what lets `inflight` be hundreds while the caller's own threads stay few.
fn http_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("net-http")
            .build()
            .expect("failed to build the http runtime")
    })
}

/// Drive `f` on the calling thread with the http runtime entered, so the requests and
/// timers inside it reach that runtime's driver. Entering rather than `Runtime::block_on`
/// keeps this callable from a thread that is already inside a runtime.
fn drive<T>(f: impl Future<Output = T>) -> T {
    let _entered = http_runtime().enter();
    executor::block_on(f)
}

const ABORT_POLL: Duration = Duration::from_millis(50);

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

    /// Waits until `cost` tokens are available, or returns false once `aborted`. Sleeps
    /// outside the lock so waiters queue, in steps short enough that a cancel lands fast.
    /// A cost above capacity is clamped, otherwise it could never be paid.
    async fn acquire(&self, cost: u32, aborted: &(dyn Fn() -> bool + Sync)) -> bool {
        let want = (cost.max(1) as f64).min(self.capacity);
        loop {
            if aborted() {
                return false;
            }
            let wait = {
                let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                let now = Instant::now();
                let elapsed_ms = now.duration_since(st.1).as_secs_f64() * 1000.0;
                st.0 = (st.0 + elapsed_ms * self.per_ms).min(self.capacity);
                st.1 = now;
                if st.0 >= want {
                    st.0 -= want;
                    return true;
                }
                Duration::from_secs_f64((want - st.0) / self.per_ms / 1000.0)
            };
            time::sleep(wait.clamp(Duration::from_micros(200), ABORT_POLL)).await;
        }
    }
}

/// One endpoint's share of a session: how many requests may be in flight at once, how
/// fast they may be issued, and which answers are sent again. The counters are atomics
/// only, so a diagnostics reader costs the request path nothing.
struct Lane {
    name: Cow<'static, str>,
    width: u32,
    slots: Semaphore,
    limiter: Option<RateLimiter>,
    attempts: u32,
    retry_on: Vec<u16>,
    retry_transport: bool,
    outstanding: AtomicU32,
    rate_waiting: AtomicU32,
    retries: AtomicU32,
}

/// A slot held for the length of one request. Dropping it frees the slot and clears the
/// request from the outstanding count together, so an early return cannot leak either.
struct Admitted<'a> {
    _slot: SemaphorePermit<'a>,
    lane: &'a Lane,
}

impl Drop for Admitted<'_> {
    fn drop(&mut self) {
        self.lane.outstanding.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Lane {
    fn new(endpoint: &Endpoint) -> Self {
        let policy = &endpoint.policy;
        let width = policy
            .inflight
            .unwrap_or(DEFAULT_INFLIGHT)
            .clamp(1, MAX_INFLIGHT);
        let (attempts, retry_on) = match &policy.retry {
            Some(r) => (r.attempts, r.on.clone()),
            None => (DEFAULT_ATTEMPTS, TRANSIENT_STATUSES.to_vec()),
        };
        Lane {
            name: endpoint.name.clone(),
            width,
            slots: Semaphore::new(width as usize),
            limiter: policy.rate.and_then(RateLimiter::new),
            attempts: attempts.clamp(1, MAX_ATTEMPTS),
            retry_on,
            retry_transport: endpoint.idempotent,
            outstanding: AtomicU32::new(0),
            rate_waiting: AtomicU32::new(0),
            retries: AtomicU32::new(0),
        }
    }

    /// Waits for the rate bucket, then for a slot, or answers `None` once `aborted`. The
    /// slot is held until the response lands, so `inflight` counts requests actually
    /// outstanding.
    async fn admit(&self, cost: u32, aborted: &(dyn Fn() -> bool + Sync)) -> Option<Admitted<'_>> {
        if let Some(l) = &self.limiter {
            self.rate_waiting.fetch_add(1, Ordering::Relaxed);
            let paid = l.acquire(cost, aborted).await;
            self.rate_waiting.fetch_sub(1, Ordering::Relaxed);
            if !paid {
                return None;
            }
        }
        let slot = self
            .slots
            .acquire()
            .await
            .expect("the lane semaphore is never closed");
        self.outstanding.fetch_add(1, Ordering::Relaxed);
        Some(Admitted {
            _slot: slot,
            lane: self,
        })
    }
}

/// One caller's share of the network. Every endpoint it reaches gets a lane of its own,
/// opened on first use and held for the session's life, and one cancel declines them
/// all. Separate sessions never wait on each other.
pub struct Session {
    transport: Arc<Transport>,
    cancel: Arc<AtomicBool>,
    lanes: Mutex<Vec<Arc<Lane>>>,
}

/// What a session is passing at one instant, across every lane it has opened.
#[derive(Default)]
pub struct Usage {
    pub inflight: u32,
    pub inflight_limit: u32,
    pub rate_waiting: u32,
    pub retries: u32,
}

impl Session {
    pub fn new(transport: Arc<Transport>, cancel: Arc<AtomicBool>) -> Self {
        Session {
            transport,
            cancel,
            lanes: Mutex::new(Vec::new()),
        }
    }

    pub fn aborted(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn lane(&self, endpoint: &Endpoint) -> Arc<Lane> {
        let mut lanes = self.lanes.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(lane) = lanes.iter().find(|l| l.name == endpoint.name) {
            return lane.clone();
        }
        let lane = Arc::new(Lane::new(endpoint));
        lanes.push(lane.clone());
        lane
    }

    /// Every request at once, as wide as `endpoint` allows, each answer handed over the
    /// moment it lands, in completion order. `cost` is what one attempt charges the
    /// endpoint's rate limit. A request that fails answers with its own error: one bad
    /// request does not lose the others.
    pub fn fetch_stream(
        &self,
        endpoint: &Endpoint,
        cost: u32,
        reqs: &[HttpRequestSpec],
        on_each: &mut dyn FnMut(usize, AppResult<HttpResponse>),
    ) {
        let lane = self.lane(endpoint);
        drive(async {
            let mut pending: FuturesUnordered<_> = reqs
                .iter()
                .enumerate()
                .map(|(i, req)| {
                    let lane = &lane;
                    async move { (i, self.fetch_one(lane, cost, req).await) }
                })
                .collect();
            while let Some((i, result)) = pending.next().await {
                on_each(i, result);
            }
        });
    }

    /// [`Session::fetch_stream`], answered in request order once everything is done.
    pub fn fetch(
        &self,
        endpoint: &Endpoint,
        cost: u32,
        reqs: &[HttpRequestSpec],
    ) -> Vec<AppResult<HttpResponse>> {
        let mut out: Vec<Option<AppResult<HttpResponse>>> = reqs.iter().map(|_| None).collect();
        self.fetch_stream(endpoint, cost, reqs, &mut |i, r| out[i] = Some(r));
        out.into_iter()
            .map(|r| r.expect("every request answers exactly once"))
            .collect()
    }

    pub fn usage(&self) -> Usage {
        let lanes = self.lanes.lock().unwrap_or_else(PoisonError::into_inner);
        lanes.iter().fold(Usage::default(), |u, l| Usage {
            inflight: u.inflight + l.outstanding.load(Ordering::Relaxed),
            inflight_limit: u.inflight_limit + l.width,
            rate_waiting: u.rate_waiting + l.rate_waiting.load(Ordering::Relaxed),
            retries: u.retries + l.retries.load(Ordering::Relaxed),
        })
    }

    /// One request under its lane's retry policy, sleeping the transport's backoff and
    /// doubling between retried statuses (and, for an idempotent endpoint, between failed
    /// sends). The lane is paid per attempt.
    async fn fetch_one(
        &self,
        lane: &Lane,
        cost: u32,
        req: &HttpRequestSpec,
    ) -> AppResult<HttpResponse> {
        let aborted = || self.aborted();
        let mut delay = self.transport.backoff;
        for attempt in 0..lane.attempts {
            let answered = {
                let Some(_slot) = lane.admit(cost, &aborted).await else {
                    return Err(AppError(CANCELLED.into()));
                };
                // Checked holding the slot: a request that waited behind a long backlog must
                // not be sent once the session is cancelled.
                if aborted() {
                    return Err(AppError(CANCELLED.into()));
                }
                let answered = (self.transport.send)(req.clone()).await;
                record_fetch();
                answered
            };
            let last = attempt + 1 == lane.attempts;
            let why = match answered {
                Ok(resp) if last || !lane.retry_on.contains(&resp.status) => return Ok(resp),
                Err(e) if last || !lane.retry_transport => return Err(e),
                Ok(resp) => format!("answered {}", resp.status),
                Err(e) => format!("failed ({e})"),
            };
            log::debug!(
                "[net] {} {why} on attempt {}, backing off {:?}",
                lane.name,
                attempt + 1,
                delay
            );
            lane.retries.fetch_add(1, Ordering::Relaxed);
            if !self.back_off(delay).await {
                return Err(AppError(CANCELLED.into()));
            }
            delay = delay.saturating_mul(2);
        }
        unreachable!("attempts is at least 1")
    }

    /// Sleep out `delay` in steps short enough that a cancel lands fast. False once cancelled.
    async fn back_off(&self, delay: Duration) -> bool {
        let until = Instant::now() + delay;
        loop {
            if self.aborted() {
                return false;
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return true;
            }
            time::sleep(left.min(ABORT_POLL)).await;
        }
    }
}

/// Seconds of answered requests the rate averages over.
const RATE_WINDOW_SECS: u64 = 5;

/// One second of answered requests, stamped with the second it counts, so a bucket the
/// ring has lapped reads as empty instead of as old traffic.
struct RateBucket {
    second: AtomicU64,
    hits: AtomicU32,
}

impl RateBucket {
    const fn new() -> Self {
        RateBucket {
            second: AtomicU64::new(u64::MAX),
            hits: AtomicU32::new(0),
        }
    }
}

/// A bucket wider than the window, so the second still filling never evicts the oldest
/// second the average still wants.
static RATE: [RateBucket; RATE_WINDOW_SECS as usize + 1] =
    [const { RateBucket::new() }; RATE_WINDOW_SECS as usize + 1];

fn current_second() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs()
}

fn record_fetch() {
    let second = current_second();
    let bucket = &RATE[(second % RATE.len() as u64) as usize];
    if bucket.second.swap(second, Ordering::Relaxed) == second {
        bucket.hits.fetch_add(1, Ordering::Relaxed);
    } else {
        bucket.hits.store(1, Ordering::Relaxed);
    }
}

/// Requests answered per second across the window, every session together. The second
/// still filling is left out, so the figure does not dip at whatever moment it is read.
pub fn requests_per_second() -> f64 {
    let now = current_second();
    let hits: u32 = RATE
        .iter()
        .filter(|b| {
            let second = b.second.load(Ordering::Relaxed);
            second < now && now - second <= RATE_WINDOW_SECS
        })
        .map(|b| b.hits.load(Ordering::Relaxed))
        .sum();
    hits as f64 / RATE_WINDOW_SECS as f64
}

#[cfg(test)]
#[path = "fetch.test.rs"]
mod tests;
