pub(crate) mod feedback;
pub(crate) mod fetch;
pub(crate) mod gdoc;
pub(crate) mod geocoder;
pub(crate) mod geoguessr;
pub(crate) mod github;
pub(crate) mod loopback;
pub(crate) mod presence;
pub(crate) mod proxy;
pub(crate) mod remote_api;
#[cfg(feature = "web-serve")]
pub mod serve;
pub(crate) mod update;

/// `text` percent-encoded to stand alone as one part of a URL.
pub(crate) fn encoded(text: &str) -> String {
    percent_encoding::utf8_percent_encode(text, percent_encoding::NON_ALPHANUMERIC).to_string()
}
