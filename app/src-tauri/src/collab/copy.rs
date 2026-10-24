//! A peer's copy of a hosted map: where it came from, and whether it moved since.

use super::protocol::Snapshot;
use crate::store::engine::{Store, StoreState, ValueRecord};
use crate::store::maps::{self, FieldDef, MapMeta};
use crate::store::storage;
use crate::types::AppResult;
use crate::util;
use mma_algebra::{Id, Json, Patch, Patchable};
use std::collections::BTreeMap;

/// Where a copy of another app's map came from.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Origin {
    /// The login of the app that hosts the map.
    pub(crate) host: String,
    /// The map's id on its host.
    pub(crate) map: Id<MapMeta, String>,
    /// The login this app followed it as.
    pub(crate) login: String,
    /// What the copy held when its last session ended.
    pub(crate) parted: Option<String>,
    /// How this app joins the map again.
    pub(crate) via: Via,
}

/// How this app reaches a map another app hosts.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(untagged)]
pub(crate) enum Via {
    /// By its host and its id there, as an account the map is shared with.
    Map {
        host: String,
        map: Id<MapMeta, String>,
    },
    /// By the invite code its host gave, as a guest.
    Code { code: String },
}

/// A map in this app copied from another app's, and where it came from.
#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
pub(crate) struct CollabCopy {
    /// This app's map.
    pub(crate) map: Id<MapMeta, String>,
    /// Where it came from.
    pub(crate) origin: Origin,
}

/// The plugin a copy keeps its origin under, in its map's device-local plugin data.
const PLUGIN: &str = "collab";

impl Origin {
    /// The patch marking the map `meta` describes as a copy from here.
    pub(crate) fn stamp(&self, meta: &MapMeta) -> AppResult<Patch<MapMeta>> {
        let mut stamped = meta.clone();
        stamped
            .local_plugin_data
            .entry(PLUGIN.into())
            .or_default()
            .insert("origin".into(), Json(serde_json::to_value(self)?));
        Ok(MapMeta::between(meta, &stamped))
    }

    /// Where the map `meta` describes was copied from, when it is a copy.
    fn of(meta: &MapMeta) -> Option<Self> {
        serde_json::from_value(meta.local_plugin_data.get(PLUGIN)?.get("origin")?.0.clone()).ok()
    }
}

/// Every map in this app copied from another app's, an open one as its store holds it.
pub(crate) fn copies(state: &StoreState) -> AppResult<Vec<CollabCopy>> {
    let rows = maps::list_map_rows(&*storage::open_db()?)?;
    let mgr = state.lock()?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let meta = mgr.current(row);
            Some(CollabCopy {
                origin: Origin::of(&meta)?,
                map: meta.id,
            })
        })
        .collect())
}

/// A digest of what `store`'s map shares with a session.
pub(super) fn digest(store: &Store) -> AppResult<String> {
    let Snapshot { head, rows } = Snapshot::of(store, 0);
    let records: BTreeMap<&String, BTreeMap<Id<ValueRecord>, &ValueRecord>> = head
        .records
        .iter()
        .map(|(field, records)| (field, records.iter().map(|(id, r)| (*id, r)).collect()))
        .collect();
    let defs: BTreeMap<&String, &FieldDef> = head.defs.iter().collect();
    let mut details = serde_json::to_value(MapMeta::default().patched(&head.meta))?;
    details.sort_all_objects();
    let shared = postcard::to_stdvec(&(rows, records, defs, Json(details)))?;
    Ok(util::sha256_hex(&shared))
}

#[cfg(test)]
#[path = "copy.test.rs"]
mod tests;
