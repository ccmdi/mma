use super::*;

#[test]
fn upstream_url_maps_path_and_query() {
    assert_eq!(
        upstream_url("/api/v4/user-maps/abc", None),
        "https://www.geoguessr.com/api/v4/user-maps/abc"
    );
    assert_eq!(
        upstream_url("api/v3/profiles", Some("page=2")),
        "https://www.geoguessr.com/api/v3/profiles?page=2"
    );
    // empty query must not leave a trailing '?'
    assert_eq!(
        upstream_url("/api/v3/profiles", Some("")),
        "https://www.geoguessr.com/api/v3/profiles"
    );
}

#[test]
fn upstream_url_never_escapes_the_geoguessr_origin() {
    for path in ["//evil.com/x", "/../../x", "api/v3/x"] {
        assert!(upstream_url(path, None).starts_with("https://www.geoguessr.com/"));
    }
}

fn header(hs: &[(&'static str, String)], name: &str) -> Option<String> {
    hs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.clone())
}

#[test]
fn headers_carry_the_session_cookie_and_client_hints() {
    let hs = proxy_headers("tok-1", None);
    assert_eq!(header(&hs, "cookie").as_deref(), Some("_ncfa=tok-1"));
    assert_eq!(header(&hs, "x-client").as_deref(), Some("web"));
    assert_eq!(header(&hs, "accept").as_deref(), Some("application/json"));
    assert_eq!(header(&hs, "origin").as_deref(), Some(ORIGIN));
    assert_eq!(
        header(&hs, "referer").as_deref(),
        Some("https://www.geoguessr.com/")
    );
    assert!(header(&hs, "content-type").is_none());
}

#[test]
fn content_type_is_forwarded_only_when_given() {
    let hs = proxy_headers("t", Some("application/json; charset=utf-8"));
    assert_eq!(
        header(&hs, "content-type").as_deref(),
        Some("application/json; charset=utf-8")
    );
}

#[test]
fn profile_parses_wrapped_and_bare_shapes() {
    let wrapped = serde_json::json!({
        "user": { "id": "abc123", "nick": "ccmdi", "isProUser": true,
                  "pin": { "url": "pin/abc.png", "anchor": "center" } },
        "email": "x@example.com"
    });
    let got = parse_profile(&wrapped).unwrap();
    assert_eq!(got.id, "abc123");
    assert_eq!(got.nick, "ccmdi");
    assert_eq!(got.pin.as_deref(), Some("pin/abc.png"));

    // No pin object is fine; the avatar is just absent.
    let bare = serde_json::json!({ "id": "z9", "nick": "solo" });
    assert_eq!(parse_profile(&bare).unwrap().nick, "solo");
    assert_eq!(parse_profile(&bare).unwrap().pin, None);
}

#[test]
fn profile_missing_fields_is_none_not_a_panic() {
    assert!(parse_profile(&serde_json::json!({ "user": { "id": "a" } })).is_none());
    assert!(parse_profile(&serde_json::json!({})).is_none());
}

#[test]
fn login_nav_allows_only_sign_in_hosts() {
    let allow = |s: &str| login_nav_allowed(&s.parse::<tauri::Url>().unwrap());
    assert!(allow("https://geoguessr.com/signin"));
    assert!(allow("https://sub.geoguessr.com/x"));
    assert!(allow("https://accounts.google.com/o/oauth2"));
    assert!(allow("about:blank"));

    assert!(!allow("https://evil.com"));
    assert!(!allow("http://geoguessr.com"));
    assert!(!allow("https://notgeoguessr.com"));
    // Suffix trick: a dot boundary is required, not a bare string suffix.
    assert!(!allow("https://xgeoguessr.com"));
}
