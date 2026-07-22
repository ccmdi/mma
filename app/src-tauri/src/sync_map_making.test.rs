use super::*;
use crate::sync::{IdentityModel, NormalizedSyncLocation, PushBatch, PushedId, SyncProvider};
use std::cell::RefCell;
use std::collections::HashSet;

// --- builders ---------------------------------------------------------------

fn provider() -> MapMakingProvider {
    MapMakingProvider {
        api_key: "test-key".into(),
    }
}

fn norm() -> NormalizedSyncLocation {
    NormalizedSyncLocation {
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
    }
}

fn remote(id: i64) -> MmLocation {
    MmLocation {
        id,
        ..Default::default()
    }
}

fn empty_batch() -> PushBatch<MmLocation> {
    PushBatch {
        create: vec![],
        update: vec![],
        delete: vec![],
        desired: vec![],
    }
}

/// Local-id -> assigned-id pairs, since PushedId has no PartialEq.
fn ids(v: &[PushedId]) -> Vec<(u32, i64)> {
    v.iter().map(|p| (p.local_id, p.remote_id)).collect()
}

/// Mimics the server: assign 7000, 7001, ... to each create in submission order.
fn fake_post(part: &PushPart) -> AppResult<HashMap<String, i64>> {
    let mut remap = HashMap::new();
    for (i, c) in part.create.iter().enumerate() {
        remap.insert(c.id.to_string(), 7000 + i as i64);
    }
    Ok(remap)
}

// --- protobuf encoders (hand-built test buffers) ----------------------------

fn wr_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        buf.push(b);
        if v == 0 {
            break;
        }
    }
}

fn wr_tag(buf: &mut Vec<u8>, field: u64, wire: u64) {
    wr_varint(buf, (field << 3) | wire);
}

fn wr_varint_field(buf: &mut Vec<u8>, field: u64, v: u64) {
    wr_tag(buf, field, 0);
    wr_varint(buf, v);
}

fn wr_double_field(buf: &mut Vec<u8>, field: u64, v: f64) {
    wr_tag(buf, field, 1);
    buf.extend_from_slice(&v.to_le_bytes());
}

