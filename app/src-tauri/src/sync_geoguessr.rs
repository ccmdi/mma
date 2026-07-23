//! GeoGuessr sync provider: draft JSON codec, version concurrency, stored-size guard.
//!
//! A draft is one ordered array replaced wholesale, so identity is `Positional` (the index is
//! the only handle) and the wire format is lossy (no tags, no "keep panoId but don't load it").
//! [`GeoGuessrProvider::project`] erases exactly those distinctions on both sides so they never
//! read as a difference.

use serde::{Deserialize, Serialize};

use crate::geoguessr::{proxy_headers, upstream_url};
use crate::storage;
use crate::sync::{
    IdentityModel, NormalizedSyncLocation, PushBatch, PushedId, RemoteSnapshot, SyncLocalPin,
    SyncProvider,
};
use crate::types::{AppError, AppResult, LocationFlags};

const LOAD_AS_PANO_ID: u32 = LocationFlags::LOAD_AS_PANO_ID.bits();
const INFORMATIONAL: u32 = LocationFlags::INFORMATIONAL.bits();

/// GeoGuessr reads heading 0 as "unset, pick at random", so a genuine north must be nudged.
/// 1e-4 degrees is ~1cm of bearing, far below anything a user set deliberately.
const NORTH: f64 = 1e-4;

// --- wire types -------------------------------------------------------------

/// One draft location. `panoId` is ALWAYS serialized, even when None (an explicit null is
/// meaningful to GeoGuessr). The three geocode codes are server-owned: we never set them, pulled
/// values may arrive as explicit null OR absent, and the server drops nulls in storage - so both
/// collapse to None here and are omitted on write. Absence == null semantically.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GgCoordinate {
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: f64,
    pub pano_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city_code: Option<String>,
}

/// A draft READ. Locations arrive under `coordinates`; unknown fields are ignored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GgDraft {
    pub mode: String,
    /// Locations, on READ only (null on the drafts-list endpoint).
    pub coordinates: Option<Vec<GgCoordinate>>,
    /// Optimistic concurrency: a write must send exactly `version + 1`.
    pub version: i64,
}

/// The minimal accepted draft write. Locations go out under `customCoordinates`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GgDraftWrite {
    pub mode: String,
    pub version: i64,
    pub custom_coordinates: Vec<GgCoordinate>,
}

/// GeoGuessr answers a successful draft write with `{ message: "OK" }`.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct GgWriteResult {
    pub message: String,
}

/// The draft write body: `customCoordinates` in order, at exactly `version + 1`.
fn write_body(items: Vec<GgCoordinate>, version: i64) -> GgDraftWrite {
    GgDraftWrite {
        mode: "coordinates".into(),
        version: version + 1,
        custom_coordinates: items,
    }
}

// --- stored-size guard ------------------------------------------------------

/// A draft is stored as a single MongoDB document; a write is accepted iff the STORED document's
/// BSON size fits Mongo's 16 MiB limit. Request body size and location count are irrelevant.
const BSON_DOC_LIMIT: usize = 16_777_216;

/// Headroom for the rest of the stored draft (name, description, avatar, tags, ~300B measured).
const DRAFT_METADATA_MARGIN: usize = 64 * 1024;

/// BSON string element: type + key + NUL + int32 length + bytes + NUL.
fn str_elem(key: &str, v: &str) -> usize {
    key.len() + 7 + v.len()
}

/// Decimal-digit count of an array index (`String(i).length`).
fn digit_count(mut i: usize) -> usize {
    let mut d = 1;
    while i >= 10 {
        i /= 10;
        d += 1;
    }
    d
}

/// BSON size of the coordinate array exactly as GeoGuessr stores it.
pub(crate) fn stored_bson_size(coords: &[GgCoordinate]) -> usize {
    let mut size = 5;
    for (i, c) in coords.iter().enumerate() {
        // 77 = pin doc wrapper + the five always-present doubles with their keys. Null is stored
        // for panoId (8) but DROPPED for the geocode fields; both behaviors are measured.
        let mut pin = 77
            + match &c.pano_id {
                None => 8,
                Some(p) => str_elem("panoId", p),
            };
        if let Some(v) = &c.country_code {
            pin += str_elem("countryCode", v);
        }
        if let Some(v) = &c.state_code {
            pin += str_elem("stateCode", v);
        }
        if let Some(v) = &c.city_code {
            pin += str_elem("cityCode", v);
        }
        size += 2 + digit_count(i) + pin;
    }
    size
}

// --- error classification ---------------------------------------------------

fn http_error(context: &str, status: u16) -> AppError {
    AppError(format!("{context}: HTTP {status}"))
}

/// 401: the stored session was rejected.
pub(crate) fn is_auth_error(err: &AppError) -> bool {
    err.0.contains("HTTP 401")
}

/// 409/412: the sent version lost the optimistic-concurrency race.
pub(crate) fn is_version_conflict(err: &AppError) -> bool {
    err.0.contains("HTTP 409") || err.0.contains("HTTP 412")
}

// --- provider ---------------------------------------------------------------

pub(crate) struct GeoGuessrProvider {
    pub ncfa: String,
}

impl GeoGuessrProvider {
    /// Build from the stored `_ncfa` session in the OS credential store.
    pub(crate) fn from_session() -> AppResult<Self> {
        let ncfa = storage::secret::get("geoguessr")?
            .ok_or_else(|| AppError("not signed in to GeoGuessr".into()))?;
        Ok(Self { ncfa })
    }
}

