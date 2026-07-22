use super::*;
use crate::sync::sync_key;

// --- fixtures ---------------------------------------------------------------

fn pin() -> GgCoordinate {
    GgCoordinate {
        lat: 1.5,
        lng: 2.5,
        heading: 3.5,
        pitch: 4.5,
        zoom: 5.5,
        pano_id: None,
        country_code: None,
        state_code: None,
        city_code: None,
    }
}

fn many(n: usize, over: impl Fn(&mut GgCoordinate)) -> Vec<GgCoordinate> {
    (0..n)
        .map(|_| {
            let mut c = pin();
            over(&mut c);
            c
        })
        .collect()
}

const PANO_22: &str = "OhCEnVaJyDMAAAQZLBEJPQ";
const LIMIT: usize = 16_777_216;

fn with_codes(c: &mut GgCoordinate) {
    c.country_code = Some("fr".into());
    c.state_code = Some("fr-idf".into());
    c.city_code = Some("paris".into());
}

fn with_pano(c: &mut GgCoordinate) {
    c.pano_id = Some(PANO_22.into());
}

// --- storedBsonSize (ported verbatim from geoguessrProvider.test.ts) --------

#[test]
fn sizes_the_empty_array_as_a_bare_bson_document() {
    assert_eq!(stored_bson_size(&[]), 5);
}

#[test]
fn prices_null_geocode_at_zero_and_null_pano_at_its_stored_element() {
    let mut null_codes = pin();
    null_codes.country_code = None;
    null_codes.state_code = None;
    null_codes.city_code = None;
    assert_eq!(stored_bson_size(&[null_codes]), stored_bson_size(&[pin()]));

    let mut empty_pano = pin();
    empty_pano.pano_id = Some(String::new());
    assert_eq!(
        stored_bson_size(&[empty_pano]),
        stored_bson_size(&[pin()]) + 5
    );
}

#[test]
fn reproduces_measured_flip_for_bare_pins() {
    assert_eq!(stored_bson_size(&many(181_591, |_| {})), 16_776_858);
    assert_eq!(stored_bson_size(&many(181_592, |_| {})), 16_776_951);
}

#[test]
fn reproduces_measured_flip_for_pano_pins() {
    assert_eq!(stored_bson_size(&many(140_733, with_pano)), 16_776_855);
    assert_eq!(stored_bson_size(&many(140_734, with_pano)), 16_776_975);
}

#[test]
fn reproduces_measured_flip_bracket_for_geocoded_pins() {
    assert_eq!(stored_bson_size(&many(108_954, with_codes)), 16_776_765);
    assert_eq!(stored_bson_size(&many(108_956, with_codes)), 16_777_075);
}

#[test]
fn every_accept_stays_under_and_every_reject_over_given_the_overhead() {
    // The per-draft metadata overhead interval the flips bracket; both ends must separate them.
    for overhead in [266usize, 358] {
        assert!(stored_bson_size(&many(181_591, |_| {})) + overhead <= LIMIT);
        assert!(stored_bson_size(&many(181_592, |_| {})) + overhead > LIMIT);
        assert!(stored_bson_size(&many(140_733, with_pano)) + overhead <= LIMIT);
        assert!(stored_bson_size(&many(140_734, with_pano)) + overhead > LIMIT);
    }
}

// --- normalize / materialize / project --------------------------------------

