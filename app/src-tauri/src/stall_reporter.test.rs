use super::*;
use std::sync::mpsc::channel;

fn frames(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn captures_the_stack_of_a_blocked_thread() {
    let (tx, rx) = channel();
    let blocked = thread::spawn(move || {
        tx.send(unsafe { GetCurrentThreadId() }).unwrap();
        thread::sleep(Duration::from_secs(3));
    });
    let tid = rx.recv().unwrap();
    thread::sleep(Duration::from_millis(100));

    let stack = capture(open_thread(tid).expect("open thread"));
    blocked.join().unwrap();

    assert!(stack.len() >= 2, "{stack:?}");
    assert!(
        stack
            .iter()
            .any(|f| f.to_lowercase().contains("sleep") || f.contains("NtDelayExecution")),
        "{stack:?}"
    );
}

#[test]
fn idle_means_parked_in_the_message_pump() {
    assert!(is_idle(&frames(&[
        "NtUserGetMessage",
        "GetMessageW",
        "tao::platform_impl::event_loop"
    ])));
    assert!(!is_idle(&frames(&[
        "NtReadFile",
        "ReadFile",
        "std::fs::read"
    ])));
    assert!(!is_idle(&frames(&[
        "NtUserGetMessage",
        "GetMessageA",
        "webview2_com::wait_with_pump"
    ])));
    assert!(!is_idle(&frames(&["a", "b", "c", "GetMessageW"])));
}