/// A pano id is present only when non-empty; hashes were defined under JS truthiness ("" = none).
fn has_pano(pano: &Option<String>) -> bool {
    pano.as_deref().is_some_and(|s| !s.is_empty())
}

impl SyncProvider for GeoGuessrProvider {
    type Raw = GgCoordinate;

    fn id(&self) -> &'static str {
        "geoguessr"
    }

    fn identity(&self) -> IdentityModel {
        IdentityModel::Positional
    }

    fn supports_tags(&self) -> bool {
        false
    }

    fn remote_id_of(&self, _item: &GgCoordinate, index: usize) -> i64 {
        index as i64
    }

    fn normalize(&self, item: &GgCoordinate) -> NormalizedSyncLocation {
        self.project(NormalizedSyncLocation {
            lat: item.lat,
            lng: item.lng,
            // Undo the north nudge so a round trip is stable.
            heading: if item.heading == NORTH {
                0.0
            } else {
                item.heading
            },
            pitch: item.pitch,
            zoom: item.zoom,
            pano_id: item.pano_id.clone(),
            flags: if has_pano(&item.pano_id) {
                LOAD_AS_PANO_ID
            } else {
                0
            },
            tags: vec![],
        })
    }

    /// Erase the distinctions GeoGuessr's wire format cannot hold. Applied to both sides.
    fn project(&self, n: NormalizedSyncLocation) -> NormalizedSyncLocation {
        let pano_id = if n.flags & LOAD_AS_PANO_ID != 0 {
            n.pano_id
        } else {
            None
        };
        let flags = if has_pano(&pano_id) {
            LOAD_AS_PANO_ID
        } else {
            0
        };
        NormalizedSyncLocation {
            pano_id,
            flags,
            tags: vec![],
            ..n
        }
    }

    /// Informational pins are editor annotations, not places to guess.
    fn include_local(&self, pin: &SyncLocalPin) -> bool {
        pin.flags & INFORMATIONAL == 0
    }

    fn materialize(&self, n: &NormalizedSyncLocation) -> GgCoordinate {
        GgCoordinate {
            lat: n.lat,
            lng: n.lng,
            heading: if n.heading == 0.0 { NORTH } else { n.heading },
            pitch: n.pitch,
            zoom: n.zoom,
            pano_id: if n.flags & LOAD_AS_PANO_ID != 0 {
                n.pano_id.clone()
            } else {
                None
            },
            country_code: None,
            state_code: None,
            city_code: None,
        }
    }

    fn pull(&self, remote_map_id: &str) -> AppResult<RemoteSnapshot<GgCoordinate>> {
        let url = upstream_url(&format!("api/v4/user-maps/drafts/{remote_map_id}"), None);
        let mut req = crate::sync_client().get(&url);
        for (k, v) in proxy_headers(&self.ncfa, None) {
            req = req.header(k, v);
        }
        let resp = req.send()?;
        let status = resp.status();
        if !status.is_success() {
            return Err(http_error("GeoGuessr draft read failed", status.as_u16()));
        }
        let draft: GgDraft = resp.json()?;
        if draft.mode == "regions" {
            return Err("This GeoGuessr map is polygonal and cannot be synced.".into());
        }
        Ok(RemoteSnapshot {
            locations: draft.coordinates.unwrap_or_default(),
            token: Some(draft.version),
        })
    }

    fn push(
        &self,
        remote_map_id: &str,
        batch: &PushBatch<GgCoordinate>,
        token: Option<i64>,
        commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        let version = token.ok_or_else(|| AppError("missing draft version".into()))?;

        // A draft is replaced whole: there is no chunking. It either fits or it cannot be synced.
        let items: Vec<GgCoordinate> = batch.desired.iter().map(|d| d.item.clone()).collect();
        let stored = stored_bson_size(&items);
        if stored > BSON_DOC_LIMIT - DRAFT_METADATA_MARGIN {
            return Err(AppError(format!(
                "Too large for a GeoGuessr draft (stores as {:.1} MiB; the limit is 16 MiB).",
                stored as f64 / 1048576.0
            )));
        }

        // Send exactly pull-time version + 1; never re-read first. A stale version fails loudly,
        // which is the concurrency guard.
        let bytes = serde_json::to_vec(&write_body(items, version))?;

        let url = upstream_url(&format!("api/v4/user-maps/drafts/{remote_map_id}"), None);
        let mut req = crate::sync_client().put(&url).body(bytes);
        for (k, v) in proxy_headers(&self.ncfa, Some("application/json")) {
            req = req.header(k, v);
        }
        let resp = req.send()?;
        let status = resp.status();
        if !status.is_success() {
            return Err(http_error("GeoGuessr draft write failed", status.as_u16()));
        }
        // A 200 whose message is not "OK" is still a failure.
        let result: GgWriteResult = resp.json()?;
        if result.message != "OK" {
            return Err(AppError(result.message));
        }

        // Rewriting the document reindexes everything: report a handle for every entry we wrote.
        let pushed: Vec<PushedId> = batch
            .desired
            .iter()
            .enumerate()
            .filter_map(|(index, d)| {
                d.local_id.map(|local_id| PushedId {
                    local_id,
                    remote_id: index as i64,
                })
            })
            .collect();
        // Atomic write: the whole set landed together.
        commit(&pushed)?;
        Ok(pushed)
    }
}

#[cfg(test)]
#[path = "sync_geoguessr.test.rs"]
mod tests;
