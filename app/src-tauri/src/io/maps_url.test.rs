use super::*;

fn parsed(input: &str) -> ParsedLocation {
    parse(input).expect("parses")
}

#[test]
fn non_urls_and_unsupported_domains_parse_to_nothing() {
    assert_eq!(parse("not a url"), None);
    assert_eq!(parse(""), None);
    assert_eq!(parse("   "), None);
    assert_eq!(parse("https://example.com/maps"), None);
    assert_eq!(parse("https://openstreetmap.org/#map=14/51.5074/-0.1278"), None);
}

#[test]
fn a_pano_viewpoint_url_carries_the_whole_camera() {
    let p = parsed(
        "https://www.google.com/maps?map_action=pano&viewpoint=48.8566,2.3522&heading=90&pitch=-5&pano=CAoSK0FGtest&fov=90",
    );
    assert!((p.lat - 48.8566).abs() < 1e-4);
    assert!((p.lng - 2.3522).abs() < 1e-4);
    assert_eq!(p.heading, 90.0);
    assert_eq!(p.pitch, -5.0);
    assert_eq!(p.pano_id.as_deref(), Some("CAoSK0FGtest"));
    assert_eq!(p.flags, LocationFlags::LOAD_AS_PANO_ID);
}

#[test]
fn a_street_view_path_url_with_a_pano_loads_as_pano_id() {
    let p = parsed(
        "https://www.google.com/maps/@58.6190505,49.7204709,3a,75y,265.69h,98.54t/data=!3m8!1e1!3m6!1sbUp3OlCW2UH3MA4lYMRirQ!2e0!5s20130901T000000!7i13312!8i6656",
    );
    assert_eq!(p.pano_id.as_deref(), Some("bUp3OlCW2UH3MA4lYMRirQ"));
    assert_eq!(p.flags, LocationFlags::LOAD_AS_PANO_ID);
    assert!((p.lat - 58.6190505).abs() < 1e-7);
    assert!((p.heading - 265.69).abs() < 1e-9);
    assert!((p.pitch - (98.54 - 90.0)).abs() < 1e-9);
    assert!((p.zoom - fov_to_zoom(75.0)).abs() < 1e-12);
}

#[test]
fn load_mode_lat_lng_opts_out_of_load_as_pano_id() {
    let p = parsed(
        "https://www.google.com/maps?map_action=pano&viewpoint=48.8566,2.3522&pano=CAoSK0FGtest&extra[loadMode]=latLng",
    );
    assert_eq!(p.pano_id.as_deref(), Some("CAoSK0FGtest"));
    assert_eq!(p.flags, LocationFlags::empty());
}

#[test]
fn a_viewpoint_without_a_pano_is_a_bare_coordinate() {
    let p = parsed("https://www.google.com/maps?map_action=pano&viewpoint=40.7128,-74.006");
    assert!((p.lat - 40.7128).abs() < 1e-4);
    assert!((p.lng + 74.006).abs() < 1e-3);
    assert_eq!(p.pano_id, None);
    assert_eq!(p.flags, LocationFlags::empty());
    assert_eq!(p.heading, 0.0);
    assert_eq!(p.pitch, 0.0);
}

#[test]
fn a_pano_url_missing_its_viewpoint_parses_to_nothing() {
    assert_eq!(parse("https://www.google.com/maps?map_action=pano&heading=90"), None);
}

#[test]
fn the_legacy_cbll_layer_form_is_a_bare_coordinate() {
    let p = parsed("https://www.google.com/maps?layer=c&cbll=51.5074,-0.1278");
    assert!((p.lat - 51.5074).abs() < 1e-4);
    assert!((p.lng + 0.1278).abs() < 1e-4);
    assert_eq!(p.heading, 0.0);
    assert_eq!(p.pano_id, None);
}

#[test]
fn an_arts_and_culture_url_pins_its_pano() {
    let p = parsed(
        "https://artsandculture.google.com/streetview?sv_pid=PANO123&sv_lat=35.6762&sv_lng=139.6503&sv_h=180&s_p=10&sv_z=2",
    );
    assert!((p.lat - 35.6762).abs() < 1e-4);
    assert!((p.lng - 139.6503).abs() < 1e-4);
    assert_eq!(p.heading, 180.0);
    assert_eq!(p.pitch, 10.0);
    assert_eq!(p.pano_id.as_deref(), Some("PANO123"));
    assert_eq!(p.zoom, 2.0);
    assert_eq!(p.flags, LocationFlags::LOAD_AS_PANO_ID);
}

#[test]
fn tags_come_from_the_query_and_the_fragment_owns_them_when_present() {
    let p = parsed(
        "https://www.google.com/maps?map_action=pano&viewpoint=10,20&extra[tags]=Mountains&extra[tags]=Coastal",
    );
    assert_eq!(p.tags, ["Mountains", "Coastal"]);
    let p = parsed("https://www.google.com/maps?map_action=pano&viewpoint=10,20#extra[tags]=FromHash");
    assert_eq!(p.tags, ["FromHash"]);
    let p = parsed("https://www.google.com/maps?map_action=pano&viewpoint=10,20");
    assert!(p.tags.is_empty());
}

#[test]
fn input_whitespace_is_trimmed() {
    assert_eq!(parsed("  https://www.google.com/maps?map_action=pano&viewpoint=10,20  ").lat, 10.0);
}

