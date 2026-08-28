//! Location mutations as the engine applies them: adds, patches, field-wide ops, and the `MutationResult` they report.

use super::*;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::{self, Selector};
use crate::store::maps;
use crate::store::storage;
use crate::types::RawExtra;
use crate::types::{AppError, AppResult};
use crate::types::{Location, Tag};
use crate::util;
use roaring::RoaringBitmap;
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};

/// Semantic description of what a mutation changed, independent of any consumer.
/// `finish_mutation` derives both the render delta and the selection sync from it —
/// one source of truth, two projections. `updated` carries `(old, new)` so the
/// render side can detect cell moves / pos-heading patches and the selection side
/// can re-test membership.
#[derive(Default)]
pub struct ChangeSet {
    pub added: Vec<Location>,
    pub removed: Vec<u32>,
    pub updated: Vec<(Location, Location)>,
    pub full_reset: bool,
}

impl ChangeSet {
    /// No rows moved. A metadata-only mutation (tag rename, reorder) produces one of these.
    pub(crate) fn is_empty(&self) -> bool {
        !self.full_reset
            && self.added.is_empty()
            && self.removed.is_empty()
            && self.updated.is_empty()
    }
}

/// What one mutation changed, and nothing else: every field but `version` and `delta`
/// is `None` when that part of the world did not move. JS merges each present field
/// into its state, so an untouched slice keeps its reference and its subscribers sleep.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub version: u64,
    pub delta: RenderDelta,
    pub selection_sync: Option<SelectionSync>,
    pub location_count: Option<usize>,
    pub can_undo: Option<bool>,
    pub can_redo: Option<bool>,
    /// Every tag's count, when any count moved.
    pub tag_counts: Option<HashMap<u32, usize>>,
    /// The whole registry, when any tag was created, edited, deleted, or flipped visible.
    pub tags: Option<HashMap<u32, Tag>>,
    /// The whole extra-field registry, when a key was seen for the first time or erased.
    pub field_defs: Option<HashMap<String, maps::ExtraFieldDef>>,
}

/// User-facing warning toast.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
#[tauri_specta(event_name = "store-warning")]
pub struct StoreWarning(pub String);

/// A mutation another window made to a map this window may have open, routed by `map_id`.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "store-external-mutation")]
pub struct ExternalMutation {
    #[serde(flatten)]
    pub result: MutationResult,
    pub map_id: String,
}

/// Deserialize a present-but-null JSON field as `Some(None)` instead of `None`.
/// Missing field → `None` (don't update), `null` → `Some(None)` (set to null),
/// `"value"` → `Some(Some("value"))` (set to value).
pub(super) fn nullable<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Some(Option::deserialize(deserializer)?))
}

/// Partial location update from JS. `None` fields are unchanged; `Some(None)` on
/// nullable fields (panoId, extra, modifiedAt) explicitly sets the field to null.
/// `extra` is a JSON Merge Patch (RFC 7386): keys shallow-merge, null values delete.
#[derive(Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LocationPatch {
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub heading: Option<f64>,
    pub pitch: Option<f64>,
    pub zoom: Option<f64>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<String>>)]
    pub pano_id: Option<Option<compact_str::CompactString>>,
    pub flags: Option<u32>,
    pub tags: Option<Vec<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<HashMap<String, specta_typescript::Unknown>>>)]
    pub extra: Option<Option<RawExtra>>,
    pub created_at: Option<u32>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<u32>>)]
    pub modified_at: Option<Option<u32>>,
}

/// Register every `extra` key the store has not seen, with an inferred definition.
pub(crate) fn auto_register_extras(store: &mut Store, extras: &[&RawExtra]) {
    if let Some(new_defs) =
        maps::auto_register_field_defs(|k| store.field_defs.contains_key(k), extras)
    {
        apply_field_defs(store, new_defs);
    }
}

