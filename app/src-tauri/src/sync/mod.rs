//! Provider-agnostic remote sync: shared types, the canonical content hash, and the provider
//! trait. The engine (sync_engine.rs) is generic over [`SyncProvider`]; diff/keying are pure.
//! The TS side keeps UI, scheduling and auth.

pub(crate) mod diff;
pub(crate) mod engine;
pub(crate) mod file;
pub(crate) mod geoguessr;
pub(crate) mod keying;
pub(crate) mod log;
pub(crate) mod map_making;
pub(crate) mod remote_mapping;

use crate::types::shape::{MapPart, MapShape};
use crate::types::wire_str_enum;
use crate::types::AppResult;
use crate::types::{Location, LocationFlags};
use mma_algebra::canonical;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

/// Keep only the persisted flag bits. [`LocationFlags::PREVIEW`] and any bit not declared at
/// all are excluded from the synced contract, so a new bit starts syncing only when it is
/// both declared and left out of `PREVIEW`, never by accident.
pub fn sync_flags(bits: u32) -> u32 {
    bits & LocationFlags::all()
        .difference(LocationFlags::PREVIEW)
        .bits()
}

/// How a provider identifies a location across syncs.
///  - `Stable`: the remote id addresses a location authoritatively (may churn on edit).
///  - `Positional`: the persisted "id" is the array index we last wrote; a pull re-verifies
///    each index by hash and realigns the ones that moved.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IdentityModel {
    Stable,
    Positional,
}

wire_str_enum! {
    /// Which way a link carries changes.
    derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)
    pub enum SyncDirection {
        /// Changes travel both ways, and conflicts wait for review.
        Bidirectional = "bidirectional",
        /// Changes only come in from the remote, which wins every conflict.
        PullOnly = "pullOnly",
    }
}

/// What a sync provider is, declared once per provider.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// The `provider` its links and mapping rows are stored under. Never changes once shipped.
    #[serde(skip)]
    pub id: &'static str,
    #[serde(skip)]
    pub identity: IdentityModel,
    pub direction: SyncDirection,
    /// What the remote keeps of a map; local content is collapsed onto it before diffing.
    pub shape: MapShape,
}

/// The syncable contract: the only fields that participate in diffing. Everything else is
/// owned by exactly one side and would register as a phantom change.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, mma_fields::Patch)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedSyncLocation {
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: f64,
    pub pano_id: Option<String>,
    /// Remote-meaningful bits only; virtual bits are stripped.
    pub flags: u32,
    /// Tag names, deduped and sorted. Empty for providers with no tag support.
    pub tags: Vec<String>,
    /// Custom fields, for a remote that keeps them; `null` for one that does not, or when empty.
    #[specta(type = Option<HashMap<String, specta_typescript::Unknown>>)]
    #[patch(merge)]
    pub extra: Option<Map<String, Value>>,
}

impl NormalizedSyncLocation {
    /// Collapse onto what `shape` keeps, so a distinction the other side cannot store never reads
    /// as a difference. Without flag bits the only one left is pinning, set exactly when a
    /// panorama remains.
    pub fn onto(self, shape: MapShape) -> Self {
        let pinned = self.flags & LocationFlags::LOAD_AS_PANO_ID.bits() != 0;
        let pano_id = if pinned || shape.keeps(MapPart::UnpinnedPano) {
            self.pano_id
        } else {
            None
        };
        let flags = if shape.keeps(MapPart::Flags) {
            self.flags
        } else if has_pano(&pano_id) {
            LocationFlags::LOAD_AS_PANO_ID.bits()
        } else {
            0
        };
        let tags = if shape.keeps(MapPart::Tags) {
            self.tags
        } else {
            vec![]
        };
        let extra = self.extra.filter(|_| shape.keeps(MapPart::AppData));
        NormalizedSyncLocation {
            pano_id,
            flags,
            tags,
            extra,
            ..self
        }
    }
}

/// A pano id is present only when non-empty; hashes were defined under JS truthiness ("" = none).
pub fn has_pano(pano: &Option<String>) -> bool {
    pano.as_deref().is_some_and(|s| !s.is_empty())
}