#[test]
fn a_non_official_street_view_key_becomes_the_encoded_pano_id() {
    let p = parsed(
        "https://www.google.com/maps/@1,2,3a,75y,0h,90t/data=!1sCIHM0ogKEICAgICEm_ixqwE!2e10",
    );
    assert_eq!(p.pano_id.as_deref(), Some("CAoSF0NJSE0wb2dLRUlDQWdJQ0VtX2l4cXdF"));
}

#[test]
fn a_missing_fov_defaults_to_ninety_degrees() {
    let p = parsed("https://www.google.com/maps?map_action=pano&viewpoint=10,20");
    assert_eq!(p.zoom, fov_to_zoom(90.0));
}

// The writer is `app/src/lib/sv/mapsLink.ts`; `app/test/unit/mapsLink.test.ts` pins these
// same strings as its expected output.
// If either side drifts, one of the two suites goes red.
const OFFICIAL_PINNED: &str = "https://www.google.com/maps/@58.6190505,49.7204709,3a,66.3y,265.69h,98.54t/data=!3m5!1e1!3m3!1sbUp3OlCW2UH3MA4lYMRirQ!2e0!6shttps%3A%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fpanoid%3DbUp3OlCW2UH3MA4lYMRirQ%26cb_client%3Dmaps_sv.share%26w%3D900%26h%3D600%26yaw%3D265.69%26pitch%3D-8.54%26thumbfov%3D66?coh=235716&entry=tts";

const UNOFFICIAL_NO_TAGS: &str = "https://www.google.com/maps/@1,2,3a,73.7y,0.00h,90.00t/data=!3m4!1e1!3m2!1sCIHM0ogKEICAgICEm_ixqwE!2e0?coh=235716&entry=tts";

const TAGGED_LAT_LNG: &str = "https://www.google.com/maps/@35.6762,139.6503,3a,89.4y,180.00h,85.00t/data=!3m5!1e1!3m3!1sQmgLCWv3QpNiK-1F3ZK_1Q!2e0!6shttps%3A%2F%2Fstreetviewpixels-pa.googleapis.com%2Fv1%2Fthumbnail%3Fpanoid%3DQmgLCWv3QpNiK-1F3ZK_1Q%26cb_client%3Dmaps_sv.share%26w%3D900%26h%3D600%26yaw%3D180%26pitch%3D5%26thumbfov%3D89?coh=235716&entry=tts&extra%5Btags%5D=Mountains&extra%5Btags%5D=Coastal&extra%5BloadMode%5D=latLng";

/// Zoom survives the writer's one-decimal field of view.
fn assert_zoom(p: &ParsedLocation, written: f64) {
    assert!((p.zoom - written).abs() < 2e-3, "zoom {} != {written}", p.zoom);
}

#[test]
fn an_official_pano_link_round_trips_its_whole_camera() {
    let p = parsed(OFFICIAL_PINNED);
    assert!((p.lat - 58.6190505).abs() < 1e-9);
    assert!((p.lng - 49.7204709).abs() < 1e-9);
    assert!((p.heading - 265.69).abs() < 1e-9);
    assert!((p.pitch - 8.54).abs() < 1e-9);
    assert_zoom(&p, 1.2);
    assert_eq!(p.pano_id.as_deref(), Some("bUp3OlCW2UH3MA4lYMRirQ"));
    assert_eq!(p.flags, LocationFlags::LOAD_AS_PANO_ID);
    assert!(p.tags.is_empty());
}

#[test]
fn an_unofficial_pano_link_round_trips_without_a_thumbnail() {
    let p = parsed(UNOFFICIAL_NO_TAGS);
    assert!((p.lat - 1.0).abs() < 1e-9);
    assert!((p.lng - 2.0).abs() < 1e-9);
    assert_eq!(p.heading, 0.0);
    assert_eq!(p.pitch, 0.0);
    assert_zoom(&p, 1.0);
    assert_eq!(p.pano_id.as_deref(), Some("CIHM0ogKEICAgICEm_ixqwE"));
    assert_eq!(p.flags, LocationFlags::LOAD_AS_PANO_ID);
}

#[test]
fn a_written_link_round_trips_its_tags_and_lat_lng_load_mode() {
    let p = parsed(TAGGED_LAT_LNG);
    assert!((p.lat - 35.6762).abs() < 1e-9);
    assert!((p.lng - 139.6503).abs() < 1e-9);
    assert!((p.heading - 180.0).abs() < 1e-9);
    assert!((p.pitch + 5.0).abs() < 1e-9);
    assert_zoom(&p, 0.6);
    assert_eq!(p.pano_id.as_deref(), Some("QmgLCWv3QpNiK-1F3ZK_1Q"));
    assert_eq!(p.flags, LocationFlags::empty());
    assert_eq!(p.tags, ["Mountains", "Coastal"]);
}

#[test]
fn fov_to_zoom_is_monotonically_decreasing_and_near_one_at_ninety() {
    let zooms: Vec<f64> = [30.0, 45.0, 60.0, 90.0, 120.0]
        .into_iter()
        .map(fov_to_zoom)
        .collect();
    assert!(zooms.windows(2).all(|w| w[0] > w[1]));
    assert!((fov_to_zoom(90.0) - 1.0).abs() < 0.5);
}
