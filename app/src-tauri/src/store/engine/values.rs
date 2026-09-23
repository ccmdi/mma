//! Interned field values: the per-map record store for fields whose values are ids the
//! store allocates. Which fields those are is declared on the field table
//! (`BuiltinField::interned`); `tags` is the first. The engine owns the records for the
//! open map - ids are allocated here, import/copy reconcile through here, and every
//! change ships on the mutation result - so no second writer can race the allocation.
//!
//! A record is a pile of data: `id -> opaque JSON object`. This layer stores, merges,
//! persists, and ships piles without a schema; a typed shape (a `Tag`) exists only
//! where a consumer coerces a pile to one at its own boundary. The layer interprets
//! exactly two keys: `name` (the interned identity - matching, collision) and `order`
//! (the display order the reorder op writes). Everything else passes through unread.
//!
//! Visibility is never stored: a value shows while rows carry it (its count is its
//! postings' cardinality), so undo restoring rows revives a deleted value with no
//! machinery, and an emptied record just lingers dark until its name is reused.

use super::*;
use crate::selections;
use crate::store::storage;
use crate::types::{AppError, AppResult};
use std::collections::HashMap;

/// One interned value's record: just a pile of data.
pub type ValueRecord = serde_json::Map<String, serde_json::Value>;

/// The pile's `name` key, when it holds a usable one.
pub(crate) fn record_name(rec: &ValueRecord) -> Option<&str> {
    rec.get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The pile's `order` key, when it holds one.
pub(crate) fn record_order(rec: &ValueRecord) -> Option<u32> {
    rec.get("order")
        .and_then(serde_json::Value::as_u64)
        .map(|o| o as u32)
}

/// One batch of record edits for an interned field's values.
#[derive(serde::Deserialize, specta::Type, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FieldValuesPatch {
    /// Seed piles to get-or-create, matched case-insensitively on their `name`.
    /// An existing name resolves to its id and the seed is dropped; a new one is
    /// interned as the seed.
    #[specta(type = Vec<HashMap<String, specta_typescript::Unknown>>)]
    pub create: Vec<ValueRecord>,
    /// Merge patches into existing piles (null deletes a key). A patch whose `name`
    /// collides with another record's merges the two values instead of renaming:
    /// every row is remapped to the survivor in one undoable edit and the emptied
    /// record goes dark.
    #[specta(type = Vec<Update<HashMap<String, specta_typescript::Unknown>>>)]
    pub update: Vec<Update<ValueRecord>>,
    /// New display order: each id gets its index in this list as `order`.
    pub reorder: Option<Vec<u32>>,
}

/// The id resolved for each `create` seed in request order, plus the mutation carrying
/// the updated records (and any rows a merge moved). JS coerces piles to its own view;
/// nothing typed rides here.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldValuesResult {
    pub resolved: Vec<u32>,
    pub mutation: MutationResult,
}

/// JSON merge patch into a pile: null deletes a key, anything else lands as-is. The
/// one interpreted key is `name`: a blank or non-string value is ignored, so the
/// identity never goes blank.
fn merge_record(rec: &mut ValueRecord, patch: &ValueRecord) {
    for (k, v) in patch {
        if k == "name" {
            if let Some(trimmed) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                rec.insert(k.clone(), trimmed.into());
            }
        } else if v.is_null() {
            rec.remove(k);
        } else {
            rec.insert(k.clone(), v.clone());
        }
    }
}