/// Persist newly-discovered extra-field definitions to SQLite and into the store's
/// registry. An existing definition is never overwritten, on disk or in memory.
pub(crate) fn apply_field_defs(store: &mut Store, new_defs: HashMap<String, maps::ExtraFieldDef>) {
    if let Some(map_id) = &store.map_id {
        if let Ok(conn) = storage::open_db() {
            let _ = maps::persist_field_defs(&conn, map_id, &new_defs);
        }
    }
    for (key, def) in new_defs {
        if !store.field_defs.contains_key(&key) {
            store.field_defs.edit().insert(key, def);
        }
    }
}

/// Allocate IDs for `locations`, insert them, and record the undo entry. The one place a
/// batch of new locations becomes a mutation -- every add path (direct IPC, uploaded chunks)
/// ends here, so they cannot drift in what they record.
pub(crate) fn apply_adds(store: &mut Store, mut locations: Vec<Location>) -> MutationResult {
    for loc in &mut locations {
        loc.id = store.alloc_id();
    }
    store.push_undo(EditEntry {
        created: locations.clone(),
        removed: Vec::new(),
    });
    store.edits.redo.clear();
    store.add_tag_counts(&locations);
    let added = locations.clone();
    store.overlay_add(locations);
    let extras: Vec<&RawExtra> = added.iter().filter_map(|l| l.extra.as_ref()).collect();
    auto_register_extras(store, &extras);
    store.finish_mutation(&ChangeSet {
        added: added.clone(),
        ..Default::default()
    })
}

/// Apply `{id, patch}` updates: overlay, tag counts, undo, extras registration. The one
/// place a patch batch becomes a mutation -- every command that derives patches ends here.
pub(crate) fn apply_updates(
    store: &mut Store,
    updates: &[Update<LocationPatch>],
    record_undo: bool,
) -> MutationResult {
    let mut updated: Vec<(Location, Location)> = Vec::with_capacity(updates.len());
    let any_tags = updates.iter().any(|u| u.patch.tags.is_some());
    let any_extras = updates.iter().any(|u| u.patch.extra.is_some());
    for u in updates {
        if let Some((old, new)) = store.overlay_update(u.id, &u.patch) {
            if old != new {
                updated.push((old, new));
            }
        }
    }
    if any_tags {
        store.remove_tag_counts(updated.iter().map(|(o, _)| o));
        store.add_tag_counts(updated.iter().map(|(_, n)| n));
    }
    let extras: Vec<RawExtra> = if any_extras {
        updated
            .iter()
            .filter_map(|(_, n)| n.extra.clone())
            .collect()
    } else {
        Vec::new()
    };
    if any_extras {
        let refs: Vec<&RawExtra> = extras.iter().collect();
        auto_register_extras(store, &refs);
    }
    let changes = ChangeSet {
        updated,
        ..Default::default()
    };
    let mut result = store.finish_mutation(&changes);
    // Undo is recorded after the mutation is finished so the pairs move into the entry
    // instead of being cloned; report again so the stack change rides along.
    if record_undo && store.record_update_undo(changes.updated) {
        store.report(&mut result);
    }
    result
}

/// When a move target already holds a value, which side survives.
#[derive(serde::Deserialize, specta::Type, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MergeWinner {
    From,
    To,
}

/// A field-wide rewrite of the `extra` map. Patches are derived *per row*, which is what
/// separates these from `store_update_locations`' explicit patch list.
#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FieldOp {
    /// Rename `from` into `to`. Merge is the same operation -- rename is just the case
    /// where nothing holds `to` -- so `winner` decides only where a row holds both.
    Move {
        from: String,
        to: String,
        winner: MergeWinner,
    },
    /// Drop `keys` from every row that has them.
    Delete { keys: Vec<String> },
    /// Assign `value` to `key` on every row where it differs. A writable built-in key
    /// (`heading`, `pitch`, `zoom`) patches its column; anything else writes `extra`.
    Set {
        key: String,
        #[specta(type = specta_typescript::Unknown)]
        value: serde_json::Value,
    },
    /// Assign `key = expr(row)` per row. A row where the expression cannot evaluate (a
    /// missing or non-numeric field, a non-finite result) is skipped and counted.
    Expr { key: String, expr: String },
}

