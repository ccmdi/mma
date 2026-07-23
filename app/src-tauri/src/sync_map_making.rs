//! map-making.app sync provider: protobuf pull decode, chunked edit-batch push.
//! The pure halves (protobuf decode, push chunking) are factored out of IO so they test
//! without a network; see sync_map_making.test.rs.

use std::collections::HashMap;

use serde::Serialize;

use crate::sync::{
    canon_tags, sync_flags, IdentityModel, NormalizedSyncLocation, PushBatch, PushedId,
    RemoteSnapshot, SyncProvider,
};
use crate::types::{AppError, AppResult};

const BASE_URL: &str = "https://map-making.app";

/// Ops per edit request; bounds failure cost, not a server limit.
const PUSH_CHUNK: usize = 200_000;

/// EditActionType.Bulk from remote-types.ts.
const EDIT_ACTION_BULK: u32 = 8;

/// AppError message prefix stamped on an HTTP 401 from the API, so the engine can special-case
/// auth failures without a typed error. `pull`/`push` are the only emitters; [`is_auth_error`]
/// is the sole reader.
const AUTH_ERROR_PREFIX: &str = "mma-http-401: ";

pub(crate) struct MapMakingProvider {
    pub api_key: String,
}

/// Whether an [`AppError`] from this provider is a 401 (invalid/expired API key).
pub(crate) fn is_auth_error(e: &AppError) -> bool {
    e.0.starts_with(AUTH_ERROR_PREFIX)
}

// --- read shape (mirrors Remote.Location) -----------------------------------

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

/// The read shape decoded from a pull. `author`/`created_at`/`pano_date` are remote-owned and
/// ignored by the contract; kept for fidelity.
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct MmLocation {
    pub id: i64,
    pub location: LatLng,
    pub pano_id: Option<String>,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: Option<f64>,
    pub flags: u32,
    pub tags: Vec<String>,
    pub author: Option<u32>,
    pub created_at: Option<u64>,
    pub pano_date: Option<u64>,
}

impl Default for LatLng {
    fn default() -> Self {
        LatLng { lat: 0.0, lng: 0.0 }
    }
}

// --- write shape (LocationInput, camelCase JSON) ----------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocationInput {
    id: i64,
    location: LatLng,
    pano_id: Option<String>,
    heading: f64,
    pitch: f64,
    zoom: Option<f64>,
    flags: u32,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct EditRequest {
    edits: Vec<Edit>,
}

#[derive(Serialize)]
struct Edit {
    action: EditAction,
    create: Vec<LocationInput>,
    remove: Vec<i64>,
}

#[derive(Serialize)]
struct EditAction {
    #[serde(rename = "type")]
    kind: u32,
}

/// Write shape from the read shape. `id` is the caller-assigned negative placeholder.
fn to_input(item: &MmLocation, id: i64) -> LocationInput {
    LocationInput {
        id,
        location: item.location.clone(),
        pano_id: item.pano_id.clone(),
        heading: item.heading,
        pitch: item.pitch,
        zoom: item.zoom,
        flags: item.flags,
        tags: item.tags.clone(),
    }
}

// --- SyncProvider impl ------------------------------------------------------

impl SyncProvider for MapMakingProvider {
    type Raw = MmLocation;

