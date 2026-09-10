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

/// The `@lat,lng,<alt>a,<fov>y[,<heading>h],<pitch>t[,<roll>r]/data=...!1s<key>!2e<frontend>`
/// path form a Street View share link uses.
fn street_view_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(?:-?\d+(?:\.\d+)?)a,(-?\d+(?:\.\d+)?)y(?:,(-?\d+(?:\.\d+)?)h)?,(-?\d+(?:\.\d+)?)t(?:,-?\d+(?:\.\d+)?r)?/data=(?:.*?)!1s([0-9a-zA-Z_-]+)!2e(\d+)",
        )
        .expect("street view path pattern")
    })
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
            let lat: f64 = m[1].parse().ok()?;
            let lng: f64 = m[2].parse().ok()?;
            let zoom = m[3].parse().map_or(0.0, fov_to_zoom);
            let heading = m.get(4).and_then(|h| h.as_str().parse().ok()).unwrap_or(0.0);
            let pitch = m[5].parse::<f64>().map_or(0.0, |t| t - 90.0);
            let frontend: i32 = m[7].parse().ok()?;
            let pano_id = from_image_key(if frontend == 0 { 2 } else { frontend }, &m[6]);
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
