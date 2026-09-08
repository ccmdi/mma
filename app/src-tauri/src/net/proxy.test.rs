use super::*;

// ---------------------------------------------------------------------------
// svtile URL construction
// ---------------------------------------------------------------------------

#[test]
fn svtile_url_valid_tile_path() {
    assert_eq!(
        svtile_url("/abc123=w512", ""),
        "https://lh3.ggpht.com/jsapi2/a/b/c/abc123=w512"
    );
}

#[test]
fn svtile_url_preserves_query() {
    assert_eq!(
        svtile_url("/tile", "?fmt=jpeg&q=80"),
        "https://lh3.ggpht.com/jsapi2/a/b/c/tile?fmt=jpeg&q=80"
    );
}

#[test]
fn svtile_url_stays_on_origin() {
    for path in [
        "/../../../etc/passwd",
        "/..%2F..%2Fetc/passwd",
        "/%2e%2e/%2e%2e/",
        "//evil.com/path",
    ] {
        assert!(
            svtile_url(path, "").starts_with("https://lh3.ggpht.com/"),
            "path {path:?} escaped lh3.ggpht.com"
        );
    }
}

#[test]
fn svtile_url_ssrf_localhost() {
    for path in [
        "//localhost/admin",
        "//127.0.0.1/internal",
        "//[::1]/secret",
        "//metadata.google.internal/",
    ] {
        assert!(
            svtile_url(path, "").starts_with("https://lh3.ggpht.com/"),
            "path {path:?} must not redirect to internal host"
        );
    }
}

#[test]
fn svtile_url_empty_and_slash() {
    assert_eq!(
        svtile_url("", ""),
        "https://lh3.ggpht.com/jsapi2/a/b/c/"
    );
    assert_eq!(
        svtile_url("/", ""),
        "https://lh3.ggpht.com/jsapi2/a/b/c/"
    );
}

#[test]
fn svtile_url_null_byte_in_path() {
    assert!(svtile_url("/tile\0evil", "").starts_with("https://lh3.ggpht.com/"));
}

// ---------------------------------------------------------------------------
// gmaps URL construction
// ---------------------------------------------------------------------------

#[test]
fn gmaps_url_valid_rpc_path() {
    assert_eq!(
        gmaps_url("/maps/api/js", "?v=3.63"),
        "https://www.google.com/maps/api/js?v=3.63"
    );
}

#[test]
fn gmaps_url_batchexecute_path() {
    assert_eq!(
        gmaps_url(
            "/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata",
            ""
        ),
        "https://www.google.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata"
    );
}

#[test]
fn gmaps_url_stays_on_origin() {
    for path in [
        "//evil.com/x",
        "/../../etc/passwd",
        "/../x",
        "/..%2F..%2Fetc/passwd",
        "/%2e%2e/secret",
    ] {
        assert!(
            gmaps_url(path, "").starts_with("https://www.google.com"),
            "path {path:?} escaped google.com"
        );
    }
}

#[test]
fn gmaps_url_double_slash_stays_on_host() {
    assert!(gmaps_url("//evil.com/steal", "").starts_with("https://www.google.com//"));
}

#[test]
fn gmaps_url_ssrf_localhost() {
    for path in [
        "//localhost/admin",
        "//127.0.0.1:8080/internal",
        "//[::1]/secret",
    ] {
        assert!(
            gmaps_url(path, "").starts_with("https://www.google.com"),
            "path {path:?} must not redirect to internal host"
        );
    }
}

#[test]
fn gmaps_url_at_sign_stays_in_path() {
    assert_eq!(
        gmaps_url("/@evil.com/path", ""),
        "https://www.google.com/@evil.com/path"
    );
}

#[test]
fn gmaps_url_empty_path() {
    assert_eq!(gmaps_url("", ""), "https://www.google.com");
}

// ---------------------------------------------------------------------------
// googl URL construction
// ---------------------------------------------------------------------------

#[test]
fn googl_url_mapsapp_variant() {
    assert_eq!(
        googl_url("abc123XYZ", true),
        "https://maps.app.goo.gl/abc123XYZ"
    );
}

#[test]
fn googl_url_legacy_variant() {
    assert_eq!(
        googl_url("abc123XYZ", false),
        "https://goo.gl/maps/abc123XYZ"
    );
}

#[test]
fn googl_url_stays_on_origin() {
    for id in [
        "../../../etc/passwd",
        "//evil.com",
        "id?redir=http://evil.com",
        "..%2F..%2F",
        "%2e%2e/secret",
    ] {
        assert!(
            googl_url(id, true).starts_with("https://maps.app.goo.gl/"),
            "mapsapp id {id:?} escaped origin"
        );
        assert!(
            googl_url(id, false).starts_with("https://goo.gl/maps/"),
            "legacy id {id:?} escaped origin"
        );
    }
}

#[test]
fn googl_url_ssrf_localhost() {
    for id in ["@localhost/admin", "//127.0.0.1/", "//[::1]/"] {
        assert!(
            googl_url(id, true).starts_with("https://maps.app.goo.gl/"),
            "mapsapp id {id:?} must not redirect"
        );
        assert!(
            googl_url(id, false).starts_with("https://goo.gl/maps/"),
            "legacy id {id:?} must not redirect"
        );
    }
}

#[test]
fn googl_url_empty_id() {
    assert_eq!(googl_url("", true), "https://maps.app.goo.gl/");
    assert_eq!(googl_url("", false), "https://goo.gl/maps/");
}

#[test]
fn googl_url_null_byte_in_id() {
    assert!(googl_url("abc\0def", true).starts_with("https://maps.app.goo.gl/"));
    assert!(googl_url("abc\0def", false).starts_with("https://goo.gl/maps/"));
}

// ---------------------------------------------------------------------------
// local_path (mma-buf scheme helper)
// ---------------------------------------------------------------------------

#[test]
fn local_path_strips_slash_for_drive_letter() {
    assert_eq!(local_path("/C:/data/file.bin"), "C:/data/file.bin");
    assert_eq!(local_path("/D:/x"), "D:/x");
}

#[test]
fn local_path_preserves_unix_paths() {
    assert_eq!(local_path("/tmp/file"), "/tmp/file");
    assert_eq!(local_path("/home/user/data"), "/home/user/data");
}

#[test]
fn local_path_empty() {
    assert_eq!(local_path(""), "");
}

#[test]
fn local_path_bare_drive() {
    assert_eq!(local_path("/E:"), "E:");
}

#[test]
fn local_path_non_drive_colon() {
    assert_eq!(local_path("/1:fake"), "/1:fake");
}
