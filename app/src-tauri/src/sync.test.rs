use super::*;
use crate::sync::SyncLocalPin;
use crate::types::{Location, LocationFlags};

fn norm(over: impl FnOnce(&mut NormalizedSyncLocation)) -> NormalizedSyncLocation {
    let mut n = NormalizedSyncLocation {
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
    };
    over(&mut n);
    n
}

#[test]
fn sync_key_distinguishes_every_contract_field() {
    let base = norm(|_| {});
    let variants = [
        norm(|n| n.lat = 1.0),
        norm(|n| n.lng = 1.0),
        norm(|n| n.heading = 1.0),
        norm(|n| n.pitch = 1.0),
        norm(|n| n.zoom = 1.0),
        norm(|n| n.pano_id = Some("p".into())),
        norm(|n| n.flags = 1),
        norm(|n| n.tags = vec!["a".into()]),
    ];
    for v in &variants {
        assert_ne!(sync_key(&base), sync_key(v));
    }
}

#[test]
fn sync_hash_is_deterministic_and_compact() {
    let n = norm(|n| {
        n.lat = 51.5007;
        n.lng = -0.1246;
        n.pano_id = Some("OhCEnVaJyDMAAAQZLBEJPQ".into());
        n.tags = vec!["a".into(), "b".into()];
    });
    let h = sync_hash(&n);
    assert_eq!(h, sync_hash(&n.clone()));
    assert!(h.len() <= 11, "cyrb53 in radix36 fits 11 chars, got {h}");
    assert!(h
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
}

#[test]
fn local_keys_round_trip() {
    assert_eq!(local_key(42), "L:42");
    assert_eq!(parse_local_key("L:42"), Some(42));
    assert_eq!(parse_local_key("C:abc#0"), None);
}

#[test]
fn canon_tags_dedupes_and_sorts() {
    let tags = canon_tags(vec!["b".to_string(), "a".to_string(), "b".to_string()]);
    assert_eq!(tags, vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn local_to_normalized_strips_virtual_flags_and_resolves_tags() {
    let loc = Location {
        id: 7,
        lat: 1.0,
        lng: 2.0,
        heading: 3.0,
        pitch: 4.0,
        zoom: 5.0,
        pano_id: Some("p".into()),
        // 12 = the JS-side virtual bits (ImportPreview | SeenOverlay); undeclared here, so stripped.
        flags: LocationFlags::from_bits_retain(1 | 12),
        tags: vec![10, 11, 99],
        extra: None,
        created_at: 0,
        modified_at: None,
    };
    let name = |id: u32| match id {
        10 => Some("zeta".to_string()),
        11 => Some("alpha".to_string()),
        _ => None, // unknown ids are dropped
    };
    // Through the From impl deliberately: the snapshot path converts Location -> SyncLocalPin.
    let n = local_to_normalized(&SyncLocalPin::from(loc), &name);
    assert_eq!(n.flags, 1);
    assert_eq!(n.tags, vec!["alpha".to_string(), "zeta".to_string()]);
    assert_eq!(n.pano_id.as_deref(), Some("p"));
}