/// What a field op planned: the patches for the rows it changes, the removed keys that
/// no longer exist on any row, and the rows an expression could not evaluate.
#[derive(Default)]
pub(super) struct FieldPlan {
    pub(super) updates: Vec<Update<LocationPatch>>,
    pub(super) forget: Vec<String>,
    pub(super) skipped: u32,
}

/// The op's outcome for the caller: the mutation plus the counts its message needs.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldOpResult {
    pub mutation: MutationResult,
    /// Rows the op patched.
    pub changed: u32,
    /// Rows an expression could not evaluate.
    pub skipped: u32,
}

/// Two field values are the same when JSON says so, except numbers, which compare by
/// value: an integer stored as `45` equals the `45.0` an expression computes.
pub(super) fn same_field_value(
    current: Option<&serde_json::Value>,
    next: &serde_json::Value,
) -> bool {
    match (current, next) {
        (Some(c), n) if c.is_number() && n.is_number() => c.as_f64() == n.as_f64(),
        (c, n) => c == Some(n),
    }
}

/// A computed number as the JSON a JS writer would have stored: whole values as
/// integers, the rest as floats.
pub(super) fn number_value(v: f64) -> serde_json::Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        serde_json::Value::from(v as i64)
    } else {
        serde_json::Value::from(v)
    }
}

/// The patch assigning `value` to `key`: a writable built-in column directly, anything
/// else as an `extra` merge.
pub(super) fn assign_patch(key: &str, value: serde_json::Value) -> AppResult<LocationPatch> {
    if selections::is_writable_builtin(key) {
        Ok(serde_json::from_value(serde_json::json!({ key: value }))?)
    } else {
        let mut merge = serde_json::Map::new();
        merge.insert(key.to_string(), value);
        Ok(LocationPatch {
            extra: Some(RawExtra::from_map(&merge)),
            ..Default::default()
        })
    }
}

/// Derive the patch each selected row needs for `op`. Rows the op wouldn't change yield
/// nothing, so the patch list is the changed set. Also reports which of the op's removed
/// keys no longer exist on ANY row afterward -- the caller forgets those in
/// `known_field_keys`, so a later reappearance of the key is re-announced to JS. Pure.
pub(super) fn plan_field_op(
    view: &selections::LocView,
    set: Option<&RoaringBitmap>,
    op: &FieldOp,
) -> AppResult<FieldPlan> {
    let removed: Vec<String> = match op {
        FieldOp::Move { from, to, .. } if from != to && !to.is_empty() => vec![from.clone()],
        FieldOp::Move { .. } => return Ok(FieldPlan::default()),
        FieldOp::Delete { keys } => keys.clone(),
        FieldOp::Set { .. } | FieldOp::Expr { .. } => Vec::new(),
    };
    let expr = match op {
        FieldOp::Expr { expr, .. } => Some(field_expr::parse(expr)?),
        _ => None,
    };
    let mut plan = FieldPlan::default();
    let mut survives: HashSet<String> = HashSet::new();
    let mut failed: Option<AppError> = None;
    view.for_each(|row| {
        let id = row.id();
        let mut merge = serde_json::Map::new();
        if set.is_none_or(|s| s.contains(id)) {
            match op {
                FieldOp::Set { key, value } => {
                    if !same_field_value(row.resolve_field(key).as_ref(), value) {
                        match assign_patch(key, value.clone()) {
                            Ok(patch) => plan.updates.push(Update { id, patch }),
                            Err(e) => failed = Some(e),
                        }
                    }
                }
                FieldOp::Expr { key, .. } => {
                    let expr = expr.as_ref().expect("parsed above");
                    let field = |name: &str| row.resolve_field(name).and_then(|v| v.as_f64());
                    match field_expr::eval(expr, &field) {
                        None => plan.skipped += 1,
                        Some(v) => {
                            let value = number_value(v);
                            if !same_field_value(row.resolve_field(key).as_ref(), &value) {
                                match assign_patch(key, value) {
                                    Ok(patch) => plan.updates.push(Update { id, patch }),
                                    Err(e) => failed = Some(e),
                                }
                            }
                        }
                    }
                }
                FieldOp::Move { from, to, winner } => {
                    if let Some(value) = row.resolve_field(from) {
                        merge.insert(from.clone(), serde_json::Value::Null);
                        // Winner decides only where the row already holds `to`.
                        if *winner == MergeWinner::From || row.resolve_field(to).is_none() {
                            merge.insert(to.clone(), value);
                        }
                    }
                }
                FieldOp::Delete { keys } => {
                    for key in keys {
                        if row.resolve_field(key).is_some() {
                            merge.insert(key.clone(), serde_json::Value::Null);
                        }
                    }
                }
            }
        }
        // A removed key survives on any row this op leaves it on (unselected, or absent
        // from the patch).
        for k in &removed {
            if merge.get(k) != Some(&serde_json::Value::Null)
                && !survives.contains(k)
                && row.resolve_field(k).is_some()
            {
                survives.insert(k.clone());
            }
        }
        if !merge.is_empty() {
            plan.updates.push(Update {
                id,
                patch: LocationPatch {
                    extra: Some(RawExtra::from_map(&merge)),
                    ..Default::default()
                },
            });
        }
    });
    if let Some(e) = failed {
        return Err(e);
    }
    plan.forget = removed
        .into_iter()
        .filter(|k| !survives.contains(k))
        .collect();
    Ok(plan)
}

