use super::*;
use std::collections::HashSet;
use std::thread;

fn transport(send: SendFn) -> Arc<Transport> {
    Arc::new(Transport {
        send,
        backoff: Duration::from_millis(1),
    })
}

/// Wraps a synchronous answer in the async send seam. A test that observes how many
/// requests run together writes its own async closure instead.
fn sync_send(
    f: impl Fn(HttpRequestSpec) -> AppResult<HttpResponse> + Send + Sync + 'static,
) -> SendFn {
    Box::new(move |req| {
        let answer = f(req);
        Box::pin(async move { answer })
    })
}

fn ok_send() -> SendFn {
    sync_send(|_| {
        Ok(HttpResponse {
            status: 200,
            body: Vec::new(),
        })
    })
}

fn session(send: SendFn) -> Session {
    Session::new(transport(send), Arc::default())
}

fn endpoint(name: &'static str, policy: Policy) -> Endpoint {
    Endpoint {
        name: Cow::Borrowed(name),
        policy,
        idempotent: false,
    }
}

fn wide(inflight: u32) -> Policy {
    Policy {
        inflight: Some(inflight),
        ..Policy::default()
    }
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

/// A send that holds each request until `target` are in flight (or `wait` passes),
/// recording the most it ever saw at once. The body echoes the url, so a caller can
/// check the answers came back in request order.
fn barrier_send(target: u32, wait: Duration, peak: Arc<AtomicU32>) -> SendFn {
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

fn bodies(res: Vec<AppResult<HttpResponse>>) -> Vec<String> {
    res.into_iter()
        .map(|r| String::from_utf8(r.expect("answered").body).unwrap())
        .collect()
}

#[test]
fn fetch_puts_every_request_in_flight_at_once() {
    let peak = Arc::new(AtomicU32::new(0));
    let s = session(barrier_send(8, Duration::from_secs(5), peak.clone()));
    let out = s.fetch(&endpoint("e", Policy::default()), 1, &gets(8));
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
fn fetch_holds_the_declared_inflight_ceiling() {
    let peak = Arc::new(AtomicU32::new(0));
    // Nothing releases the barrier, so every request waits out the same short window:
    // whatever runs together is what the lane allows.
    let s = session(barrier_send(
        u32::MAX,
        Duration::from_millis(150),
        peak.clone(),
    ));
    let out = s.fetch(&endpoint("e", wide(8)), 1, &gets(20));
    assert_eq!(out.len(), 20);
    assert_eq!(peak.load(Ordering::SeqCst), 8);
}

#[test]
fn an_endpoint_declaring_no_inflight_takes_the_default_width() {
    let peak = Arc::new(AtomicU32::new(0));
    let s = session(barrier_send(
        u32::MAX,
        Duration::from_millis(150),
        peak.clone(),
    ));
    let n = DEFAULT_INFLIGHT as usize + 12;
    let out = s.fetch(&endpoint("e", Policy::default()), 1, &gets(n));
    assert_eq!(out.len(), n);
    assert_eq!(peak.load(Ordering::SeqCst), DEFAULT_INFLIGHT);
}

/// The lane belongs to the session, so more threads buy no more network: two callers
/// sharing one session hold its ceiling between them.
#[test]
fn threads_sharing_a_session_do_not_widen_its_lane() {
    let peak = Arc::new(AtomicU32::new(0));
    let s = session(barrier_send(
        u32::MAX,
        Duration::from_millis(150),
        peak.clone(),
    ));
    let ep = endpoint("e", wide(6));
    let reqs = gets(10);
    thread::scope(|scope| {
        for _ in 0..2 {
            let (s, ep, reqs) = (&s, &ep, &reqs);
            scope.spawn(move || assert_eq!(s.fetch(ep, 1, reqs).len(), 10));
        }
    });
    assert_eq!(peak.load(Ordering::SeqCst), 6);
}

/// Each endpoint a session reaches gets its own lane: a full one never holds up another.
#[test]
fn two_endpoints_in_one_session_do_not_share_a_lane() {
    let peak = Arc::new(AtomicU32::new(0));
    let s = session(barrier_send(
        u32::MAX,
        Duration::from_millis(150),
        peak.clone(),
    ));
    let (a, b) = (endpoint("a", wide(4)), endpoint("b", wide(4)));
    let reqs = gets(8);
    thread::scope(|scope| {
        for ep in [&a, &b] {
            let (s, reqs) = (&s, &reqs);
            scope.spawn(move || assert_eq!(s.fetch(ep, 1, reqs).len(), 8));
        }
    });
    assert_eq!(peak.load(Ordering::SeqCst), 8);
    assert_eq!(s.usage().inflight_limit, 8);
}

/// A background run and an interactive lookup on the same endpoint never queue behind
/// each other: each session has its own lane.
#[test]
fn a_second_session_is_not_held_up_by_a_full_first_one() {
    let peak = Arc::new(AtomicU32::new(0));
    let t = transport(barrier_send(
        u32::MAX,
        Duration::from_millis(150),
        peak.clone(),
    ));
    let ep = endpoint("shared", wide(4));
    let (first, second) = (
        Session::new(t.clone(), Arc::default()),
        Session::new(t, Arc::default()),
    );
    let reqs = gets(4);
    thread::scope(|scope| {
        for s in [&first, &second] {
            let (ep, reqs) = (&ep, &reqs);
            scope.spawn(move || assert_eq!(s.fetch(ep, 1, reqs).len(), 4));
        }
    });
    assert_eq!(peak.load(Ordering::SeqCst), 8);
}

#[test]
fn fetch_retries_a_declared_status_per_request() {
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let s = session(sync_send(move |req: HttpRequestSpec| {
        let mut log = log.lock().unwrap();
        log.push(req.url.clone());
        // The first request is throttled once, then answers.
        let first_try =
            req.url.ends_with('0') && log.iter().filter(|u| **u == req.url).count() == 1;
        Ok(HttpResponse {
            status: if first_try { 429 } else { 200 },
            body: req.url.as_bytes().to_vec(),
        })
    }));
    let ep = endpoint(
        "e",
        Policy {
            retry: Some(RetrySpec {
                attempts: 3,
                on: vec![429],
            }),
            ..Policy::default()
        },
    );
    let out = s.fetch(&ep, 1, &gets(2));

    assert_eq!(
        bodies(out),
        vec![
            "https://x.test/0".to_string(),
            "https://x.test/1".to_string()
        ]
    );
    assert_eq!(seen.lock().unwrap().len(), 3);
    assert_eq!(s.usage().retries, 1);
}

#[test]
fn fetch_pays_the_rate_limiter_per_request() {
    // Two tokens up front, then one every 2ms: eight requests cannot beat 12ms.
    let ep = endpoint(
        "e",
        Policy {
            rate: Some(RateSpec {
                units: 2,
                per_ms: 4,
                cost: RateCost::Request,
            }),
            ..Policy::default()
        },
    );
    let start = Instant::now();
    let out = session(ok_send()).fetch(&ep, 1, &gets(8));
    assert_eq!(out.len(), 8);
    assert!(
        start.elapsed() >= Duration::from_millis(10),
        "{:?}",
        start.elapsed()
    );
}

#[test]
fn a_cancelled_session_declines_every_request() {
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    let cancel = Arc::new(AtomicBool::new(true));
    let s = Session::new(
        transport(sync_send(move |_: HttpRequestSpec| {
            seen.fetch_add(1, Ordering::SeqCst);
            Ok(HttpResponse {
                status: 200,
                body: Vec::new(),
            })
        })),
        cancel,
    );
    for n in [1, 4] {
        let out = s.fetch(&endpoint("e", Policy::default()), 1, &gets(n));
        assert_eq!(out.len(), n);
        assert!(
            out.iter().all(|r| matches!(r, Err(e) if e.0 == CANCELLED)),
            "{n} requests"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn a_session_under_another_cancel_shares_its_lanes_but_not_its_cancel() {
    let base = session(ok_send());
    let cancel = Arc::new(AtomicBool::new(false));
    let view = base.cancelled_by(cancel.clone());
    let e = endpoint("e", wide(3));

    assert!(view.fetch(&e, 1, &gets(2)).iter().all(Result::is_ok));
    assert_eq!(
        base.usage().inflight_limit,
        3,
        "the view opened the base's lane"
    );

    cancel.store(true, Ordering::Relaxed);
    assert!(view.fetch(&e, 1, &gets(1)).iter().all(Result::is_err));
    assert!(base.fetch(&e, 1, &gets(1)).iter().all(Result::is_ok));
}

#[test]
fn fetch_stream_hands_answers_over_in_completion_order() {
    let s = session(Box::new(|req| {
        Box::pin(async move {
            if req.url == "slow" {
                time::sleep(Duration::from_millis(50)).await;
            }
            Ok(HttpResponse {
                status: 200,
                body: Vec::new(),
            })
        })
    }));
    let reqs: Vec<HttpRequestSpec> = ["slow", "fast", "fast2"].map(get).to_vec();
    let mut order = Vec::new();
    s.fetch_stream(&endpoint("e", Policy::default()), 1, &reqs, &mut |i, r| {
        r.expect("every request answers");
        order.push(i);
    });
    assert_eq!(order.len(), 3);
    assert_eq!(
        order.last(),
        Some(&0),
        "the slow request answers last instead of holding the others"
    );
}

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
            assert!(l.acquire(1, &|| false).await);
        }
    });
    let ms = t.elapsed().as_millis();
    assert!(ms >= 180, "6 acquires took only {ms}ms");
}

#[test]
fn a_cancel_frees_a_request_waiting_on_the_rate_limiter() {
    let l = RateLimiter::new(RateSpec {
        units: 1,
        per_ms: 10_000,
        cost: RateCost::Request,
    })
    .unwrap();
    let t = Instant::now();
    let cancelled = || t.elapsed() > Duration::from_millis(30);
    let paid = drive(async {
        assert!(l.acquire(1, &cancelled).await);
        l.acquire(1, &cancelled).await
    });
    assert!(!paid);
    let ms = t.elapsed().as_millis();
    assert!(ms < 500, "the cancelled acquire took {ms}ms");
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

/// Fails the first send of each request in transit, then answers with its URL.
fn flaky_send(calls: Arc<AtomicU32>) -> SendFn {
    let seen: Arc<Mutex<HashSet<String>>> = Arc::default();
    sync_send(move |req: HttpRequestSpec| {
        calls.fetch_add(1, Ordering::SeqCst);
        if seen.lock().unwrap().insert(req.url.clone()) {
            return Err(AppError("request failed: connection reset".into()));
        }
        Ok(HttpResponse {
            status: 200,
            body: req.url.into_bytes(),
        })
    })
}

#[test]
fn an_idempotent_endpoint_sends_a_request_lost_in_transit_again() {
    let calls = Arc::new(AtomicU32::new(0));
    let s = session(flaky_send(calls.clone()));
    let ep = Endpoint {
        idempotent: true,
        ..endpoint("e", Policy::default())
    };
    let out = s.fetch(&ep, 1, &gets(2));

    assert_eq!(
        bodies(out),
        vec![
            "https://x.test/0".to_string(),
            "https://x.test/1".to_string()
        ]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert_eq!(s.usage().retries, 2);
}

#[test]
fn an_endpoint_not_declared_idempotent_answers_a_lost_request_with_its_error() {
    let calls = Arc::new(AtomicU32::new(0));
    let s = session(flaky_send(calls.clone()));
    let out = s.fetch(&endpoint("e", Policy::default()), 1, &gets(1));

    assert!(matches!(&out[0], Err(e) if e.0.contains("connection reset")));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_cancel_cuts_a_retry_backoff_short() {
    let cancel = Arc::new(AtomicBool::new(false));
    let trip = cancel.clone();
    let s = Session::new(
        Arc::new(Transport {
            send: sync_send(move |_: HttpRequestSpec| {
                trip.store(true, Ordering::SeqCst);
                Ok(HttpResponse {
                    status: 503,
                    body: Vec::new(),
                })
            }),
            backoff: Duration::from_secs(60),
        }),
        cancel,
    );
    let start = Instant::now();
    let out = s.fetch(&endpoint("e", Policy::default()), 1, &gets(1));

    assert!(matches!(&out[0], Err(e) if e.0 == CANCELLED));
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "{:?}",
        start.elapsed()
    );
}
