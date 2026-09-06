use super::*;

#[test]
fn ping_and_unknown_routes() {
    let mut s = ServeState::new("unused-model-dir");
    assert_eq!(s.handle("GET", "/ping", ""), (200, r#"{"ok":true}"#.into()));
    assert_eq!(s.handle("GET", "/nope", "").0, 404);
}

#[test]
fn malformed_detect_input_is_rejected_before_model_load() {
    // A 400 must come back without touching the model dir: the detector loads
    // lazily, and a parse failure never reaches it.
    let mut s = ServeState::new("nonexistent-model-dir");
    assert_eq!(s.handle("POST", "/detect", "{not json").0, 400);
    assert!(s.handle("POST", "/detect", "{not json").1.contains("bad input"));
}
