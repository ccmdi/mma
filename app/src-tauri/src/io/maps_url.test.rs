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

#[test]
fn fov_to_zoom_is_monotonically_decreasing_and_near_one_at_ninety() {
    let zooms: Vec<f64> = [30.0, 45.0, 60.0, 90.0, 120.0]
        .into_iter()
        .map(fov_to_zoom)
        .collect();
    assert!(zooms.windows(2).all(|w| w[0] > w[1]));
    assert!((fov_to_zoom(90.0) - 1.0).abs() < 0.5);
}
