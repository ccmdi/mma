use super::*;
use rusqlite::Connection;

fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE remote_mapping (
            provider   TEXT    NOT NULL,
            map_id     TEXT    NOT NULL,
            local_id   INTEGER NOT NULL,
            remote_id  INTEGER NOT NULL,
            hash       TEXT    NOT NULL,
            PRIMARY KEY (provider, map_id, local_id)
         );",
    )
    .unwrap();
    conn
}

fn row(local_id: u32, remote_id: i64, hash: &str) -> RemoteMappingRow {
    RemoteMappingRow { local_id, remote_id, hash: hash.into() }
}

const P: &str = "map-making.app";

#[test]
fn upsert_then_get_round_trips() {
    let mut conn = setup();
    upsert(&mut conn, P, "map-a", &[row(1, 1000, "h1"), row(2, 2000, "h2")]).unwrap();
    let mut got = get(&conn, P, "map-a").unwrap();
    got.sort_by_key(|r| r.local_id);
    assert_eq!(got.len(), 2);
    assert_eq!(got[1].remote_id, 2000);
    assert_eq!(got[1].hash, "h2");
}

#[test]
fn upsert_updates_remote_id_and_hash_on_conflict() {
    let mut conn = setup();
    upsert(&mut conn, P, "map-a", &[row(1, 1000, "h1")]).unwrap();
    // local id 1 modified remotely -> new remote id + new hash, same local id
    upsert(&mut conn, P, "map-a", &[row(1, 1500, "h1b")]).unwrap();
    let got = get(&conn, P, "map-a").unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].remote_id, 1500);
    assert_eq!(got[0].hash, "h1b");
}

#[test]
fn delete_removes_only_named_rows() {
    let mut conn = setup();
    upsert(&mut conn, P, "map-a", &[row(1, 10, "a"), row(2, 20, "b"), row(3, 30, "c")]).unwrap();
    delete(&mut conn, P, "map-a", &[2]).unwrap();
    let mut got = get(&conn, P, "map-a").unwrap();
    got.sort_by_key(|r| r.local_id);
    assert_eq!(got.iter().map(|r| r.local_id).collect::<Vec<_>>(), vec![1, 3]);
}

#[test]
fn scoped_by_provider_and_map() {
    let mut conn = setup();
    upsert(&mut conn, P, "map-a", &[row(1, 10, "a")]).unwrap();
    upsert(&mut conn, P, "map-b", &[row(9, 90, "z")]).unwrap();
    upsert(&mut conn, "geoguessr", "map-a", &[row(1, 77, "g")]).unwrap();

    assert_eq!(get(&conn, P, "map-a").unwrap().len(), 1);
    assert_eq!(get(&conn, P, "map-a").unwrap()[0].remote_id, 10);
    assert_eq!(get(&conn, "geoguessr", "map-a").unwrap()[0].remote_id, 77);

    clear(&conn, P, "map-a").unwrap();
    assert!(get(&conn, P, "map-a").unwrap().is_empty());
    assert_eq!(get(&conn, P, "map-b").unwrap().len(), 1); // other map untouched
    assert_eq!(get(&conn, "geoguessr", "map-a").unwrap().len(), 1); // other provider untouched
}
