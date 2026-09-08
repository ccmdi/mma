use super::*;
use rusqlite::Connection;

fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE maps (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '');
         CREATE TABLE seen (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pano_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            heading REAL NOT NULL,
            pitch REAL NOT NULL,
            zoom REAL NOT NULL,
            entered_at INTEGER NOT NULL,
            map_id TEXT,
            location_id INTEGER,
            country_code TEXT,
            address TEXT,
            thumbnail TEXT
         );
         CREATE INDEX idx_seen_entered ON seen(entered_at DESC);
         CREATE INDEX idx_seen_country ON seen(country_code);
         CREATE INDEX idx_seen_map ON seen(map_id);",
    )
    .unwrap();
    conn
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
    let conn = setup();
    let entry = SeenWriteEntry {
        pano_id: "abc123".into(),
        lat: 51.5,
        lng: -0.12,
        heading: 90.0,
        pitch: 5.0,
        zoom: 2.0,
        entered_at: 1700000000,
        map_id: Some("map1".into()),
        location_id: Some(42),
        country_code: Some("GB".into()),
        address: Some("London, UK".into()),
        thumbnail: Some("data:image/png;base64,abc".into()),
    };
    write(&conn, entry).unwrap();

    let entries = list(&conn, 10, 0, None, true).unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    assert_eq!(e.pano_id, "abc123");
    assert!((e.lat - 51.5).abs() < 1e-10);
    assert!((e.lng - (-0.12)).abs() < 1e-10);
    assert!((e.heading - 90.0).abs() < 1e-10);
    assert!((e.pitch - 5.0).abs() < 1e-10);
    assert!((e.zoom - 2.0).abs() < 1e-10);
    assert_eq!(e.entered_at, 1700000000);
    assert_eq!(e.map_id.as_deref(), Some("map1"));
    assert_eq!(e.location_id, Some(42));
    assert_eq!(e.country_code.as_deref(), Some("GB"));
    assert_eq!(e.address.as_deref(), Some("London, UK"));
    assert_eq!(e.thumbnail.as_deref(), Some("data:image/png;base64,abc"));

    let no_thumb = list(&conn, 10, 0, None, false).unwrap();
    assert!(no_thumb[0].thumbnail.is_none());
}

#[test]
fn eviction_caps_at_max_seen() {
    let conn = setup();
    for i in 0..=MAX_SEEN {
        write(&conn, mk(&format!("pano_{i}"), i)).unwrap();
    }
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM seen", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, MAX_SEEN);

    let newest = list(&conn, 1, 0, None, false).unwrap();
    assert_eq!(newest[0].pano_id, format!("pano_{MAX_SEEN}"));

    let oldest = list(&conn, 1, (MAX_SEEN - 1) as u32, None, false).unwrap();
    assert_eq!(oldest[0].entered_at, 1);
}

#[test]
fn pagination_limit_and_offset() {
    let conn = setup();
    for i in 0..25i64 {
        write(&conn, mk(&format!("p{i}"), i)).unwrap();
    }

    let page1 = list(&conn, 10, 0, None, false).unwrap();
    assert_eq!(page1.len(), 10);
    assert_eq!(page1[0].entered_at, 24);
    assert_eq!(page1[9].entered_at, 15);

    let page2 = list(&conn, 10, 10, None, false).unwrap();
    assert_eq!(page2.len(), 10);
    assert_eq!(page2[0].entered_at, 14);
    assert_eq!(page2[9].entered_at, 5);

    let page3 = list(&conn, 10, 20, None, false).unwrap();
    assert_eq!(page3.len(), 5);
    assert_eq!(page3[0].entered_at, 4);
    assert_eq!(page3[4].entered_at, 0);
}

#[test]
fn filter_by_map_id() {
    let conn = setup();
    for i in 0..5i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some("mapA".into());
        write(&conn, e).unwrap();
    }
    for i in 5..8i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some("mapB".into());
        write(&conn, e).unwrap();
    }

    let filter = SeenFilter {
        map_id: Some("mapA".into()),
        ..Default::default()
    };
    let results = list(&conn, 100, 0, Some(filter), false).unwrap();
    assert_eq!(results.len(), 5);
    assert!(results
        .iter()
        .all(|e| e.map_id.as_deref() == Some("mapA")));
}

#[test]
fn search_matches_address_substring() {
    let conn = setup();
    let addresses = [
        "London, UK",
        "New York, USA",
        "London Bridge, UK",
        "Paris, France",
    ];
    for (i, addr) in addresses.iter().enumerate() {
        let mut e = mk(&format!("p{i}"), i as i64);
        e.address = Some(addr.to_string());
        write(&conn, e).unwrap();
    }

    let filter = SeenFilter {
        search: Some("London".into()),
        ..Default::default()
    };
    let results = list(&conn, 100, 0, Some(filter), false).unwrap();
    assert_eq!(results.len(), 2);
    assert!(results
        .iter()
        .all(|e| e.address.as_ref().unwrap().contains("London")));
}

#[test]
fn search_does_not_escape_sql_wildcards() {
    let conn = setup();

    let mut e1 = mk("p1", 1);
    e1.address = Some("100% organic".into());
    write(&conn, e1).unwrap();

    let mut e2 = mk("p2", 2);
    e2.address = Some("fully organic".into());
    write(&conn, e2).unwrap();

    // "%" is not escaped: LIKE pattern becomes "%%%" which matches all non-NULL addresses.
    let filter = SeenFilter {
        search: Some("%".into()),
        ..Default::default()
    };
    let results = list(&conn, 100, 0, Some(filter), false).unwrap();
    assert_eq!(results.len(), 2);

    let mut e3 = mk("p3", 3);
    e3.address = Some("a_b".into());
    write(&conn, e3).unwrap();

    let mut e4 = mk("p4", 4);
    e4.address = Some("axb".into());
    write(&conn, e4).unwrap();

    // "_" is not escaped: LIKE pattern becomes "%a_b%" where _ matches any single char.
    let filter2 = SeenFilter {
        search: Some("a_b".into()),
        ..Default::default()
    };
    let results2 = list(&conn, 100, 0, Some(filter2), false).unwrap();
    assert_eq!(results2.len(), 2);
}

#[test]
fn count_with_and_without_filter() {
    let conn = setup();
    for i in 0..5i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some("mapA".into());
        write(&conn, e).unwrap();
    }
    for i in 5..8i64 {
        let mut e = mk(&format!("p{i}"), i);
        e.map_id = Some("mapB".into());
        write(&conn, e).unwrap();
    }

    assert_eq!(count(&conn, None).unwrap(), 8);

    let f_a = SeenFilter {
        map_id: Some("mapA".into()),
        ..Default::default()
    };
    assert_eq!(count(&conn, Some(f_a)).unwrap(), 5);

    let f_b = SeenFilter {
        map_id: Some("mapB".into()),
        ..Default::default()
    };
    assert_eq!(count(&conn, Some(f_b)).unwrap(), 3);
}

#[test]
fn countries_returns_distinct_sorted_codes() {
    let conn = setup();
    let codes: [Option<&str>; 6] =
        [Some("US"), Some("GB"), Some("US"), Some("FR"), None, Some("GB")];
    for (i, cc) in codes.iter().enumerate() {
        let mut e = mk(&format!("p{i}"), i as i64);
        e.country_code = cc.map(|s| s.to_string());
        write(&conn, e).unwrap();
    }

    let result = countries(&conn).unwrap();
    assert_eq!(result, vec!["FR", "GB", "US"]);
}