/// Stable identity for a synced location across runs: `L:<localId>` for mapped locations,
/// `C:<hash>#<n>` (content + occurrence counter) for unmapped ones. The diff is purely
/// identity-keyed; it never matches by content on its own.
pub type IdentityKey = String;

pub fn local_key(local_id: u32) -> IdentityKey {
    format!("L:{local_id}")
}

pub fn parse_local_key(key: &str) -> Option<u32> {
    key.strip_prefix("L:").and_then(|s| s.parse().ok())
}

/// Canonical comparable key: equal keys means the same location on the synced contract.
/// serde_json float formatting (ryu shortest round-trip) makes this deterministic. A location
/// without `extra` keys exactly as it did before `extra` joined the contract.
pub fn sync_key(n: &NormalizedSyncLocation) -> String {
    let core = (
        n.lat, n.lng, n.heading, n.pitch, n.zoom, &n.pano_id, n.flags, &n.tags,
    );
    match &n.extra {
        None => serde_json::to_string(&core),
        Some(extra) => serde_json::to_string(&(core, canonical(&Value::Object(extra.clone())))),
    }
    .expect("sync key serialization cannot fail")
}

/// cyrb53 (ported from the TS engine, over UTF-8 bytes): fast 53-bit string hash.
fn cyrb53(s: &str) -> u64 {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c6ce57;
    for &b in s.as_bytes() {
        let ch = b as u32;
        h1 = (h1 ^ ch).wrapping_mul(2654435761);
        h2 = (h2 ^ ch).wrapping_mul(1597334677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2246822507);
    h1 ^= (h2 ^ (h2 >> 13)).wrapping_mul(3266489909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2246822507);
    h2 ^= (h1 ^ (h1 >> 13)).wrapping_mul(3266489909);
    (((h2 & 0x1fffff) as u64) << 32) | h1 as u64
}

fn to_radix36(mut v: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if v == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while v > 0 {
        out.push(DIGITS[(v % 36) as usize]);
        v /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("radix36 digits are ASCII")
}

/// Compact fingerprint of the synced contract; what the mapping rows persist.
pub fn sync_hash(n: &NormalizedSyncLocation) -> String {
    to_radix36(cyrb53(&sync_key(n)))
}

pub fn canon_tags(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let set: BTreeSet<String> = names.into_iter().collect();
    set.into_iter().collect()
}

/// Project a location onto the synced contract, resolving tag ids to names (unknown ids are
/// dropped), stripping undeclared flag bits, reading an empty pano id as none, and dropping
/// null fields, which a merge patch cannot tell from absent ones.
pub fn local_to_normalized(
    loc: &Location,
    tag_name: &impl Fn(u32) -> Option<String>,
) -> NormalizedSyncLocation {
    NormalizedSyncLocation {
        lat: loc.lat,
        lng: loc.lng,
        heading: loc.heading,
        pitch: loc.pitch,
        zoom: loc.zoom,
        pano_id: loc
            .pano_id
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(Into::into),
        flags: sync_flags(loc.flags.bits()),
        tags: canon_tags(loc.tags.iter().filter_map(|&id| tag_name(id))),
        extra: loc
            .extra
            .as_ref()
            .map(|e| {
                let mut m = e.to_map();
                m.retain(|_, v| !v.is_null());
                m
            })
            .filter(|m| !m.is_empty()),
    }
}

// --- plan types -------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct SidePlan {
    pub create: Vec<IdentityKey>,
    pub update: Vec<IdentityKey>,
    pub delete: Vec<IdentityKey>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum ConflictKind {
    /// Both sides modified the same location differently.
    #[serde(rename = "update-update")]
    UpdateUpdate,
    /// One side deleted while the other modified.
    #[serde(rename = "delete-update")]
    DeleteUpdate,
    /// Both sides added the same identity with different content (hash collision only).
    #[serde(rename = "add-add")]
    AddAdd,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub key: IdentityKey,
    pub kind: ConflictKind,
    /// Base value is not persisted (only its hash), so conflicts surface local vs remote.
    pub local: Option<NormalizedSyncLocation>,
    pub remote: Option<NormalizedSyncLocation>,
}

#[derive(Clone, Debug, Default)]
pub struct SyncPlan {
    /// Apply to REMOTE (local-originated changes).
    pub push: SidePlan,
    /// Apply to LOCAL (remote-originated changes).
    pub pull: SidePlan,
    pub conflicts: Vec<Conflict>,
    /// Both sides already agree but differ from base: no apply, just advance the base.
    pub converged: Vec<IdentityKey>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SideCounts {
    pub create: u32,
    pub update: u32,
    pub delete: u32,
}

wire_str_enum! {
    /// First-sync seeding when both sides already have pins. Only meaningful on the first sync
    /// (empty mapping); afterwards it's plain three-way. `Merge` never deletes.
    derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)
    pub enum FirstSyncMode {
        /// Both maps keep everything; nothing is deleted.
        Merge = "merge",
        /// Locations only on this map are deleted so it matches the remote map.
        MirrorFromRemote = "mirrorFromRemote",
        /// Locations only on the remote map are deleted so it matches this map.
        MirrorFromLocal = "mirrorFromLocal",
    }
}

// --- provider seam ----------------------------------------------------------

/// A pull: the provider's raw locations plus whatever must echo back on the next push
/// (GeoGuessr's draft `version`).
pub struct RemoteSnapshot<R> {
    pub locations: Vec<R>,
    pub token: Option<i64>,
    /// The source's tag catalog, for the look a tag a pull creates should adopt.
    /// Empty when the source carries none.
    pub tags: Vec<RemoteTag>,
}

/// A tag as the source of a pull describes it. A tag the sync creates takes this
/// look; a tag that already exists keeps its own.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTag {
    /// The tag's name.
    pub name: String,
    /// The tag's color; null when the source names none.
    pub color: Option<String>,
    /// The tag's position in the source's ordering; null when the source keeps none.
    pub order: Option<u32>,
}

/// One entry of the full desired remote state. `local_id` is `None` for remote-only
/// locations passed through untouched.
pub struct DesiredEntry<R> {
    pub item: R,
    pub local_id: Option<u32>,
}

/// A push expressed two ways; a provider uses whichever its API speaks.
pub struct PushBatch<R> {
    pub create: Vec<(u32, R)>,
    pub update: Vec<(u32, R, R)>, // (local_id, item, replaces)
    pub delete: Vec<R>,
    /// Complete desired remote state, in the order it should be written.
    pub desired: Vec<DesiredEntry<R>>,
}

/// What a push resolved each location to. A `Positional` provider must return an entry for
/// EVERY desired entry with a local id (rewriting the document reindexes everything).
#[derive(Clone, Copy, Debug)]
pub struct PushedId {
    pub local_id: u32,
    pub remote_id: i64,
}

/// Everything the engine needs to know about one remote backend. Pure conversions plus
/// blocking network IO; the engine owns the three-way merge and all persistence.
pub trait SyncProvider {
    type Raw: Clone;

    fn spec(&self) -> &'static ProviderSpec;

    /// Stable handle for a remote location: its own id when `Stable`, `index` when `Positional`.
    fn remote_id_of(&self, item: &Self::Raw, index: usize) -> i64;

    /// Project a remote location onto the synced contract, already collapsed onto [`Self::shape`].
    fn normalize(&self, item: &Self::Raw) -> NormalizedSyncLocation;

    /// Whether a local location participates in sync at all.
    fn include_local(&self, _loc: &Location) -> bool {
        true
    }

    /// Build the provider's shape from the contract.
    fn materialize(&self, n: &NormalizedSyncLocation) -> Self::Raw;

    /// Blocking network read of the whole remote side.
    fn pull(&self, remote_map_id: &str) -> AppResult<RemoteSnapshot<Self::Raw>>;

    /// Blocking network write. `commit` persists confirmed ids as they land, so a provider
    /// that writes in several requests makes a part-way failure resumable; providers that
    /// write atomically just return their ids.
    fn push(
        &self,
        remote_map_id: &str,
        batch: &PushBatch<Self::Raw>,
        token: Option<i64>,
        commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>>;
}

#[cfg(test)]
#[path = "sync.test.rs"]
mod tests;