    fn id(&self) -> &'static str {
        "map-making.app"
    }

    fn identity(&self) -> IdentityModel {
        IdentityModel::Stable
    }

    fn supports_tags(&self) -> bool {
        true
    }

    fn remote_id_of(&self, item: &MmLocation, _index: usize) -> i64 {
        item.id
    }

    fn normalize(&self, item: &MmLocation) -> NormalizedSyncLocation {
        NormalizedSyncLocation {
            lat: item.location.lat,
            lng: item.location.lng,
            heading: item.heading,
            pitch: item.pitch,
            zoom: item.zoom.unwrap_or(0.0),
            pano_id: item.pano_id.clone(),
            flags: sync_flags(item.flags),
            tags: canon_tags(item.tags.iter().cloned()),
        }
    }

    // Server owns id/createdAt: id 0 means "not yet assigned"; push swaps in a negative placeholder.
    fn materialize(&self, n: &NormalizedSyncLocation) -> MmLocation {
        MmLocation {
            id: 0,
            location: LatLng {
                lat: n.lat,
                lng: n.lng,
            },
            pano_id: n.pano_id.clone(),
            heading: n.heading,
            pitch: n.pitch,
            zoom: Some(n.zoom),
            flags: n.flags,
            tags: n.tags.clone(),
            author: None,
            created_at: None,
            pano_date: None,
        }
    }

    fn pull(&self, remote_map_id: &str) -> AppResult<RemoteSnapshot<MmLocation>> {
        let url = format!("{BASE_URL}/api/maps/{remote_map_id}/locations");
        let resp = crate::sync_client()
            .get(&url)
            .header("authorization", format!("API {}", self.api_key))
            .header("accept", "application/protobuf")
            .send()?;
        let status = resp.status().as_u16();
        let body = resp.bytes()?;
        if !(200..300).contains(&status) {
            return Err(api_error(status, &body));
        }
        Ok(RemoteSnapshot {
            locations: decode_response(&body)?,
            token: None,
        })
    }

    fn push(
        &self,
        remote_map_id: &str,
        batch: &PushBatch<MmLocation>,
        _token: Option<i64>,
        commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        let mut post = |part: &PushPart| self.post_edit(remote_map_id, part);
        push_apply(batch, PUSH_CHUNK, commit, &mut post)
    }
}

impl MapMakingProvider {
    /// POST one chunk's edit and return the submitted-id -> assigned-id remap.
    fn post_edit(&self, remote_map_id: &str, part: &PushPart) -> AppResult<HashMap<String, i64>> {
        let url = format!("{BASE_URL}/api/maps/{remote_map_id}/locations");
        let req_body = EditRequest {
            edits: vec![Edit {
                action: EditAction {
                    kind: EDIT_ACTION_BULK,
                },
                create: part.create.clone(),
                remove: part.remove.clone(),
            }],
        };
        let resp = crate::sync_client()
            .post(&url)
            .header("authorization", format!("API {}", self.api_key))
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&req_body)?)
            .send()?;
        let status = resp.status().as_u16();
        let body = resp.bytes()?;
        if !(200..300).contains(&status) {
            return Err(api_error(status, &body));
        }
        Ok(serde_json::from_slice(&body)?)
    }
}

/// Build an [`AppError`] from a non-2xx response. Prefers a JSON body's `message`, else the body
/// text, else a status-only fallback (loosely mirrors MapMakingWebApiError). A 401 gets the
/// [`AUTH_ERROR_PREFIX`] sentinel so [`is_auth_error`] can detect it.
fn api_error(status: u16, body: &[u8]) -> AppError {
    let message = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(v) => v
            .get("message")
            .and_then(|m| m.as_str())
            .map(String::from)
            .unwrap_or_else(|| default_error_message(status)),
        Err(_) => {
            let text = String::from_utf8_lossy(body);
            let text = text.trim();
            if text.is_empty() {
                default_error_message(status)
            } else {
                text.to_string()
            }
        }
    };
    if status == 401 {
        AppError(format!("{AUTH_ERROR_PREFIX}{message}"))
    } else {
        AppError(message)
    }
}

fn default_error_message(status: u16) -> String {
    format!("map-making.app API request failed with HTTP {status}")
}

// --- push chunking (pure) ---------------------------------------------------

pub(crate) struct PushPart {
    pub create: Vec<LocationInput>,
    pub remove: Vec<i64>,
    pub staged: Vec<Staged>,
}

/// A staged create: which local id maps to which negative placeholder id.
#[derive(Clone, Copy)]
pub(crate) struct Staged {
    pub local_id: u32,
    pub neg_id: i64,
}