fn wr_bytes_field(buf: &mut Vec<u8>, field: u64, data: &[u8]) {
    wr_tag(buf, field, 2);
    wr_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

fn wr_string_field(buf: &mut Vec<u8>, field: u64, s: &str) {
    wr_bytes_field(buf, field, s.as_bytes());
}

fn wr_packed_varints(buf: &mut Vec<u8>, field: u64, vals: &[u32]) {
    let mut inner = Vec::new();
    for &v in vals {
        wr_varint(&mut inner, v as u64);
    }
    wr_bytes_field(buf, field, &inner);
}

// --- contract ---------------------------------------------------------------

#[test]
fn declares_persisted_identity() {
    let p = provider();
    assert_eq!(p.id(), "map-making.app");
    assert_eq!(p.identity(), IdentityModel::Stable);
    assert!(p.supports_tags());
    assert_eq!(p.remote_id_of(&remote(9000), 3), 9000);
}

#[test]
fn materialize_then_normalize_round_trips() {
    let p = provider();
    let n = NormalizedSyncLocation {
        lat: 1.5,
        lng: 2.5,
        heading: 90.0,
        pitch: -5.0,
        zoom: 1.5,
        pano_id: Some("abc".into()),
        flags: 1, // LoadAsPanoId
        tags: vec!["blue".into(), "red".into()],
    };
    let item = p.materialize(&n);
    assert_eq!(item.id, 0);
    assert_eq!(item.zoom, Some(1.5));
    assert_eq!(item.tags, vec!["blue", "red"]);

    // Server echoes an id plus remote-only fields; the contract must be unaffected.
    let echoed = MmLocation {
        id: 555,
        author: Some(1),
        created_at: Some(1_700_000_000),
        pano_date: Some(1_600_000_000),
        ..item.clone()
    };
    assert_eq!(p.normalize(&echoed), n);
}

#[test]
fn remote_only_fields_never_affect_contract() {
    let p = provider();
    let base = MmLocation {
        tags: vec!["red".into()],
        zoom: Some(0.0),
        ..Default::default()
    };
    let enriched = MmLocation {
        author: Some(42),
        created_at: Some(1),
        pano_date: Some(2),
        ..base.clone()
    };
    assert_eq!(p.normalize(&base), p.normalize(&enriched));
}

#[test]
fn zoom_none_and_zero_are_equivalent() {
    let p = provider();
    let a = MmLocation {
        zoom: None,
        ..Default::default()
    };
    let b = MmLocation {
        zoom: Some(0.0),
        ..Default::default()
    };
    assert_eq!(p.normalize(&a).zoom, 0.0);
    assert_eq!(p.normalize(&a), p.normalize(&b));
}

#[test]
fn normalize_dedupes_and_sorts_tags() {
    let p = provider();
    let m = MmLocation {
        tags: vec!["red".into(), "blue".into(), "red".into()],
        ..Default::default()
    };
    assert_eq!(p.normalize(&m).tags, vec!["blue", "red"]);
}

#[test]
fn normalize_strips_virtual_flags() {
    let p = provider();
    // SeenOverlay(8) | Informational(2) -> Informational only.
    let m = MmLocation {
        flags: 10,
        ..Default::default()
    };
    assert_eq!(p.normalize(&m).flags, 2);
}

// --- push wire shape --------------------------------------------------------

#[test]
fn creates_use_negative_placeholders_and_remap() {
    let p = provider();
    let mut batch = empty_batch();
    batch.create.push((
        11,
        p.materialize(&NormalizedSyncLocation { lat: 1.0, ..norm() }),
    ));
    batch.create.push((
        12,
        p.materialize(&NormalizedSyncLocation { lat: 2.0, ..norm() }),
    ));

    let parts = push_chunks(&batch, PUSH_CHUNK);
    assert_eq!(parts.len(), 1);
    assert_eq!(
        parts[0].create.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![-1, -2]
    );
    assert!(parts[0].remove.is_empty());

    let mut commit = |_: &[PushedId]| Ok(());
    let mut post = fake_post;
    let pushed = push_apply(&batch, PUSH_CHUNK, &mut commit, &mut post).unwrap();
    assert_eq!(ids(&pushed), vec![(11, 7000), (12, 7001)]);
}

#[test]
fn update_is_remove_old_plus_create_new() {
    let p = provider();
    let mut batch = empty_batch();
    let n = NormalizedSyncLocation {
        lat: 5.0,
        tags: vec!["red".into()],
        ..norm()
    };
    batch.update.push((42, p.materialize(&n), remote(9000)));

    let parts = push_chunks(&batch, PUSH_CHUNK);
    assert_eq!(parts.len(), 1);
    let part = &parts[0];
    assert_eq!(part.remove, vec![9000]); // old remote id dropped
    assert_eq!(part.create.len(), 1);
    assert_eq!(part.create[0].id, -1); // re-created under a placeholder
    assert_eq!(part.create[0].location, LatLng { lat: 5.0, lng: 0.0 });
    assert_eq!(part.create[0].tags, vec!["red"]);
    assert_eq!(part.staged.len(), 1);
    assert_eq!(part.staged[0].local_id, 42);
    assert_eq!(part.staged[0].neg_id, -1);

    let mut commit = |_: &[PushedId]| Ok(());
    let mut post = fake_post;
    let pushed = push_apply(&batch, PUSH_CHUNK, &mut commit, &mut post).unwrap();
    assert_eq!(ids(&pushed), vec![(42, 7000)]);
}

#[test]
fn deletes_remove_by_id_and_produce_no_pushed() {
    let mut batch = empty_batch();
    batch.delete.push(remote(1234));

    let parts = push_chunks(&batch, PUSH_CHUNK);
    assert_eq!(parts[0].remove, vec![1234]);
    assert!(parts[0].create.is_empty());

    let mut commit = |_: &[PushedId]| Ok(());
    let mut post = fake_post;
    let pushed = push_apply(&batch, PUSH_CHUNK, &mut commit, &mut post).unwrap();
    assert!(pushed.is_empty());
}

#[test]
fn one_edit_covers_create_update_delete() {
    let p = provider();
    let mut batch = empty_batch();
    batch.create.push((
        1,
        p.materialize(&NormalizedSyncLocation { lat: 1.0, ..norm() }),
    ));
    batch.update.push((
        2,
        p.materialize(&NormalizedSyncLocation { lat: 2.0, ..norm() }),
        remote(500),
    ));
    batch.delete.push(remote(600));

    let mut calls = 0;
    let mut sent: Vec<(Vec<i64>, Vec<i64>)> = Vec::new();
    let mut commit = |_: &[PushedId]| Ok(());
    let pushed = {
        let mut post = |part: &PushPart| {
            calls += 1;
            sent.push((
                part.create.iter().map(|c| c.id).collect(),
                part.remove.clone(),
            ));
            fake_post(part)
        };
        push_apply(&batch, PUSH_CHUNK, &mut commit, &mut post).unwrap()
    };

    assert_eq!(calls, 1); // one editLocations call
    assert_eq!(sent[0].0, vec![-1, -2]); // create ids: create op then update op
    assert_eq!(sent[0].1, vec![500, 600]); // removes: update's old id then delete
    assert_eq!(ids(&pushed), vec![(1, 7000), (2, 7001)]);
}

#[test]
fn empty_batch_never_posts() {
    let batch = empty_batch();
    let mut calls = 0;
    let mut commit = |_: &[PushedId]| Ok(());
    let pushed = {
        let mut post = |_: &PushPart| {
            calls += 1;
            Ok(HashMap::new())
        };
        push_apply(&batch, PUSH_CHUNK, &mut commit, &mut post).unwrap()
    };
    assert!(pushed.is_empty());
    assert_eq!(calls, 0);
}

#[test]
fn edit_body_serializes_camel_case_bulk() {
    let input = to_input(
        &MmLocation {
            location: LatLng { lat: 1.0, lng: 2.0 },
            pano_id: Some("p".into()),
            heading: 3.0,
            pitch: 4.0,
            zoom: Some(5.0),
            flags: 1,
            tags: vec!["a".into()],
            ..Default::default()
        },
        -1,
    );
    let req = EditRequest {
        edits: vec![Edit {
            action: EditAction {
                kind: EDIT_ACTION_BULK,
            },
            create: vec![input],
            remove: vec![9000],
        }],
    };
    let v: serde_json::Value = serde_json::to_value(&req).unwrap();
    let edit = &v["edits"][0];
    assert_eq!(edit["action"]["type"], 8);
    assert_eq!(edit["remove"][0], 9000);
    let c = &edit["create"][0];
    assert_eq!(c["id"], -1);
    assert_eq!(c["panoId"], "p");
    assert_eq!(c["location"]["lat"], 1.0);
    assert_eq!(c["location"]["lng"], 2.0);
    assert_eq!(c["heading"], 3.0);
    assert_eq!(c["zoom"], 5.0);
    assert_eq!(c["flags"], 1);
    assert_eq!(c["tags"][0], "a");
}

// --- chunking ---------------------------------------------------------------

#[test]
fn keeps_everything_in_one_request_when_it_fits() {
    let p = provider();
    let mut batch = empty_batch();
    for i in 1..=3u32 {
        batch.create.push((i, p.materialize(&norm())));
    }
    assert_eq!(push_chunks(&batch, 10).len(), 1);
}

#[test]
fn splits_into_parts_of_at_most_the_chunk_size() {
    let p = provider();
    let mut batch = empty_batch();
    for i in 1..=5u32 {
        batch.create.push((i, p.materialize(&norm())));
    }
    let parts = push_chunks(&batch, 2);

    assert_eq!(
        parts.iter().map(|p| p.create.len()).collect::<Vec<_>>(),
        vec![2, 2, 1]
    );
    // Placeholder ids stay unique ACROSS parts, or a later part's remap collides.
    let negs: Vec<i64> = parts
        .iter()
        .flat_map(|p| p.staged.iter().map(|s| s.neg_id))
        .collect();
    let uniq: HashSet<i64> = negs.iter().copied().collect();
    assert_eq!(uniq.len(), negs.len());
    let locals: Vec<u32> = parts
        .iter()
        .flat_map(|p| p.staged.iter().map(|s| s.local_id))
        .collect();
    assert_eq!(locals, vec![1, 2, 3, 4, 5]);
}

#[test]
fn never_separates_an_updates_remove_from_its_create() {
    // Chunk size 1 is the worst case: if the pairing could split, it would split here.
    let p = provider();
    let mut batch = empty_batch();
    batch.update.push((9, p.materialize(&norm()), remote(42)));
    batch.update.push((8, p.materialize(&norm()), remote(43)));
    let parts = push_chunks(&batch, 1);

    assert_eq!(parts.len(), 2);
    for part in &parts {
        assert_eq!(part.create.len(), 1);
        assert_eq!(part.remove.len(), 1);
    }
    let removes: Vec<i64> = parts.iter().flat_map(|p| p.remove.clone()).collect();
    assert_eq!(removes, vec![42, 43]);
}

#[test]
fn commit_runs_per_chunk_in_order() {
    // 5 creates, chunk 2 -> commit each chunk before the next request goes out.
    let p = provider();
    let mut batch = empty_batch();
    for i in 1..=5u32 {
        batch.create.push((i, p.materialize(&norm())));
    }
    let log = RefCell::new(Vec::<String>::new());
    let mut post = |part: &PushPart| {
        log.borrow_mut().push(format!("post:{}", part.create.len()));
        fake_post(part)
    };
    let mut commit = |pushed: &[PushedId]| {
        log.borrow_mut().push(format!("commit:{}", pushed.len()));
        Ok(())
    };
    push_apply(&batch, 2, &mut commit, &mut post).unwrap();
    assert_eq!(
        *log.borrow(),
        vec!["post:2", "commit:2", "post:2", "commit:2", "post:1", "commit:1"]
    );
}

// --- protobuf decode --------------------------------------------------------

#[test]
fn decode_resolves_all_fields_and_tags() {
    let mut loc = Vec::new();
    wr_varint_field(&mut loc, 1, 42); // id
    wr_varint_field(&mut loc, 2, 7); // author
    let mut ll = Vec::new();
    wr_double_field(&mut ll, 1, 48.85);
    wr_double_field(&mut ll, 2, 2.29);
    wr_bytes_field(&mut loc, 3, &ll); // location
    wr_string_field(&mut loc, 4, "PANO123"); // panoId
    wr_double_field(&mut loc, 5, 90.5); // heading
    wr_double_field(&mut loc, 6, -5.0); // pitch
    wr_double_field(&mut loc, 7, 1.5); // zoom
    wr_packed_varints(&mut loc, 8, &[1, 0]); // tagIndex -> blue, red (order kept)
    wr_varint_field(&mut loc, 9, 2); // flags
    wr_varint_field(&mut loc, 10, 1_700_000_000); // createdAt
    wr_varint_field(&mut loc, 11, 1_600_000_000); // panoDate

    let mut resp = Vec::new();
    wr_string_field(&mut resp, 1, "red");
    wr_string_field(&mut resp, 1, "blue");
    wr_bytes_field(&mut resp, 2, &loc);

    let out = decode_response(&resp).unwrap();
    assert_eq!(out.len(), 1);
    let m = &out[0];
    assert_eq!(m.id, 42);
    assert_eq!(m.author, Some(7));
    assert_eq!(
        m.location,
        LatLng {
            lat: 48.85,
            lng: 2.29
        }
    );
    assert_eq!(m.pano_id.as_deref(), Some("PANO123"));
    assert_eq!(m.heading, 90.5);
    assert_eq!(m.pitch, -5.0);
    assert_eq!(m.zoom, Some(1.5));
    assert_eq!(m.tags, vec!["blue", "red"]);
    assert_eq!(m.flags, 2);
    assert_eq!(m.created_at, Some(1_700_000_000));
    assert_eq!(m.pano_date, Some(1_600_000_000));
}

#[test]
fn decode_missing_location_defaults_to_zero() {
    let mut loc = Vec::new();
    wr_varint_field(&mut loc, 1, 5);
    let mut resp = Vec::new();
    wr_bytes_field(&mut resp, 2, &loc);

    let m = &decode_response(&resp).unwrap()[0];
    assert_eq!(m.location, LatLng { lat: 0.0, lng: 0.0 });
}

#[test]
fn decode_empty_pano_id_becomes_none() {
    let mut with_empty = Vec::new();
    wr_string_field(&mut with_empty, 4, ""); // present but empty
    let mut absent = Vec::new();
    wr_varint_field(&mut absent, 1, 1); // no panoId field at all

    let mut resp = Vec::new();
    wr_bytes_field(&mut resp, 2, &with_empty);
    wr_bytes_field(&mut resp, 2, &absent);

    let out = decode_response(&resp).unwrap();
    assert_eq!(out[0].pano_id, None);
    assert_eq!(out[1].pano_id, None);
}

#[test]
fn decode_drops_out_of_range_tag_indices() {
    let mut loc = Vec::new();
    wr_packed_varints(&mut loc, 8, &[0, 5]); // 5 is out of range
    let mut resp = Vec::new();
    wr_string_field(&mut resp, 1, "red");
    wr_bytes_field(&mut resp, 2, &loc);

    let m = &decode_response(&resp).unwrap()[0];
    assert_eq!(m.tags, vec!["red"]);
}

#[test]
fn decode_absent_zoom_is_some_zero() {
    let mut loc = Vec::new();
    wr_varint_field(&mut loc, 1, 1);
    let mut resp = Vec::new();
    wr_bytes_field(&mut resp, 2, &loc);

    let m = &decode_response(&resp).unwrap()[0];
    assert_eq!(m.zoom, Some(0.0));
}

#[test]
fn decode_skips_unknown_fields() {
    let mut loc = Vec::new();
    wr_varint_field(&mut loc, 1, 9); // id
    wr_varint_field(&mut loc, 99, 123); // unknown varint field
    wr_string_field(&mut loc, 77, "junk"); // unknown length-delimited field
    wr_double_field(&mut loc, 55, 3.14); // unknown 64-bit field

    let mut resp = Vec::new();
    wr_varint_field(&mut resp, 88, 1); // unknown top-level field
    wr_bytes_field(&mut resp, 2, &loc);

    let out = decode_response(&resp).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, 9);
}

