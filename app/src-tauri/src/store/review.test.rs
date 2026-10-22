use super::*;
use crate::store::storage::tests::map_on_disk;
use crate::test_util::loc_ids;
use tauri::async_runtime::block_on;

fn edit(edits: Vec<Edit<ReviewSession>>) -> AppResult<Vec<ReviewSession>> {
    block_on(store_review_edit(edits))
}

fn sessions(
    map_id: &Id<MapMeta, String>,
    status: Option<&str>,
    source_key: Option<&str>,
) -> Vec<ReviewSession> {
    block_on(store_review_list(
        map_id.clone(),
        status.map(Into::into),
        source_key.map(Into::into),
    ))
    .unwrap()
}

fn resumable(map_id: &Id<MapMeta, String>, source_key: &str) -> Option<ReviewSession> {
    sessions(map_id, Some("active"), Some(source_key))
        .into_iter()
        .next()
}

fn session(map_id: &Id<MapMeta, String>, source_key: &str, order: Vec<u32>) -> ReviewSession {
    let order = loc_ids(order);
    ReviewSession {
        id: String::new(),
        map_id: map_id.clone(),
        name: "Tag: red".into(),
        source_key: source_key.into(),
        source_props: serde_json::json!({ "type": "Tag", "tagId": 1 }),
        cursor_id: order.first().copied().unwrap_or(Id::new(0)),
        order,
        reviewed: Vec::new(),
        status: "active".into(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn add(session: ReviewSession) -> ReviewSession {
    edit(vec![Op::Add(session)]).unwrap().remove(0)
}

fn put(patch: ReviewSessionPatch) {
    edit(vec![Op::Put(patch)]).unwrap();
}

#[test]
fn an_added_session_takes_a_fresh_id_and_is_stored_as_given() {
    let map = map_on_disk("review-added");
    let first = add(session(&map, "tag:1", vec![10, 20, 30]));
    let second = add(session(&map, "tag:2", vec![10]));
    assert!(!first.id.is_empty());
    assert_ne!(first.id, second.id);
    assert_ne!(first.created_at, "");
    assert_eq!(first.created_at, first.updated_at);

    let got = resumable(&map, "tag:1").expect("session present");
    assert_eq!(got.id, first.id);
    assert_eq!(got.cursor_id, Id::new(10));
    assert!(got.reviewed.is_empty());
    assert_eq!(got.order, loc_ids([10, 20, 30]));
    assert_eq!(got.status, "active");
    assert_eq!(got.source_props["type"], "Tag");
    assert_eq!(got.source_props["tagId"], 1);
}

#[test]
fn a_session_needs_a_worklist_holding_its_cursor_and_a_refused_edit_writes_nothing() {
    let map = map_on_disk("review-refused");
    assert!(edit(vec![Op::Add(session(&map, "tag:1", vec![]))]).is_err());
    let mut stray = session(&map, "tag:1", vec![1, 2]);
    stray.cursor_id = Id::new(3);
    assert!(edit(vec![
        Op::Add(session(&map, "tag:1", vec![1])),
        Op::Add(stray)
    ])
    .is_err());
    assert!(sessions(&map, None, None).is_empty());
}

#[test]
fn nothing_resumes_for_an_unknown_key_or_another_map() {
    let map = map_on_disk("review-unknown");
    let other = map_on_disk("review-unknown-other");
    add(session(&map, "tag:1", vec![1]));
    assert!(resumable(&map, "tag:2").is_none());
    assert!(resumable(&other, "tag:1").is_none());
}

#[test]
fn a_patch_persists_cursor_reviewed_and_ordering() {
    let map = map_on_disk("review-patched");
    let s = add(session(&map, "tag:1", vec![1, 2, 3, 4]));
    put(ReviewSessionPatch {
        cursor_id: Some(Id::new(3)),
        reviewed: Some(loc_ids([1, 2])),
        ..ReviewSessionPatch::of(s.id.clone())
    });
    let got = resumable(&map, "tag:1").unwrap();
    assert_eq!(got.cursor_id, Id::new(3));
    assert_eq!(got.reviewed, loc_ids([1, 2]));
    assert_eq!(got.order, loc_ids([1, 2, 3, 4]));
}

#[test]
fn pruning_ordering_and_reviewed_does_not_disturb_cursor() {
    let map = map_on_disk("review-pruned");
    let s = add(session(&map, "tag:1", vec![1, 2, 3, 4, 5]));
    put(ReviewSessionPatch {
        cursor_id: Some(Id::new(3)),
        reviewed: Some(loc_ids([1, 2])),
        ..ReviewSessionPatch::of(s.id.clone())
    });
    put(ReviewSessionPatch {
        reviewed: Some(loc_ids([1])),
        order: Some(loc_ids([1, 3, 5])),
        ..ReviewSessionPatch::of(s.id.clone())
    });
    let got = resumable(&map, "tag:1").unwrap();
    assert_eq!(got.cursor_id, Id::new(3));
    assert_eq!(got.order, loc_ids([1, 3, 5]));
    assert_eq!(got.reviewed, loc_ids([1]));
}

#[test]
fn done_sessions_do_not_resume_but_are_listable() {
    let map = map_on_disk("review-done");
    let s = add(session(&map, "tag:1", vec![1, 2]));
    put(ReviewSessionPatch {
        status: Some("done".into()),
        ..ReviewSessionPatch::of(s.id.clone())
    });
    assert!(resumable(&map, "tag:1").is_none());
    assert_eq!(sessions(&map, Some("done"), None).len(), 1);
    assert_eq!(sessions(&map, Some("active"), None).len(), 0);
}

#[test]
fn list_scopes_to_map() {
    let map = map_on_disk("review-scoped");
    let other = map_on_disk("review-scoped-other");
    add(session(&map, "tag:1", vec![1]));
    add(session(&map, "tag:2", vec![2]));
    add(session(&other, "tag:1", vec![3]));
    assert_eq!(sessions(&map, None, None).len(), 2);
    assert_eq!(sessions(&other, None, None).len(), 1);
}

#[test]
fn a_removed_session_is_gone_and_a_later_patch_to_it_writes_nothing() {
    let map = map_on_disk("review-removed");
    let s = add(session(&map, "tag:1", vec![1, 2]));
    edit(vec![Op::Remove(s.id.clone())]).unwrap();
    put(ReviewSessionPatch {
        name: Some("late".into()),
        ..ReviewSessionPatch::of(s.id.clone())
    });
    assert!(sessions(&map, None, None).is_empty());
}

#[test]
fn a_patch_stamps_a_new_updated_time() {
    let map = map_on_disk("review-stamped");
    let s = add(session(&map, "tag:1", vec![1, 2]));
    storage::open_db()
        .unwrap()
        .execute(
            "UPDATE review_sessions SET updated_at = '2000-01-01' WHERE id = ?",
            [&s.id],
        )
        .unwrap();
    put(ReviewSessionPatch {
        cursor_id: Some(Id::new(2)),
        ..ReviewSessionPatch::of(s.id.clone())
    });
    let got = resumable(&map, "tag:1").unwrap();
    assert_eq!(got.cursor_id, Id::new(2));
    assert_ne!(got.updated_at, "2000-01-01");
}