fn norm(over: impl FnOnce(&mut NormalizedSyncLocation)) -> NormalizedSyncLocation {
    let mut n = NormalizedSyncLocation {
        lat: 48.8584,
        lng: 2.2945,
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

fn provider() -> GeoGuessrProvider {
    GeoGuessrProvider {
        ncfa: "test".into(),
    }
}

#[test]
fn materialize_nudges_north_and_normalize_undoes_it() {
    let p = provider();
    let source = norm(|n| n.heading = 0.0);
    let coord = p.materialize(&source);
    assert_eq!(coord.heading, NORTH);
    assert_eq!(sync_key(&p.normalize(&coord)), sync_key(&source));
}

#[test]
fn materialize_leaves_a_real_heading_untouched() {
    let p = provider();
    let source = norm(|n| n.heading = 137.5);
    let coord = p.materialize(&source);
    assert_eq!(coord.heading, 137.5);
    assert_eq!(sync_key(&p.normalize(&coord)), sync_key(&source));
}

#[test]
fn round_trips_a_pano_when_loading_by_pano() {
    let p = provider();
    let source = norm(|n| {
        n.pano_id = Some(PANO_22.into());
        n.flags = LOAD_AS_PANO_ID;
        n.heading = 90.0;
    });
    let coord = p.materialize(&source);
    assert_eq!(coord.pano_id.as_deref(), Some(PANO_22));
    assert_eq!(sync_key(&p.normalize(&coord)), sync_key(&source));
}

#[test]
fn project_erases_pano_when_load_as_pano_unset() {
    let p = provider();
    // A stored panoId without the LoadAsPanoId flag cannot be expressed: project drops it.
    let projected = p.project(norm(|n| {
        n.pano_id = Some(PANO_22.into());
        n.flags = 0;
    }));
    assert_eq!(projected.pano_id, None);
    assert_eq!(projected.flags, 0);
}

#[test]
fn project_is_idempotent_and_strips_tags() {
    let p = provider();
    let once = p.project(norm(|n| {
        n.pano_id = Some(PANO_22.into());
        n.flags = LOAD_AS_PANO_ID;
        n.tags = vec!["a".into(), "b".into()];
    }));
    assert!(once.tags.is_empty());
    assert_eq!(once.flags, LOAD_AS_PANO_ID);
    assert_eq!(sync_key(&once), sync_key(&p.project(once.clone())));
}

#[test]
fn materialize_drops_pano_when_flag_absent() {
    let p = provider();
    let coord = p.materialize(&norm(|n| {
        n.pano_id = Some(PANO_22.into());
        n.flags = 0;
    }));
    assert_eq!(coord.pano_id, None);
}

#[test]
fn normalize_treats_empty_pano_as_no_pano() {
    let p = provider();
    let mut coord = pin();
    coord.pano_id = Some(String::new());
    let n = p.normalize(&coord);
    assert_eq!(n.pano_id, None);
    assert_eq!(n.flags, 0);
}

// --- include_local ----------------------------------------------------------

fn location(flags: LocationFlags) -> SyncLocalPin {
    SyncLocalPin {
        id: 1,
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: flags.bits(),
        tags: vec![],
    }
}

#[test]
fn include_local_excludes_informational_pins() {
    let p = provider();
    assert!(p.include_local(&location(LocationFlags::empty())));
    assert!(p.include_local(&location(LocationFlags::LOAD_AS_PANO_ID)));
    assert!(!p.include_local(&location(LocationFlags::INFORMATIONAL)));
    assert!(!p.include_local(&location(
        LocationFlags::INFORMATIONAL | LocationFlags::LOAD_AS_PANO_ID
    )));
}

// --- push body shape (pure, no network) -------------------------------------

#[test]
fn write_body_names_custom_coordinates_and_bumps_version() {
    let body = write_body(vec![pin()], 41);
    let json = serde_json::to_value(&body).unwrap();
    assert_eq!(json["mode"], "coordinates");
    assert_eq!(json["version"], 42);
    assert!(json.get("customCoordinates").is_some());
    assert!(json.get("coordinates").is_none());
    assert_eq!(json["customCoordinates"].as_array().unwrap().len(), 1);
}

#[test]
fn write_body_serializes_null_pano_and_omits_absent_codes() {
    let body = write_body(vec![pin()], 0);
    let coord = &serde_json::to_value(&body).unwrap()["customCoordinates"][0];
    // panoId is always present, as an explicit null.
    assert!(coord.as_object().unwrap().contains_key("panoId"));
    assert!(coord["panoId"].is_null());
    // Absent geocode codes are omitted entirely.
    assert!(coord.get("countryCode").is_none());
    assert!(coord.get("stateCode").is_none());
    assert!(coord.get("cityCode").is_none());
}

#[test]
fn write_body_serializes_present_codes_and_pano() {
    let mut c = pin();
    with_pano(&mut c);
    with_codes(&mut c);
    let body = write_body(vec![c], 0);
    let coord = &serde_json::to_value(&body).unwrap()["customCoordinates"][0];
    assert_eq!(coord["panoId"], PANO_22);
    assert_eq!(coord["countryCode"], "fr");
    assert_eq!(coord["stateCode"], "fr-idf");
    assert_eq!(coord["cityCode"], "paris");
}

#[test]
fn gg_coordinate_deserializes_null_and_absent_codes_alike() {
    let with_null: GgCoordinate = serde_json::from_str(
        r#"{"lat":1,"lng":2,"heading":3,"pitch":4,"zoom":5,"panoId":null,"countryCode":null}"#,
    )
    .unwrap();
    assert_eq!(with_null.country_code, None);
    assert_eq!(with_null.pano_id, None);

    // Unknown per-coordinate fields (e.g. a local id) are ignored, matching the server strip.
    let with_extra: GgCoordinate = serde_json::from_str(
        r#"{"lat":1,"lng":2,"heading":3,"pitch":4,"zoom":5,"panoId":"p","extra":{"mmaId":7}}"#,
    )
    .unwrap();
    assert_eq!(with_extra.pano_id.as_deref(), Some("p"));
}

// --- error classification ---------------------------------------------------

#[test]
fn classifies_auth_and_version_conflict_errors() {
    assert!(is_auth_error(&http_error("read", 401)));
    assert!(!is_auth_error(&http_error("read", 409)));
    assert!(is_version_conflict(&http_error("write", 409)));
    assert!(is_version_conflict(&http_error("write", 412)));
    assert!(!is_version_conflict(&http_error("write", 401)));
}

#[test]
fn from_session_reads_the_stored_ncfa() {
    storage::secret::set("geoguessr", "cookie-value").unwrap();
    assert_eq!(
        GeoGuessrProvider::from_session().unwrap().ncfa,
        "cookie-value"
    );
    storage::secret::delete("geoguessr").unwrap();
    assert!(GeoGuessrProvider::from_session().is_err());
}

// ---------------------------------------------------------------------------
// Live wire-contract tests. Real, mutating: they overwrite the coordinate list of the
// sacrificial draft at GG_SYNC_TEST_MAP repeatedly. Gated on credentials, ignored by default.
// The session token is never printed, logged, or included in a failure message.
// Run with --test-threads=1: they all mutate ONE draft, and parallel read-modify-write races
// the version counter (nine spurious failures, none reproducible serially).
// ---------------------------------------------------------------------------

mod live {
    use super::*;
    use crate::sync::DesiredEntry;

    fn creds() -> (String, String) {
        let ncfa = std::env::var("GG_NCFA")
            .expect("GG_NCFA (a _ncfa session cookie) is required for the live GeoGuessr tests");
        let map = std::env::var("GG_SYNC_TEST_MAP").expect(
            "GG_SYNC_TEST_MAP (a throwaway draft slug) is required; its coordinates are WIPED",
        );
        (ncfa, map)
    }

    fn get_draft(ncfa: &str, map: &str) -> serde_json::Value {
        let url = upstream_url(&format!("api/v4/user-maps/drafts/{map}"), None);
        let mut req = crate::proxy_client().get(&url);
        for (k, v) in proxy_headers(ncfa, None) {
            req = req.header(k, v);
        }
        let resp = req.send().expect("draft GET");
        assert!(
            resp.status().is_success(),
            "draft GET -> HTTP {}",
            resp.status().as_u16()
        );
        resp.json().expect("draft decode")
    }

    /// PUT an arbitrary write body; returns the raw response so callers can assert on failures.
    fn put_body(ncfa: &str, map: &str, body: &serde_json::Value) -> reqwest::blocking::Response {
        let url = upstream_url(&format!("api/v4/user-maps/drafts/{map}"), None);
        let bytes = serde_json::to_vec(body).unwrap();
        let mut req = crate::proxy_client().put(&url).body(bytes);
        for (k, v) in proxy_headers(ncfa, Some("application/json")) {
            req = req.header(k, v);
        }
        req.send().expect("draft PUT")
    }

    /// PUT `coords` at an exact `version` (no implicit +1).
    fn put_coords(
        ncfa: &str,
        map: &str,
        coords: &[GgCoordinate],
        version: i64,
    ) -> reqwest::blocking::Response {
        let body = GgDraftWrite {
            mode: "coordinates".into(),
            version,
            custom_coordinates: coords.to_vec(),
        };
        put_body(ncfa, map, &serde_json::to_value(&body).unwrap())
    }

    /// Write `coords` at the next version and return the resulting draft JSON.
    fn write(ncfa: &str, map: &str, coords: &[GgCoordinate]) -> serde_json::Value {
        let version = get_draft(ncfa, map)["version"].as_i64().unwrap();
        let resp = put_coords(ncfa, map, coords, version + 1);
        assert!(
            resp.status().is_success(),
            "draft PUT -> HTTP {}",
            resp.status().as_u16()
        );
        get_draft(ncfa, map)
    }

    fn london() -> GgCoordinate {
        GgCoordinate {
            lat: 51.5007,
            lng: -0.1246,
            heading: 137.5,
            pitch: -3.0,
            zoom: 1.25,
            pano_id: None,
            country_code: None,
            state_code: None,
            city_code: None,
        }
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn reads_coordinates_writes_custom_coordinates() {
        let (ncfa, map) = creds();
        let draft = write(&ncfa, &map, &[london()]);
        assert_eq!(draft["coordinates"].as_array().unwrap().len(), 1);
        assert!(draft.get("customCoordinates").is_none());
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn round_trips_the_contract_without_drift() {
        let (ncfa, map) = creds();
        let src = london();
        let draft = write(&ncfa, &map, &[src.clone()]);
        let got = &draft["coordinates"][0];
        assert!((got["lat"].as_f64().unwrap() - src.lat).abs() < 1e-6);
        assert!((got["lng"].as_f64().unwrap() - src.lng).abs() < 1e-6);
        assert!((got["heading"].as_f64().unwrap() - src.heading).abs() < 1e-4);
        assert!((got["pitch"].as_f64().unwrap() - src.pitch).abs() < 1e-4);
        assert!((got["zoom"].as_f64().unwrap() - src.zoom).abs() < 1e-4);
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn normalize_of_a_written_pin_matches_the_source() {
        // materialize -> write -> read -> normalize is the identity the whole diff rests on.
        let (ncfa, map) = creds();
        let p = provider();
        let source = norm(|n| n.heading = 0.0); // exercises the 1e-4 north nudge both directions
        let draft = write(&ncfa, &map, &[p.materialize(&source)]);
        let coord: GgCoordinate = serde_json::from_value(draft["coordinates"][0].clone()).unwrap();
        assert_eq!(sync_key(&p.normalize(&coord)), sync_key(&source));
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn keeps_a_pano_when_loading_by_pano() {
        let (ncfa, map) = creds();
        let p = provider();
        let source = norm(|n| {
            n.lat = 51.5007;
            n.lng = -0.1246;
            n.heading = 90.0;
            n.pano_id = Some(PANO_22.into());
            n.flags = LOAD_AS_PANO_ID;
        });
        let draft = write(&ncfa, &map, &[p.materialize(&source)]);
        let coord: GgCoordinate = serde_json::from_value(draft["coordinates"][0].clone()).unwrap();
        assert_eq!(coord.pano_id.as_deref(), Some(PANO_22));
        assert_eq!(sync_key(&p.normalize(&coord)), sync_key(&source));
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn strips_unknown_per_coordinate_fields() {
        let (ncfa, map) = creds();
        let version = get_draft(&ncfa, &map)["version"].as_i64().unwrap();
        let body = serde_json::json!({
            "mode": "coordinates",
            "version": version + 1,
            "customCoordinates": [{
                "lat": 51.5007, "lng": -0.1246, "heading": 137.5, "pitch": -3.0, "zoom": 1.25,
                "panoId": null, "extra": { "mmaId": 12345 }
            }],
        });
        let resp = put_body(&ncfa, &map, &body);
        assert!(
            resp.status().is_success(),
            "draft PUT -> HTTP {}",
            resp.status().as_u16()
        );
        let draft = get_draft(&ncfa, &map);
        assert!(draft["coordinates"][0].get("extra").is_none());
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn preserves_name_and_avatar_across_a_coordinates_only_write() {
        let (ncfa, map) = creds();
        let before = get_draft(&ncfa, &map);
        let mut second = london();
        second.lat = 52.0;
        let after = write(&ncfa, &map, &[london(), second]);
        assert_eq!(after["name"], before["name"]);
        assert_eq!(after["avatar"], before["avatar"]);
        assert_eq!(after["coordinates"].as_array().unwrap().len(), 2);
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn increments_version_by_exactly_one() {
        let (ncfa, map) = creds();
        let before = get_draft(&ncfa, &map)["version"].as_i64().unwrap();
        let after = write(&ncfa, &map, &[london()]);
        assert_eq!(after["version"].as_i64().unwrap(), before + 1);
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn rejects_a_stale_version() {
        // The entire concurrency story: a re-used version must fail rather than clobber.
        let (ncfa, map) = creds();
        let version = get_draft(&ncfa, &map)["version"].as_i64().unwrap();
        let ok = put_coords(&ncfa, &map, &[london()], version + 1); // consumes the version
        assert!(ok.status().is_success());
        let mut moved = london();
        moved.lat = 40.0;
        let stale = put_coords(&ncfa, &map, &[moved], version + 1);
        assert!(!stale.status().is_success(), "stale version was accepted");
    }

    #[test]
    #[ignore = "live network; wipes the sacrificial draft in GG_SYNC_TEST_MAP"]
    fn pushes_a_500_location_batch_through_the_provider() {
        let (ncfa, map) = creds();
        let p = GeoGuessrProvider { ncfa: ncfa.clone() };
        let desired: Vec<DesiredEntry<GgCoordinate>> = (0..500)
            .map(|i| {
                let mut c = london();
                c.lat = 40.0 + i as f64 * 0.001;
                c.lng = -70.0 + i as f64 * 0.001;
                DesiredEntry {
                    item: c,
                    local_id: Some(i as u32),
                }
            })
            .collect();
        let batch = PushBatch {
            create: vec![],
            update: vec![],
            delete: vec![],
            desired,
        };
        let version = get_draft(&ncfa, &map)["version"].as_i64().unwrap();
        let mut committed = 0usize;
        let mut commit = |ids: &[PushedId]| {
            committed = ids.len();
            Ok(())
        };
        let pushed = p
            .push(&map, &batch, Some(version), &mut commit)
            .expect("push 500");
        assert_eq!(pushed.len(), 500);
        assert_eq!(committed, 500);
        assert_eq!(
            get_draft(&ncfa, &map)["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            500
        );
    }
}
