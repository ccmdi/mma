use super::*;
use crate::store::storage::run_migrations_on;
use mma_algebra::Id;

fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    run_migrations_on(&conn).unwrap();
    for id in ["m1", "m2"] {
        conn.execute(
            "INSERT INTO maps (id, name, created_at, updated_at) VALUES (?, ?, '', '')",
            params![id, id],
        )
        .unwrap();
    }
    conn
}

fn ok(started_at: i64, pushed: u32) -> SyncLogEntry {
    SyncLogEntry {
        trigger: SyncTrigger::Live,
        started_at,
        duration_ms: 12,
        result: SyncLogResult::Ok {
            pushed: SideCounts {
                create: pushed,
                update: 0,
                delete: 0,
            },
            pulled: SideCounts::default(),
            adopted: 0,
            conflicts: 0,
        },
    }
}

#[test]
fn lists_a_maps_passes_newest_first_and_round_trips_them() {
    let conn = setup();
    let failed = SyncLogEntry {
        trigger: SyncTrigger::Manual,
        started_at: 30,
        duration_ms: 5,
        result: SyncLogResult::Error {
            message: "auth: signed out".into(),
        },
    };
    append(&conn, "geoguessr", &Id::new("m1".into()), &ok(10, 1)).unwrap();
    append(&conn, "geoguessr", &Id::new("m1".into()), &failed).unwrap();
    append(&conn, "geoguessr", &Id::new("m1".into()), &ok(20, 2)).unwrap();
    assert_eq!(
        list(&conn, "geoguessr", &Id::new("m1".into())).unwrap(),
        vec![failed, ok(20, 2), ok(10, 1)]
    );
}

#[test]
fn keeps_each_map_and_provider_apart() {
    let conn = setup();
    append(&conn, "geoguessr", &Id::new("m1".into()), &ok(1, 1)).unwrap();
    append(&conn, "file", &Id::new("m1".into()), &ok(2, 2)).unwrap();
    append(&conn, "geoguessr", &Id::new("m2".into()), &ok(3, 3)).unwrap();
    assert_eq!(
        list(&conn, "geoguessr", &Id::new("m1".into())).unwrap(),
        vec![ok(1, 1)]
    );
    assert_eq!(
        list(&conn, "file", &Id::new("m1".into())).unwrap(),
        vec![ok(2, 2)]
    );
    assert_eq!(
        list(&conn, "geoguessr", &Id::new("m2".into())).unwrap(),
        vec![ok(3, 3)]
    );
}

#[test]
fn drops_the_oldest_passes_past_the_cap() {
    let conn = setup();
    let over = i64::from(MAX_ENTRIES) + 5;
    for t in 0..over {
        append(&conn, "geoguessr", &Id::new("m1".into()), &ok(t, 0)).unwrap();
    }
    append(&conn, "geoguessr", &Id::new("m2".into()), &ok(0, 0)).unwrap();
    let kept = list(&conn, "geoguessr", &Id::new("m1".into())).unwrap();
    assert_eq!(kept.len(), MAX_ENTRIES as usize);
    assert_eq!(kept.last().unwrap().started_at, 5);
    assert_eq!(
        list(&conn, "geoguessr", &Id::new("m2".into()))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn goes_with_its_map() {
    let conn = setup();
    append(&conn, "geoguessr", &Id::new("m1".into()), &ok(1, 1)).unwrap();
    conn.execute("DELETE FROM maps WHERE id = 'm1'", [])
        .unwrap();
    assert!(list(&conn, "geoguessr", &Id::new("m1".into()))
        .unwrap()
        .is_empty());
}
