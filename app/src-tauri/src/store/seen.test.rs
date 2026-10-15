use super::*;
use crate::store::storage::tests::map_on_disk;
use mma_algebra::Id;
use std::string::ToString;
use std::sync::{Mutex, MutexGuard, Once, PoisonError};
use tauri::async_runtime::block_on;

/// The seen table on disk, emptied and held for the caller alone: the history is one table
/// every test here reads whole.
fn history() -> MutexGuard<'static, ()> {
    static HISTORY: Mutex<()> = Mutex::new(());
    static DISK: Once = Once::new();
    let held = HISTORY.lock().unwrap_or_else(PoisonError::into_inner);
    DISK.call_once(|| {
        map_on_disk("seen-history");
    });
    block_on(store_seen_clear()).unwrap();
    held
}

fn write(entry: SeenWriteEntry) -> AppResult<()> {
    block_on(store_seen_write(entry))
}

fn list(
    limit: u32,
    offset: u32,
    filter: Option<SeenFilter>,
    thumbnails: bool,
) -> AppResult<SeenPage> {
    block_on(store_seen_list(limit, offset, filter, thumbnails))
}

fn mk(pano_id: &str, entered_at: i64) -> SeenWriteEntry {
    SeenWriteEntry {
        pano_id: pano_id.into(),
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 1.0,
        entered_at,
        map_id: None,
        location_id: None,
        country_code: None,
        address: None,
        thumbnail: None,
    }
}

#[test]
fn write_then_read_back() {
    let _history = history();
    let entry = SeenWriteEntry {
        pano_id: "abc123".into(),
        lat: 51.5,
        lng: -0.12,
        heading: 90.0,
        pitch: 5.0,
        zoom: 2.0,
        entered_at: 1700000000,
        map_id: Some(Id::new("map1".into())),
        location_id: Some(Id::new(42)),
        country_code: Some("GB".into()),
        address: Some("London, UK".into()),
        thumbnail: Some("data:image/png;base64,abc".into()),
    };
    write(entry).unwrap();

    let entries = list(10, 0, None, true).unwrap().entries;
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.pano_id, "abc123");
    assert!((e.lat - 51.5).abs() < 1e-10);
    assert!((e.lng - (-0.12)).abs() < 1e-10);
    assert!((e.heading - 90.0).abs() < 1e-10);
    assert!((e.pitch - 5.0).abs() < 1e-10);
    assert!((e.zoom - 2.0).abs() < 1e-10);
    assert_eq!(e.entered_at, 1700000000);
    assert_eq!(e.map_id.as_ref().map(|id| id.raw().as_str()), Some("map1"));
    assert_eq!(e.location_id, Some(Id::new(42)));
    assert_eq!(e.country_code.as_deref(), Some("GB"));
    assert_eq!(e.address.as_deref(), Some("London, UK"));
    assert_eq!(e.thumbnail.as_deref(), Some("data:image/png;base64,abc"));

    let no_thumb = list(10, 0, None, false).unwrap().entries;
    assert!(no_thumb[0].thumbnail.is_none());
}

#[test]
fn eviction_caps_at_max_seen() {
    let _history = history();
    let mut conn = storage::open_db().unwrap();
    let tx = conn.transaction().unwrap();
    for i in 0..MAX_SEEN {
        tx.execute(
            "INSERT INTO seen (pano_id, lat, lng, heading, pitch, zoom, entered_at) VALUES (?1, 0, 0, 0, 0, 1, ?2)",
            rusqlite::params![format!("pano_{i}"), i],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    write(mk(&format!("pano_{MAX_SEEN}"), MAX_SEEN)).unwrap();
    assert_eq!(i64::from(list(0, 0, None, false).unwrap().total), MAX_SEEN);

    let newest = list(1, 0, None, false).unwrap().entries;
    assert_eq!(newest[0].pano_id, format!("pano_{MAX_SEEN}"));

    let oldest = list(1, (MAX_SEEN - 1) as u32, None, false).unwrap().entries;
    assert_eq!(oldest[0].entered_at, 1);
}

#[test]
fn pagination_limit_and_offset() {
    let _history = history();
    for i in 0..25i64 {
        write(mk(&format!("p{i}"), i)).unwrap();
    }

    let page1 = list(10, 0, None, false).unwrap().entries;
    assert_eq!(page1.len(), 10);
    assert_eq!(page1[0].entered_at, 24);
    assert_eq!(page1[9].entered_at, 15);

    let page2 = list(10, 10, None, false).unwrap().entries;
    assert_eq!(page2.len(), 10);
    assert_eq!(page2[0].entered_at, 14);
    assert_eq!(page2[9].entered_at, 5);

    let page3 = list(10, 20, None, false).unwrap().entries;
    assert_eq!(page3.len(), 5);
    assert_eq!(page3[0].entered_at, 4);
    assert_eq!(page3[4].entered_at, 0);
}

#[test]
fn filter_by_map_id() {
    let _history = history();
    for i in 0..5i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some(Id::new("mapA".into()));
        write(e).unwrap();
    }
    for i in 5..8i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some(Id::new("mapB".into()));
        write(e).unwrap();
    }

    let filter = SeenFilter {
        map_id: Some(Id::new("mapA".into())),
        ..Default::default()
    };
    let results = list(100, 0, Some(filter), false).unwrap().entries;
    assert_eq!(results.len(), 5);
    assert!(results
        .iter()
        .all(|e| e.map_id.as_ref().map(|id| id.raw().as_str()) == Some("mapA")));
}

