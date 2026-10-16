use super::*;
use tauri::async_runtime;

#[test]
fn a_reserved_run_id_is_never_handed_out_again() {
    let reserved = run_reserve();
    assert_ne!(run_reserve(), reserved);
}

#[test]
fn a_cancel_reaches_only_the_run_it_names() {
    let (a, b) = (run_reserve(), run_reserve());
    let (cancel_a, cancel_b) = (
        register_run(a, None).unwrap(),
        register_run(b, None).unwrap(),
    );
    async_runtime::block_on(run_cancel(a)).unwrap();
    assert!(cancel_a.load(Ordering::Relaxed));
    assert!(!cancel_b.load(Ordering::Relaxed));
    drop(unregister_run(a));
    drop(unregister_run(b));
}

#[test]
fn an_unregistered_run_ignores_a_cancel() {
    let id = run_reserve();
    let cancel = register_run(id, None).unwrap();
    assert!(unregister_run(id).is_some());
    async_runtime::block_on(run_cancel(id)).unwrap();
    assert!(!cancel.load(Ordering::Relaxed));
    assert!(unregister_run(id).is_none());
}

#[test]
fn only_writers_to_the_named_pending_layer_are_cancelled() {
    let map: Id<MapMeta, String> = Id::new("runs-test-map".into());
    let pending = |name: &str| {
        Some((
            map.clone(),
            Target::Pending {
                name: name.to_string(),
            },
        ))
    };
    let (draft, other) = (run_reserve(), run_reserve());
    let draft_cancel = register_run(draft, pending("draft")).unwrap();
    let other_cancel = register_run(other, pending("other")).unwrap();

    assert!(pending_writers(&map).is_superset(&BTreeSet::from(["draft".into(), "other".into()])));
    cancel_pending_writers(&map, "draft");
    assert!(draft_cancel.load(Ordering::Relaxed));
    assert!(!other_cancel.load(Ordering::Relaxed));

    drop(unregister_run(draft));
    drop(unregister_run(other));
    assert!(pending_writers(&map).is_empty());
}