/// Split a push into edit requests of at most `chunk` logical operations.
///
/// An update is remove-old + create-new (a remote id churns on edit), and both halves must stay
/// in the SAME request: splitting them would leave the location duplicated on the remote in
/// between. So chunking counts logical operations, not the two arrays independently. Negative
/// placeholder ids stay unique across the whole push.
pub(crate) fn push_chunks(batch: &PushBatch<MmLocation>, chunk: usize) -> Vec<PushPart> {
    struct Op<'a> {
        local_id: Option<u32>,
        item: Option<&'a MmLocation>,
        remove: Option<i64>,
    }

    let mut ops: Vec<Op> = Vec::new();
    for (local_id, item) in &batch.create {
        ops.push(Op {
            local_id: Some(*local_id),
            item: Some(item),
            remove: None,
        });
    }
    for (local_id, item, replaces) in &batch.update {
        ops.push(Op {
            local_id: Some(*local_id),
            item: Some(item),
            remove: Some(replaces.id),
        });
    }
    for item in &batch.delete {
        ops.push(Op {
            local_id: None,
            item: None,
            remove: Some(item.id),
        });
    }

    let mut neg: i64 = -1;
    let mut parts = Vec::new();
    let mut i = 0;
    while i < ops.len() {
        let end = (i + chunk).min(ops.len());
        let mut part = PushPart {
            create: Vec::new(),
            remove: Vec::new(),
            staged: Vec::new(),
        };
        for op in &ops[i..end] {
            if let Some(r) = op.remove {
                part.remove.push(r);
            }
            if let (Some(item), Some(local_id)) = (op.item, op.local_id) {
                let neg_id = neg;
                neg -= 1;
                part.create.push(to_input(item, neg_id));
                part.staged.push(Staged { local_id, neg_id });
            }
        }
        parts.push(part);
        i = end;
    }
    parts
}

/// Chunk a push, apply each chunk via `post`, and commit each chunk's resolved ids before the
/// next request. `post` maps a chunk to its submitted-id -> assigned-id remap.
pub(crate) fn push_apply(
    batch: &PushBatch<MmLocation>,
    chunk: usize,
    commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    post: &mut dyn FnMut(&PushPart) -> AppResult<HashMap<String, i64>>,
) -> AppResult<Vec<PushedId>> {
    let mut all = Vec::new();
    for part in push_chunks(batch, chunk) {
        let remap = post(&part)?;
        let mut pushed = Vec::new();
        for s in &part.staged {
            if let Some(&remote_id) = remap.get(&s.neg_id.to_string()) {
                pushed.push(PushedId {
                    local_id: s.local_id,
                    remote_id,
                });
            }
        }
        for p in &pushed {
            all.push(*p);
        }
        // Let the caller persist this chunk before the next one can fail.
        if !pushed.is_empty() {
            commit(&pushed)?;
        }
    }
    Ok(all)
}

// --- protobuf decode (hand-rolled, proto2) ----------------------------------

/// Cursor over a protobuf byte slice.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn eof(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn read_varint(&mut self) -> AppResult<u64> {
        let mut result: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let b = *self.buf.get(self.pos).ok_or("protobuf: varint truncated")?;
            self.pos += 1;
            result |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
            if shift >= 64 {
                return Err("protobuf: varint overflow".into());
            }
        }
        Ok(result)
    }

    fn read_double(&mut self) -> AppResult<f64> {
        let end = self.pos.checked_add(8).ok_or("protobuf: 64-bit overflow")?;
        let slice = self
            .buf
            .get(self.pos..end)
            .ok_or("protobuf: 64-bit truncated")?;
        let arr: [u8; 8] = slice.try_into().expect("8-byte slice");
        self.pos = end;
        Ok(f64::from_le_bytes(arr))
    }

    fn read_bytes(&mut self) -> AppResult<&'a [u8]> {
        let len = self.read_varint()? as usize;
        let end = self
            .pos
            .checked_add(len)
            .ok_or("protobuf: length overflow")?;
        let slice = self
            .buf
            .get(self.pos..end)
            .ok_or("protobuf: length-delimited truncated")?;
        self.pos = end;
        Ok(slice)
    }

    fn read_string(&mut self) -> AppResult<String> {
        Ok(String::from_utf8_lossy(self.read_bytes()?).into_owned())
    }

    /// Advance past an unknown field of the given wire type.
    fn skip(&mut self, wire: u64) -> AppResult<()> {
        match wire {
            0 => {
                self.read_varint()?;
            }
            1 => {
                self.read_double()?;
            }
            2 => {
                self.read_bytes()?;
            }
            5 => {
                let end = self.pos.checked_add(4).ok_or("protobuf: 32-bit overflow")?;
                self.buf
                    .get(self.pos..end)
                    .ok_or("protobuf: 32-bit truncated")?;
                self.pos = end;
            }
            _ => return Err(format!("protobuf: unknown wire type {wire}").into()),
        }
        Ok(())
    }
}

