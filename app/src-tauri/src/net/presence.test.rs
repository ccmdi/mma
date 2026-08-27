use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct Fake;

fn counting_connect(connects: Arc<AtomicUsize>) -> impl Fn() -> Option<Fake> + Send + 'static {
    move || {
        connects.fetch_add(1, Ordering::SeqCst);
        Some(Fake)
    }
}

fn wait_for(rx: &Receiver<()>, n: usize) {
    for _ in 0..n {
        rx.recv_timeout(Duration::from_secs(5)).expect("job ran");
    }
}

#[test]
fn submit_returns_while_connect_is_blocked() {
    let (gate_tx, gate_rx) = channel::<()>();
    let gate_rx = Mutex::new(gate_rx);
    let w = Worker::spawn(move || {
        gate_rx.lock().unwrap().recv().ok();
        Some(Fake)
    });
    let t = Instant::now();
    w.submit(true, |_| Ok(()));
    w.submit(true, |_| Ok(()));
    assert!(t.elapsed() < Duration::from_millis(100));
    let _ = gate_tx.send(());
    let _ = gate_tx.send(());
}

#[test]
fn jobs_run_in_submission_order() {
    let w = Worker::spawn(|| Some(Fake));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = channel();
    for i in 0..20 {
        let seen = seen.clone();
        let done_tx = done_tx.clone();
        w.submit(true, move |_| {
            seen.lock().unwrap().push(i);
            let _ = done_tx.send(());
            Ok(())
        });
    }
    wait_for(&done_rx, 20);
    assert_eq!(*seen.lock().unwrap(), (0..20).collect::<Vec<_>>());
}

#[test]
fn no_connect_jobs_are_dropped_when_disconnected() {
    let connects = Arc::new(AtomicUsize::new(0));
    let w = Worker::spawn(counting_connect(connects.clone()));
    let (done_tx, done_rx) = channel();
    let ran = Arc::new(AtomicUsize::new(0));
    {
        let ran = ran.clone();
        w.submit(false, move |_| {
            ran.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
    }
    // A connecting job after it proves the queue drained past the dropped one.
    w.submit(true, move |_| {
        let _ = done_tx.send(());
        Ok(())
    });
    wait_for(&done_rx, 1);
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    assert_eq!(connects.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_job_drops_client_and_next_call_reconnects() {
    let connects = Arc::new(AtomicUsize::new(0));
    let w = Worker::spawn(counting_connect(connects.clone()));
    let (done_tx, done_rx) = channel();
    let d = done_tx.clone();
    w.submit(true, move |_| {
        let _ = d.send(());
        Err("pipe broke".into())
    });
    w.submit(true, move |_| {
        let _ = done_tx.send(());
        Ok(())
    });
    wait_for(&done_rx, 2);
    assert_eq!(connects.load(Ordering::SeqCst), 2);
}
