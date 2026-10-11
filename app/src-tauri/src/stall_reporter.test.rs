use super::*;
use std::sync::mpsc::channel;

fn frames(v: &[&str]) -> Vec<String> {
    v.iter().map(ToString::to_string).collect()
}

#[inline(never)]
fn hold_until_released(release: std::sync::mpsc::Receiver<()>) {
    release.recv().expect("test releases the blocked worker");
}

#[test]
fn captures_the_stack_of_a_blocked_thread() {
    let (tid_tx, tid_rx) = channel();
    let (release_tx, release_rx) = channel();
    let blocked = thread::spawn(move || {
        tid_tx.send(unsafe { GetCurrentThreadId() }).unwrap();
        hold_until_released(release_rx);
    });
    let tid = tid_rx.recv().unwrap();

    // Keep the target parked until after capture. Poll the actual stack for our no-inline
    // blocking frame so the assertion does not depend on a guessed sleep interval.
    let stack = if let Some(handle) = open_thread(tid) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut latest = Vec::new();
        while Instant::now() < deadline {
            latest = capture(handle);
            if latest
                .iter()
                .any(|frame| frame.contains("hold_until_released"))
            {
                break;
            }
            thread::yield_now();
        }
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
        latest
    } else {
        Vec::new()
    };

    release_tx.send(()).unwrap();
    blocked.join().unwrap();

    assert!(
        stack
            .iter()
            .any(|frame| frame.contains("hold_until_released")),
        "captured stack must identify the intentional blocking frame: {stack:?}"
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
