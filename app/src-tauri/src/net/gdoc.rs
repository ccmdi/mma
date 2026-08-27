//! Document fetching for the doclink feature: the `gdoc://` scheme resolves a
//! Google Doc id to its static HTML.

use crate::net::proxy::{proxy_client, proxy_error, relay};
use tauri::http::Response;

/// Only a bare doc id may reach the gdoc proxy, so it can't be used as an open proxy.
pub(crate) fn valid_gdoc_id(doc_id: &str) -> bool {
    !doc_id.is_empty()
        && doc_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Fetch a link-shared Google Doc's static HTML. `mobilebasic` is primary:
/// pre-rendered (~1s even for 100+ page docs) with the same `h.xxxx` heading
/// anchors. `export?format=html` is generated per request -- it can take 30s+,
/// time out, or 413 on large docs -- so it's only a fallback.
pub(crate) fn fetch_gdoc(doc_id: &str) -> Response<Vec<u8>> {
    if !valid_gdoc_id(doc_id) {
        return proxy_error("invalid doc id".into());
    }
    let base = format!("https://docs.google.com/document/d/{doc_id}");
    match proxy_client().get(format!("{base}/mobilebasic")).send() {
        Ok(resp) if resp.status().is_success() => relay(resp, "text/html"),
        _ => match proxy_client()
            .get(format!("{base}/export?format=html"))
            .send()
        {
            Ok(resp) => relay(resp, "text/html"),
            Err(e) => proxy_error(format!("gdoc fetch error: {e}")),
        },
    }
}

#[cfg(test)]
#[path = "gdoc.test.rs"]
mod gdoc_tests;