#[test]
fn decode_empty_response_is_empty() {
    assert!(decode_response(&[]).unwrap().is_empty());
}

// --- error classification ---------------------------------------------------

#[test]
fn auth_error_detected_only_for_401() {
    let e401 = api_error(401, br#"{"message":"bad key"}"#);
    assert!(is_auth_error(&e401));
    assert!(e401.0.contains("bad key"));

    let e500 = api_error(500, b"boom");
    assert!(!is_auth_error(&e500));
    assert_eq!(e500.0, "boom");

    let e404 = api_error(404, b"");
    assert!(!is_auth_error(&e404));
    assert!(e404.0.contains("HTTP 404"));

    // Valid JSON without a `message` falls back to the status message.
    let e400 = api_error(400, br#"{"error":"x"}"#);
    assert!(e400.0.contains("HTTP 400"));
}

// --- live wire (ignored; needs credentials + network) -----------------------

fn live_creds() -> (String, String) {
    let key = std::env::var("MMA_API_KEY")
        .expect("set MMA_API_KEY / MMA_SYNC_TEST_MAP to run the ignored live tests");
    let map = std::env::var("MMA_SYNC_TEST_MAP")
        .expect("set MMA_API_KEY / MMA_SYNC_TEST_MAP to run the ignored live tests");
    (key, map)
}

fn wipe(p: &MapMakingProvider, map: &str) {
    let existing = p.pull(map).unwrap().locations;
    if existing.is_empty() {
        return;
    }
    let mut batch = empty_batch();
    batch.delete = existing;
    let mut commit = |_: &[PushedId]| Ok(());
    p.push(map, &batch, None, &mut commit).unwrap();
    assert!(p.pull(map).unwrap().locations.is_empty());
}

#[test]
#[ignore = "live network; needs MMA_API_KEY + MMA_SYNC_TEST_MAP"]
fn live_pull_decodes_real_map_with_auth_header() {
    let (key, map) = live_creds();
    let p = MapMakingProvider { api_key: key };
    // Succeeds (auth header accepted) and the protobuf decodes without error.
    let snap = p.pull(&map).unwrap();
    println!("live_pull: {} locations", snap.locations.len());
}

#[test]
#[ignore = "live network; needs MMA_API_KEY + MMA_SYNC_TEST_MAP"]
fn live_bad_key_surfaces_auth_error() {
    let (_key, map) = live_creds();
    let p = MapMakingProvider {
        api_key: "definitely-not-a-valid-key".into(),
    };
    // RemoteSnapshot is not Debug, so match rather than unwrap_err.
    match p.pull(&map) {
        Ok(_) => panic!("expected an auth error from an invalid key"),
        Err(err) => assert!(is_auth_error(&err), "expected auth error, got: {}", err.0),
    }
}

#[test]
#[ignore = "live network; needs MMA_API_KEY + MMA_SYNC_TEST_MAP (WRITES to the map)"]
fn live_push_remaps_and_round_trips() {
    let (key, map) = live_creds();
    let p = MapMakingProvider { api_key: key };
    wipe(&p, &map);

    let mut batch = empty_batch();
    batch.create.push((
        1,
        p.materialize(&NormalizedSyncLocation {
            lat: 48.8583701,
            lng: 2.2944813,
            heading: 287.4,
            pitch: -7.2,
            zoom: 1.75,
            ..norm()
        }),
    ));
    batch.create.push((
        2,
        p.materialize(&NormalizedSyncLocation {
            lat: -33.856159,
            lng: -151.215256,
            flags: 2,
            ..norm()
        }),
    ));

    let mut commit = |_: &[PushedId]| Ok(());
    let pushed = p.push(&map, &batch, None, &mut commit).unwrap();
    assert_eq!(pushed.len(), 2);
    // The server assigns real (positive) ids to both placeholders.
    assert!(pushed.iter().all(|x| x.remote_id > 0));
    assert_eq!(
        ids(&pushed).iter().map(|x| x.0).collect::<Vec<_>>(),
        vec![1, 2]
    );

    // Pull back: normalized set equality against what we pushed.
    let pulled = p.pull(&map).unwrap().locations;
    assert_eq!(pulled.len(), 2);
    let mut got: Vec<_> = pulled
        .iter()
        .map(|r| crate::sync::sync_key(&p.normalize(r)))
        .collect();
    let mut want: Vec<_> = batch
        .create
        .iter()
        .map(|(_, item)| crate::sync::sync_key(&p.normalize(item)))
        .collect();
    got.sort();
    want.sort();
    assert_eq!(got, want);

    wipe(&p, &map);
}