#[test]
fn search_matches_address_substring() {
    let _history = history();
    let addresses = [
        "London, UK",
        "New York, USA",
        "London Bridge, UK",
        "Paris, France",
    ];
    for (i, addr) in addresses.iter().enumerate() {
        let mut e = mk(&format!("p{i}"), i as i64);
        e.address = Some(addr.to_string());
        write(e).unwrap();
    }

    let filter = SeenFilter {
        search: Some("London".into()),
        ..Default::default()
    };
    let results = list(100, 0, Some(filter), false).unwrap().entries;
    assert_eq!(results.len(), 2);
    assert!(results
        .iter()
        .all(|e| e.address.as_ref().unwrap().contains("London")));
}

#[test]
fn search_does_not_escape_sql_wildcards() {
    let _history = history();

    let mut e1 = mk("p1", 1);
    e1.address = Some("100% organic".into());
    write(e1).unwrap();

    let mut e2 = mk("p2", 2);
    e2.address = Some("fully organic".into());
    write(e2).unwrap();

    // "%" is not escaped: LIKE pattern becomes "%%%" which matches all non-NULL addresses.
    let filter = SeenFilter {
        search: Some("%".into()),
        ..Default::default()
    };
    let results = list(100, 0, Some(filter), false).unwrap().entries;
    assert_eq!(results.len(), 2);

    let mut e3 = mk("p3", 3);
    e3.address = Some("a_b".into());
    write(e3).unwrap();

    let mut e4 = mk("p4", 4);
    e4.address = Some("axb".into());
    write(e4).unwrap();

    // "_" is not escaped: LIKE pattern becomes "%a_b%" where _ matches any single char.
    let filter2 = SeenFilter {
        search: Some("a_b".into()),
        ..Default::default()
    };
    let results2 = list(100, 0, Some(filter2), false).unwrap().entries;
    assert_eq!(results2.len(), 2);
}

#[test]
fn total_counts_every_match_whatever_the_page() {
    let _history = history();
    for i in 0..5i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some(Id::new("mapA".into()));
        write(e).unwrap();
    }
    for i in 5..8i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some(Id::new("mapB".into()));
        write(e).unwrap();
    }

    assert_eq!(list(0, 0, None, false).unwrap().total, 8);
    let page = list(2, 7, None, false).unwrap();
    assert_eq!((page.entries.len(), page.total), (1, 8));
    assert!(list(0, 0, None, false).unwrap().entries.is_empty());

    let f_a = SeenFilter {
        map_id: Some(Id::new("mapA".into())),
        ..Default::default()
    };
    assert_eq!(list(0, 0, Some(f_a), false).unwrap().total, 5);

    let f_b = SeenFilter {
        map_id: Some(Id::new("mapB".into())),
        ..Default::default()
    };
    assert_eq!(list(0, 0, Some(f_b), false).unwrap().total, 3);
}

#[test]
fn countries_returns_distinct_sorted_codes() {
    let _history = history();
    let codes: [Option<&str>; 6] = [
        Some("US"),
        Some("GB"),
        Some("US"),
        Some("FR"),
        None,
        Some("GB"),
    ];
    for (i, cc) in codes.iter().enumerate() {
        let mut e = mk(&format!("p{i}"), i as i64);
        e.country_code = cc.map(ToString::to_string);
        write(e).unwrap();
    }

    let result = block_on(store_seen_countries()).unwrap();
    assert_eq!(result, vec!["FR", "GB", "US"]);
}

#[test]
fn filter_by_location_ids_since() {
    let _history = history();
    for (pano, location, entered_at) in [
        ("a", 1, 5),
        ("b", 1, 20),
        ("c", 2, 30),
        ("d", 3, 40),
        ("e", 2, 10),
    ] {
        let mut e = mk(pano, entered_at);
        e.location_id = Some(Id::new(location));
        write(e).unwrap();
    }

    let filter = SeenFilter {
        location_ids: Some(vec![Id::new(1), Id::new(2)]),
        since: Some(15),
        ..Default::default()
    };
    let panos: Vec<String> = list(100, 0, Some(filter), false)
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.pano_id)
        .collect();
    assert_eq!(panos, vec!["c", "b"]);

    let none = SeenFilter {
        location_ids: Some(vec![]),
        ..Default::default()
    };
    assert_eq!(list(0, 0, Some(none), false).unwrap().total, 0);
}
