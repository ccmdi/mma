use super::*;

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

// ---------------------------------------------------------------------------
// Desktop and web deliver the same scheme call
// ---------------------------------------------------------------------------

fn desktop_call(uri: &str, method: Method, headers: &[(&str, &str)], body: &[u8]) -> SchemeCall {
    let mut req = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    SchemeCall::from_desktop(&req.body(body.to_vec()).unwrap())
}

#[test]
fn web_and_desktop_calls_match_with_query() {
    assert_eq!(
        desktop_call(
            "http://svtile.localhost/abc=w512?fmt=jpeg&q=80",
            Method::GET,
            &[],
            b""
        ),
        SchemeCall::from_http(
            "GET",
            "abc=w512",
            "fmt=jpeg&q=80".into(),
            String::new(),
            String::new(),
            vec![]
        ),
    );
}

#[test]
fn web_and_desktop_calls_match_without_query() {
    assert_eq!(
        desktop_call("http://gdoc.localhost/doc123", Method::GET, &[], b""),
        SchemeCall::from_http(
            "GET",
            "doc123",
            String::new(),
            String::new(),
            String::new(),
            vec![]
        ),
    );
}

#[test]
fn web_and_desktop_calls_match_with_headers_and_body() {
    assert_eq!(
        desktop_call(
            "http://gmaps.localhost/maps/rpc%20x",
            Method::POST,
            &[("content-type", "application/json"), ("user-agent", "ua/1")],
            b"payload",
        ),
        SchemeCall::from_http(
            "POST",
            "maps/rpc%20x",
            String::new(),
            "application/json".into(),
            "ua/1".into(),
            b"payload".to_vec(),
        ),
    );
}

#[test]
fn a_call_names_its_run_only_through_a_numeric_run_parameter() {
    let run = |uri: &str| desktop_call(uri, Method::GET, &[], b"").run();
    assert_eq!(run("http://pano.localhost/abc/3?run=7"), Some(7));
    assert_eq!(run("http://pano.localhost/abc/3?x=1&run=7"), Some(7));
    assert_eq!(run("http://pano.localhost/abc/3"), None);
    assert_eq!(run("http://pano.localhost/abc/3?run=x"), None);
}

#[test]
fn scheme_names_are_unique() {
    let mut names: Vec<_> = SCHEMES.iter().map(|s| s.name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), SCHEMES.len());
}