/// Merge `source` piles into `target` by case-insensitive `name` matching: matches
/// remap to the existing target id; misses are inserted as a clone of the source pile
/// under a fresh id above `floor` (the highest id the target's data or metadata
/// already uses). Returns the `{source_id -> target_id}` remap table (keyed by each
/// source pile's position) and whether `target` changed. Single source of truth for
/// value reconciliation - used by import and cross-map copy.
///
/// Order semantics: source order values are never stored verbatim. Every ordered
/// source pile whose target has no order yet (newly created, or an existing record
/// without one) is appended after the target's max order, dense, sorted by
/// (source order, name). Targets with a concrete order keep it; unordered sources stay
/// unordered.
///
/// Every other key follows a claim-if-empty rule: a matched target adopts each source
/// key it lacks; keys it already holds are never overwritten by import.
pub(crate) fn reconcile_values_by_name(
    source: &[(u32, ValueRecord)],
    target: &mut HashMap<u32, ValueRecord>,
    floor: u32,
) -> (HashMap<u32, u32>, bool) {
    let mut next_id = target.keys().max().copied().unwrap_or(0).max(floor) + 1;
    let mut name_to_id: HashMap<String, u32> = target
        .iter()
        .filter_map(|(&id, r)| record_name(r).map(|n| (n.to_lowercase(), id)))
        .collect();
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let mut created = false;
    let mut adopted = false;
    let mut claims: Vec<(u32, u32, String)> = Vec::new();
    let mut claimed: HashSet<u32> = HashSet::new();
    for (source_id, rec) in source {
        let Some(name) = record_name(rec) else {
            continue;
        };
        let lower = name.to_lowercase();
        let target_id = match name_to_id.get(&lower) {
            Some(&id) => id,
            None => {
                let id = next_id;
                next_id += 1;
                let mut fresh = rec.clone();
                fresh.remove("order");
                target.insert(id, fresh);
                name_to_id.insert(lower.clone(), id);
                created = true;
                id
            }
        };
        if let Some(src_order) = record_order(rec) {
            if record_order(&target[&target_id]).is_none() && claimed.insert(target_id) {
                claims.push((target_id, src_order, lower));
            }
        }
        let entry = target.get_mut(&target_id).unwrap();
        for (k, v) in rec {
            if k != "order" && !entry.contains_key(k) {
                entry.insert(k.clone(), v.clone());
                adopted = true;
            }
        }
        remap.insert(*source_id, target_id);
    }
    claims.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)));
    let changed = created || adopted || !claims.is_empty();
    let next_order = target
        .values()
        .filter_map(record_order)
        .max()
        .map_or(1, |m| m + 1);
    for (i, (id, _, _)) in claims.into_iter().enumerate() {
        target
            .get_mut(&id)
            .unwrap()
            .insert("order".into(), (next_order + i as u32).into());
    }
    (remap, changed)
}

impl Store {
    /// Whether `field` declares interned values.
    fn is_interned(field: &str) -> bool {
        selections::BUILTIN_FIELDS
            .iter()
            .any(|f| f.key == field && f.interned)
    }

    /// Every id `field`'s metadata or data already uses; fresh ids allocate above it.
    /// The data side matters when metadata was deleted out from under rows that still
    /// carry the ids.
    pub(crate) fn intern_floor(&mut self, field: &str) -> u32 {
        let data_max = self
            .value_counts(field)
            .keys()
            .filter_map(|k| k.parse::<f64>().ok().map(|f| f as u32))
            .max()
            .unwrap_or(0);
        let meta_max = self
            .value_meta
            .get(field)
            .and_then(|m| m.keys().max().copied())
            .unwrap_or(0);
        data_max.max(meta_max)
    }

    /// Write `field`'s records to their disk home when they have unsaved edits.
    /// Write-through: called beside every record edit, the same pattern
    /// `register_fields` uses for field definitions.
    pub(crate) fn persist_value_meta(&mut self, field: &str) {
        let Some(map_id) = self.map_id.clone() else {
            return;
        };
        let Some(meta) = self.value_meta.get_mut(field) else {
            return;
        };
        if !meta.is_unsaved() {
            return;
        }
        if let Ok(conn) = storage::open_db() {
            let result = match field {
                "tags" => write_tags_json(&conn, &map_id, meta),
                _ => Ok(()),
            };
            match result {
                Ok(()) => meta.mark_saved(),
                Err(e) => log::error!("[values] persisting '{field}' records failed: {e}"),
            }
        }
    }

    /// Get-or-create records for `seeds` (case-insensitive on `name`), returning each
    /// seed's id in request order. A new seed is stored as-is except `order`, which is
    /// assigned past the current display order. Seeds without a usable `name` are
    /// rejected.
    pub(crate) fn intern(&mut self, field: &str, seeds: &[ValueRecord]) -> AppResult<Vec<u32>> {
        let floor = self.intern_floor(field);
        let meta = self.value_meta.entry(field.to_string()).or_default();
        let mut name_to_id: HashMap<String, u32> = meta
            .iter()
            .filter_map(|(&id, r)| record_name(r).map(|n| (n.to_lowercase(), id)))
            .collect();
        let mut next_id = floor + 1;
        let mut next_order = meta
            .values()
            .filter_map(record_order)
            .max()
            .map_or(1, |m| m + 1);
        let mut resolved = Vec::with_capacity(seeds.len());
        for seed in seeds {
            let Some(name) = record_name(seed) else {
                return Err(AppError("an interned value needs a name".into()));
            };
            let id = match name_to_id.get(&name.to_lowercase()) {
                Some(&id) => id,
                None => {
                    let id = next_id;
                    next_id += 1;
                    let mut rec = seed.clone();
                    rec.insert("name".into(), name.into());
                    rec.insert("order".into(), next_order.into());
                    meta.edit().insert(id, rec);
                    next_order += 1;
                    name_to_id.insert(name.to_lowercase(), id);
                    id
                }
            };
            resolved.push(id);
        }
        Ok(resolved)
    }

