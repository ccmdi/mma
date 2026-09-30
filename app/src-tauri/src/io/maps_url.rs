//! A pasted Google Maps URL -> the location it names. Short links resolve through the
//! redirect reader in [`crate::net::proxy`] first; the expanded grammar covers the
//! `/maps/@...!1s<key>!2e<frontend>` path form, `map_action=pano` viewpoints, the legacy
//! `layer=c&cbll=` form, and Arts & Culture street views.

use std::f64::consts::PI;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use url::form_urlencoded;
use url::Url;

use crate::net::proxy;
use crate::sv::pano_id::from_image_key;
use crate::types::LocationFlags;
use crate::util::blocking;

/// A single location parsed out of a pasted Maps URL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLocation {
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: f64,
    pub pano_id: Option<String>,
    pub flags: LocationFlags,
    /// Tag names.
    pub tags: Vec<String>,
}

/// Field-of-view angle (degrees) as a zoom level.
fn fov_to_zoom(fov: f64) -> f64 {
    -((4.0 / 3.0) * (PI * fov / 360.0).tan()).log2() + 1.0
}

fn query_first(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

fn query_all(url: &Url, key: &str) -> Vec<String> {
    url.query_pairs()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .collect()
}

fn number(v: Option<String>) -> Option<f64> {
    v?.trim().parse().ok()
}

/// A Street View share path, whose position is either `lat,lng` or a full Plus Code.
fn street_view_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"@(?P<position>-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?|(?i:[23456789CFGHJMPQRVWX]{8}(?:\+|%2b)[23456789CFGHJMPQRVWX]{2,7})),(?:-?\d+(?:\.\d+)?)a,(?P<fov>-?\d+(?:\.\d+)?)y(?:,(?P<heading>-?\d+(?:\.\d+)?)h)?,(?P<tilt>-?\d+(?:\.\d+)?)t(?:,-?\d+(?:\.\d+)?r)?/data=(?:.*?)!1s(?P<key>[0-9a-zA-Z_-]+)!2e(?P<frontend>\d+)",
        )
        .expect("street view path pattern")
    })
}

fn street_view_position(position: &str) -> Option<(f64, f64)> {
    if let Some((lat, lng)) = position.split_once(',') {
        return Some((lat.parse().ok()?, lng.parse().ok()?));
    }
    let code = percent_encoding::percent_decode_str(position)
        .decode_utf8()
        .ok()?;
    decode_full_plus_code(&code)
}

/// Decode a full, unpadded Open Location Code to its cell center. Street View shares
/// use 10–15 significant digits; short codes need a reference location and are rejected.
/// Pair digits describe a 20x20 grid; subsequent digits refine it into 5 rows / 4 columns.
fn decode_full_plus_code(code: &str) -> Option<(f64, f64)> {
    const ALPHABET: &[u8] = b"23456789CFGHJMPQRVWX";
    let bytes = code.as_bytes();
    if !(11..=16).contains(&bytes.len()) || bytes[8] != b'+' {
        return None;
    }
    let digits: Vec<i64> = bytes[..8]
        .iter()
        .chain(&bytes[9..])
        .map(|b| {
            ALPHABET
                .iter()
                .position(|a| *a == b.to_ascii_uppercase())
                .map(|i| i as i64)
        })
        .collect::<Option<_>>()?;
    let (mut lat, mut lng) = (0_i64, 0_i64);
    for pair in digits[..10].chunks_exact(2) {
        lat = lat * 20 + pair[0];
        lng = lng * 20 + pair[1];
    }
    let (mut lat_scale, mut lng_scale) = (8_000_i64, 8_000_i64);
    if lat >= 180 * lat_scale || lng >= 360 * lng_scale {
        return None;
    }
    for digit in &digits[10..] {
        lat = lat * 5 + digit / 4;
        lng = lng * 4 + digit % 4;
        lat_scale *= 5;
        lng_scale *= 4;
    }
    Some((
        (lat as f64 + 0.5) / lat_scale as f64 - 90.0,
        (lng as f64 + 0.5) / lng_scale as f64 - 180.0,
    ))
}