/// The keys an op may only reach through `extra`, and the shape a built-in assignment
/// must have. A built-in name written through `extra` would silently shadow a column.
pub(super) fn check_field_op(op: &FieldOp) -> AppResult<()> {
    let extra_keys: Vec<&str> = match op {
        FieldOp::Move { from, to, .. } => vec![from.as_str(), to.as_str()],
        FieldOp::Delete { keys } => keys.iter().map(String::as_str).collect(),
        FieldOp::Set { key, .. } | FieldOp::Expr { key, .. } => {
            if selections::is_writable_builtin(key) {
                Vec::new()
            } else {
                vec![key.as_str()]
            }
        }
    };
    if let Some(k) = extra_keys.iter().find(|k| selections::is_builtin_field(k)) {
        return Err(AppError::from(format!(
            "store_apply_field_op: {k} is a built-in field"
        )));
    }
    if let FieldOp::Set { key, value } = op {
        if selections::is_writable_builtin(key) && !value.is_number() {
            return Err(AppError::from(format!(
                "store_apply_field_op: {key} takes a number"
            )));
        }
    }
    Ok(())
}

/// Rewrite a field across the selected set in one pass. Replaces fetching every location
/// into JS to derive patches and shipping them all back. Keeps `known_field_keys`
/// truthful: keys the op erased from every row are forgotten (before the status snapshot),
/// so `StoreStatus.knownFieldKeys` reflects the data and a reappearing key is re-announced
/// through `new_field_defs`.
pub(crate) fn apply_field_op(
    store: &mut Store,
    selector: &Selector,
    op: &FieldOp,
    record_undo: bool,
) -> AppResult<FieldOpResult> {
    check_field_op(op)?;
    let plan = {
        let view = store.loc_view();
        let resolved = selections::narrow(&view, selector);
        plan_field_op(&view, resolved.as_ref(), op)?
    };
    for k in &plan.forget {
        if store.field_defs.contains_key(k) {
            store.field_defs.edit().remove(k);
        }
    }
    Ok(FieldOpResult {
        changed: plan.updates.len() as u32,
        skipped: plan.skipped,
        mutation: apply_updates(store, &plan.updates, record_undo),
    })
}

