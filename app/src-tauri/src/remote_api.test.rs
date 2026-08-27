use super::*;

fn labels(v: &[&str]) -> Vec<String> {
    v.iter().map(ToString::to_string).collect()
}

#[test]
fn pick_target_routing() {
    // Explicit mapId targets its window; unknown id falls back to main (web/single-window).
    let ls = labels(&["main", "map-a", "map-b"]);
    assert_eq!(pick_target(&ls, Some("a")).unwrap(), "map-a");
    assert_eq!(pick_target(&ls, Some("zzz")).unwrap(), "main");

    // No mapId: unambiguous cases resolve, ambiguous ones error.
    assert_eq!(pick_target(&labels(&["main"]), None).unwrap(), "main");
    assert_eq!(
        pick_target(&labels(&["main", "map-a"]), None).unwrap(),
        "map-a"
    );
    assert!(pick_target(&ls, None).is_err());
}