fn parse_expanded(url: &Url) -> Option<ParsedLocation> {
    // The share dialog carries `extra[...]` params in the fragment; a fragment that is
    // present owns the tags, and `loadMode` falls back to the query.
    let frag: Vec<(String, String)> = url
        .fragment()
        .map(|f| form_urlencoded::parse(f.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let frag_tags: Vec<String> = frag
        .iter()
        .filter(|(k, _)| k == "extra[tags]")
        .map(|(_, v)| v.clone())
        .collect();
    let tags = if frag.iter().any(|(k, _)| k == "extra[tags]") {
        frag_tags
    } else {
        query_all(url, "extra[tags]")
    };
    let load_mode = frag
        .iter()
        .find(|(k, _)| k == "extra[loadMode]")
        .map(|(_, v)| v.clone())
        .or_else(|| query_first(url, "extra[loadMode]"));
    let pano_flags = if load_mode.as_deref() == Some("latLng") {
        LocationFlags::empty()
    } else {
        LocationFlags::LOAD_AS_PANO_ID
    };

    let host = url.host_str().unwrap_or_default();
    if host.starts_with("www.google.") && url.path().starts_with("/maps") {
        if let Some(m) = street_view_path().captures(url.path()) {
            let (lat, lng) = street_view_position(&m["position"])?;
            let zoom = m["fov"].parse().map_or(0.0, fov_to_zoom);
            let heading = m
                .name("heading")
                .and_then(|h| h.as_str().parse().ok())
                .unwrap_or(0.0);
            let pitch = m["tilt"].parse::<f64>().map_or(0.0, |t| t - 90.0);
            let frontend: i32 = m["frontend"].parse().ok()?;
            let pano_id = from_image_key(if frontend == 0 { 2 } else { frontend }, &m["key"]);
            let flags = if pano_id.is_empty() {
                LocationFlags::empty()
            } else {
                pano_flags
            };
            return Some(ParsedLocation {
                lat,
                lng,
                heading,
                pitch,
                zoom,
                pano_id: (!pano_id.is_empty()).then_some(pano_id),
                flags,
                tags,
            });
        }

        if query_first(url, "map_action").as_deref() == Some("pano") {
            let vp = query_first(url, "viewpoint")?;
            let mut parts = vp.split(',');
            let lat: f64 = parts.next()?.parse().ok()?;
            let lng: f64 = parts.next()?.parse().ok()?;
            let pano_id = query_first(url, "pano").filter(|p| !p.is_empty());
            return Some(ParsedLocation {
                lat,
                lng,
                heading: number(query_first(url, "heading")).unwrap_or(0.0),
                pitch: number(query_first(url, "pitch")).unwrap_or(0.0),
                zoom: fov_to_zoom(number(query_first(url, "fov")).unwrap_or(90.0)),
                flags: if pano_id.is_some() {
                    pano_flags
                } else {
                    LocationFlags::empty()
                },
                pano_id,
                tags,
            });
        }

        if query_first(url, "layer").as_deref() == Some("c") {
            if let Some(cbll) = query_first(url, "cbll") {
                let mut parts = cbll.split(',');
                let lat: f64 = parts.next()?.parse().ok()?;
                let lng: f64 = parts.next()?.parse().ok()?;
                return Some(ParsedLocation {
                    lat,
                    lng,
                    heading: 0.0,
                    pitch: 0.0,
                    zoom: 0.0,
                    pano_id: None,
                    flags: LocationFlags::empty(),
                    tags,
                });
            }
        }
    } else if host.starts_with("artsandculture.google.") {
        if let Some(pano_id) = query_first(url, "sv_pid") {
            return Some(ParsedLocation {
                lat: number(query_first(url, "sv_lat")).unwrap_or(0.0),
                lng: number(query_first(url, "sv_lng")).unwrap_or(0.0),
                heading: number(query_first(url, "sv_h")).unwrap_or(0.0),
                pitch: number(query_first(url, "s_p")).unwrap_or(0.0),
                zoom: number(query_first(url, "sv_z")).unwrap_or(0.0),
                pano_id: Some(pano_id),
                flags: LocationFlags::LOAD_AS_PANO_ID,
                tags,
            });
        }
    }

    None
}

/// The location `input` names, `None` for anything that is not a recognized Maps URL and
/// for a short link that fails to resolve.
pub(crate) fn parse(input: &str) -> Option<ParsedLocation> {
    let mut url = Url::parse(input.trim()).ok()?;
    let mapsapp = match url.host_str().unwrap_or_default() {
        "maps.app.goo.gl" => Some(true),
        "goo.gl" if url.path().starts_with("/maps/") => Some(false),
        _ => None,
    };
    if let Some(mapsapp) = mapsapp {
        let id = url
            .path_segments()
            .and_then(|mut s| s.next_back().map(str::to_owned))
            .filter(|id| !id.is_empty());
        if let Some(id) = id {
            let target = proxy::short_link_target(&id, mapsapp).ok()??;
            url = Url::parse(&target).ok()?;
        }
    }
    parse_expanded(&url)
}

/// The location a pasted Maps URL names, short links resolved.
#[tauri::command]
#[specta::specta]
pub async fn parse_maps_url(input: String) -> Option<ParsedLocation> {
    blocking(move || parse(&input)).await.ok().flatten()
}

#[cfg(test)]
#[path = "maps_url.test.rs"]
mod tests;