/// Generic `{id, patch}` update envelope, parameterized by the patch type. Specta
/// has no `Partial<T>`, and a patch is a deliberate *subset* of patchable fields, so
/// each entity names its own patch struct (e.g. `TagPatch`) rather than deriving one.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Update<P> {
    pub id: u32,
    pub patch: P,
}

/// Result of a cross-map location copy. `target_name` feeds the toast.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyToMapResult {
    pub copied: u32,
    pub skipped: u32,
    pub target_name: String,
}

/// Cross-map dedup: a source is a duplicate of a target location if they share a
/// panoId (when the source has one) or exact lat/lng bits (pano-less sources).
/// Makes the copy hotkey idempotent; fuzzy spatial matching stays the job of the
/// in-map Duplicates selection.
pub(crate) fn split_new_locations(
    sources: Vec<Location>,
    existing: &[Location],
) -> (Vec<Location>, u32) {
    let mut panos: HashSet<&str> = HashSet::new();
    let mut coords: HashSet<(u64, u64)> = HashSet::new();
    for l in existing {
        if let Some(p) = &l.pano_id {
            if !p.is_empty() {
                panos.insert(p.as_str());
            }
        }
        coords.insert((l.lat.to_bits(), l.lng.to_bits()));
    }
    let mut fresh = Vec::new();
    let mut skipped = 0u32;
    for l in sources {
        let dup = match &l.pano_id {
            Some(p) if !p.is_empty() => panos.contains(p.as_str()),
            _ => coords.contains(&(l.lat.to_bits(), l.lng.to_bits())),
        };
        if dup {
            skipped += 1;
        } else {
            fresh.push(l);
        }
    }
    (fresh, skipped)
}

/// Fold a duplicate group into one survivor. Survivor = highest `score` (the map's
/// duplicate preference expression, or tag count when it has none), then earliest
/// `created_at`, then lowest id (`max_by` picks the greatest, so created_at/id are
/// reversed to favour smaller). A location the expression can't evaluate ranks below
/// every one it can. Tags are set-unioned; `extra` is merged with the survivor winning
/// key conflicts; all other survivor fields are kept. `members` must be non-empty. The
/// returned survivor keeps its original id (so callers represent the merge as an update
/// of the survivor plus removal of the rest).
pub(crate) fn merge_group(members: &[Location], score: Option<&Expr>) -> Location {
    let rank = |l: &Location| -> Option<f64> {
        let Some(expr) = score else {
            return Some(l.tags.len() as f64);
        };
        let row = selections::RowRef::from_loc(l);
        field_expr::eval(expr, &|name| {
            row.resolve_field(name)
                .as_ref()
                .and_then(serde_json::Value::as_f64)
        })
    };
    let survivor = members
        .iter()
        .max_by(|a, b| {
            // Option orders None below Some; eval never yields NaN, so partial_cmp is total.
            rank(a)
                .partial_cmp(&rank(b))
                .unwrap_or(Ordering::Equal)
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| b.id.cmp(&a.id))
        })
        .expect("merge_group requires a non-empty group");

    let mut tagset: BTreeSet<u32> = BTreeSet::new();
    for m in members {
        tagset.extend(m.tags.iter().copied());
    }

    // Non-survivors in id order first, survivor last so its values win conflicts.
    let mut merged_extra = serde_json::Map::new();
    let mut others: Vec<&Location> = members.iter().filter(|m| m.id != survivor.id).collect();
    others.sort_by_key(|m| m.id);
    for m in others {
        if let Some(e) = &m.extra {
            for (k, v) in e.to_map() {
                merged_extra.insert(k, v);
            }
        }
    }
    if let Some(e) = &survivor.extra {
        for (k, v) in e.to_map() {
            merged_extra.insert(k, v);
        }
    }

    let mut new_survivor = survivor.clone();
    new_survivor.tags = tagset.into_iter().collect();
    new_survivor.extra = RawExtra::from_map(&merged_extra);
    new_survivor.modified_at = Some(util::now_unix());
    new_survivor
}