    /// Apply one batch of record edits to an interned field: create seeds, merge
    /// patches, reorder. A rename collision merges values (rows move, one undoable
    /// edit); everything else moves no rows. Membership goes through the ordinary
    /// `ListSet` field op.
    pub(crate) fn patch_field_values(
        &mut self,
        field: &str,
        patch: &FieldValuesPatch,
    ) -> AppResult<FieldValuesResult> {
        if !Self::is_interned(field) {
            return Err(AppError(format!("'{field}' does not intern its values")));
        }
        let resolved = self.intern(field, &patch.create)?;
        let counted: HashSet<u32> = self
            .value_counts(field)
            .keys()
            .filter_map(|k| k.parse::<f64>().ok().map(|f| f as u32))
            .collect();
        let mut merges: HashMap<u32, u32> = HashMap::new();
        {
            let meta = self.value_meta.entry(field.to_string()).or_default();
            for u in &patch.update {
                let target = u
                    .patch
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .and_then(|name| {
                        let lower = name.to_lowercase();
                        meta.iter()
                            .find(|(&id, r)| {
                                id != u.id
                                    && record_name(r).is_some_and(|n| n.to_lowercase() == lower)
                            })
                            .map(|(&id, _)| id)
                    });
                if let Some(target_id) = target {
                    merges.insert(u.id, target_id);
                } else if meta.contains_key(&u.id) || counted.contains(&u.id) {
                    // A counted id without a record is a value data knows but metadata
                    // doesn't (foreign import); patching it materializes the pile.
                    let rec = meta.edit().entry(u.id).or_default();
                    merge_record(rec, &u.patch);
                }
            }
            if let Some(ordered) = &patch.reorder {
                for (i, id) in ordered.iter().enumerate() {
                    if let Some(r) = meta.edit().get_mut(id) {
                        r.insert("order".into(), (i as u32).into());
                    }
                }
            }
        }
        self.persist_value_meta(field);
        let (remove, create) = self.plan_value_merges(field, &merges)?;
        Ok(FieldValuesResult {
            resolved,
            mutation: self.apply_undoable(remove, create),
        })
    }

    /// Rows to rewrite so every id in `merges` disappears from the data in favor of its
    /// target. One scan of the live view; chains (a target that is itself merged) are
    /// followed in the map, so a batch of colliding renames lands in one edit.
    fn plan_value_merges(
        &mut self,
        field: &str,
        merges: &HashMap<u32, u32>,
    ) -> AppResult<(Vec<Location>, Vec<Location>)> {
        if merges.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let resolve = |mut id: u32| {
            let mut seen = HashSet::new();
            while let Some(&next) = merges.get(&id) {
                if !seen.insert(id) {
                    break;
                }
                id = next;
            }
            id
        };
        let mut patches: Vec<(Location, LocationPatch)> = Vec::new();
        let mut err: Option<AppError> = None;
        {
            for row in self.all().rows() {
                let Some(serde_json::Value::Array(list)) = row.resolve_field(field) else {
                    continue;
                };
                let current: Vec<u32> = list
                    .iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u32))
                    .collect();
                if !current.iter().any(|id| merges.contains_key(id)) {
                    continue;
                }
                let mut next: Vec<u32> = Vec::with_capacity(current.len());
                for &id in &current {
                    let mapped = resolve(id);
                    if !next.contains(&mapped) {
                        next.push(mapped);
                    }
                }
                let assignment = [(field.to_string(), serde_json::json!(next))]
                    .into_iter()
                    .collect();
                match assign_patch(&assignment, row.flags()) {
                    Ok(p) => patches.push((row.to_location(), p)),
                    Err(e) => err = Some(e),
                }
            }
        }
        if let Some(e) = err {
            return Err(e);
        }
        let mut remove = Vec::with_capacity(patches.len());
        let mut create = Vec::with_capacity(patches.len());
        for (old, patch) in patches {
            let mut new_loc = patched(&old, &patch);
            touch(&mut new_loc);
            create.push(new_loc);
            remove.push(old);
        }
        Ok((remove, create))
    }
}