/// Raw location fields before the tag table is resolved.
#[derive(Default)]
struct RawLoc {
    id: i64,
    author: Option<u32>,
    lat: f64,
    lng: f64,
    pano_id: String,
    heading: f64,
    pitch: f64,
    zoom: f64,
    tag_index: Vec<u32>,
    flags: u32,
    created_at: u64,
    pano_date: u64,
}

impl RawLoc {
    fn resolve(self, tags: &[String]) -> MmLocation {
        MmLocation {
            id: self.id,
            location: LatLng {
                lat: self.lat,
                lng: self.lng,
            },
            // Empty panoId string -> None (map-making-web-api.ts:180).
            pano_id: (!self.pano_id.is_empty()).then_some(self.pano_id),
            heading: self.heading,
            pitch: self.pitch,
            // Proto always yields a double (default 0); mirror the TS Some.
            zoom: Some(self.zoom),
            flags: self.flags,
            // Resolve indices against the table; out-of-range indices are dropped, order kept.
            tags: self
                .tag_index
                .iter()
                .filter_map(|&i| tags.get(i as usize).cloned())
                .collect(),
            author: self.author,
            created_at: (self.created_at != 0).then_some(self.created_at),
            pano_date: (self.pano_date != 0).then_some(self.pano_date),
        }
    }
}

fn decode_response(buf: &[u8]) -> AppResult<Vec<MmLocation>> {
    let mut r = Reader::new(buf);
    let mut tags: Vec<String> = Vec::new();
    let mut raw: Vec<RawLoc> = Vec::new();
    while !r.eof() {
        let tag = r.read_varint()?;
        let field = tag >> 3;
        let wire = tag & 7;
        match (field, wire) {
            (1, 2) => tags.push(r.read_string()?),
            (2, 2) => {
                let sub = r.read_bytes()?;
                raw.push(decode_location(sub)?);
            }
            _ => r.skip(wire)?,
        }
    }
    Ok(raw.into_iter().map(|rl| rl.resolve(&tags)).collect())
}

fn decode_location(buf: &[u8]) -> AppResult<RawLoc> {
    let mut r = Reader::new(buf);
    let mut loc = RawLoc::default();
    while !r.eof() {
        let tag = r.read_varint()?;
        let field = tag >> 3;
        let wire = tag & 7;
        match (field, wire) {
            (1, 0) => loc.id = r.read_varint()? as i64,
            (2, 0) => loc.author = Some(r.read_varint()? as u32),
            (3, 2) => {
                let (lat, lng) = decode_latlng(r.read_bytes()?)?;
                loc.lat = lat;
                loc.lng = lng;
            }
            (4, 2) => loc.pano_id = r.read_string()?,
            (5, 1) => loc.heading = r.read_double()?,
            (6, 1) => loc.pitch = r.read_double()?,
            (7, 1) => loc.zoom = r.read_double()?,
            (8, 2) => {
                let mut pr = Reader::new(r.read_bytes()?);
                while !pr.eof() {
                    loc.tag_index.push(pr.read_varint()? as u32);
                }
            }
            // A repeated field may also arrive unpacked; proto2 decoders must accept both.
            (8, 0) => loc.tag_index.push(r.read_varint()? as u32),
            (9, 0) => loc.flags = r.read_varint()? as u32,
            (10, 0) => loc.created_at = r.read_varint()?,
            (11, 0) => loc.pano_date = r.read_varint()?,
            _ => r.skip(wire)?,
        }
    }
    Ok(loc)
}

fn decode_latlng(buf: &[u8]) -> AppResult<(f64, f64)> {
    let mut r = Reader::new(buf);
    let (mut lat, mut lng) = (0.0, 0.0);
    while !r.eof() {
        let tag = r.read_varint()?;
        let field = tag >> 3;
        let wire = tag & 7;
        match (field, wire) {
            (1, 1) => lat = r.read_double()?,
            (2, 1) => lng = r.read_double()?,
            _ => r.skip(wire)?,
        }
    }
    Ok((lat, lng))
}

#[cfg(test)]
#[path = "sync_map_making.test.rs"]
mod tests;
