//! Metadata for interned field values, such as tags.
//! Records are JSON objects keyed by id. Names identify values, order controls display,
//! and missing colours are derived from names. Other metadata is preserved.
//! Values are visible while rows reference them; empty records remain available for reuse.

use super::*;
use crate::selections;
use crate::types::{AppError, AppResult};
use mma_algebra::{Merge, Op, Patch};
use std::collections::HashMap;

/// Metadata for one interned value.
pub type ValueRecord = serde_json::Map<String, serde_json::Value>;

/// The record's non-blank name, if present.
pub(crate) fn record_name(rec: &ValueRecord) -> Option<&str> {
    rec.get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Fill in a missing colour from the record's name. Returns whether it changed.
pub(crate) fn ensure_color(rec: &mut ValueRecord) -> bool {
    if rec.get("color").is_some_and(serde_json::Value::is_string) {
        return false;
    }
    let Some(color) = record_name(rec).map(util::color_for_name) else {
        return false;
    };
    rec.insert("color".into(), color.into());
    true
}

/// The record's display order, if present.
pub(crate) fn record_order(rec: &ValueRecord) -> Option<u32> {
    rec.get("order")
        .and_then(serde_json::Value::as_u64)
        .map(|o| o as u32)
}

/// One batch of record edits for an interned field's values.
#[derive(serde::Deserialize, specta::Type, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FieldValuesPatch {
    /// Create records by name, reusing existing ids case-insensitively.
    #[specta(type = Vec<HashMap<String, specta_typescript::Unknown>>)]
    pub create: Vec<ValueRecord>,
    /// Patch records by id; null deletes a metadata key.
    /// Renaming to an existing name merges the values and remaps their rows in one undoable edit.
    #[specta(type = Vec<HashMap<String, specta_typescript::Unknown>>)]
    pub update: Vec<ValueRecord>,
    /// New display order: each id gets its index in this list as `order`.
    pub reorder: Option<Vec<u32>>,
}

/// Resolved ids for `create`, in request order, and the mutation result.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldValuesResult {
    pub resolved: Vec<u32>,
    pub mutation: Mutation,
}

/// Merge a record patch, trimming names and ignoring blank or non-string names.
fn merge_record(rec: &mut ValueRecord, mut patch: ValueRecord) {
    match record_name(&patch).map(str::to_string) {
        Some(name) => patch.insert("name".into(), name.into()),
        None => patch.remove("name"),
    };
    *rec = Merge::merged(&Some(rec.clone()), &mma_algebra::Field::Set(patch)).unwrap_or_default();
}

/// Match source records to target records by name, case-insensitively, and return the id remap.
/// New ids are allocated above `floor`; existing metadata wins conflicts.
/// Source display order is appended after the target's order, preserving existing target positions.
pub(crate) fn reconcile_values_by_name(
    source: &[(u32, ValueRecord)],
    target: &mut HashMap<u32, ValueRecord>,
    floor: u32,
) -> HashMap<u32, u32> {
    let mut next_id = target.keys().max().copied().unwrap_or(0).max(floor) + 1;
    let mut name_to_id: HashMap<String, u32> = target
        .iter()
        .filter_map(|(&id, r)| record_name(r).map(|n| (n.to_lowercase(), id)))
        .collect();
    let mut remap: HashMap<u32, u32> = HashMap::new();
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
            }
        }
        remap.insert(*source_id, target_id);
    }
    claims.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)));
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
    remap
}

/// Create or reuse records by name and return ids in request order.
/// New ids exceed `floor`; new records are appended to the display order. Blank names are rejected.
fn intern(
    meta: &mut HashMap<u32, ValueRecord>,
    floor: u32,
    seeds: &[ValueRecord],
) -> AppResult<Vec<u32>> {
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
                ensure_color(&mut rec);
                meta.insert(id, rec);
                next_order += 1;
                name_to_id.insert(name.to_lowercase(), id);
                id
            }
        };
        resolved.push(id);
    }
    Ok(resolved)
}

pub(crate) struct FieldValues<'a> {
    field: &'a str,
    index: &'a selections::FieldIndex,
    records: Option<&'a HashMap<u32, ValueRecord>>,
}

impl<'a> FieldValues<'a> {
    pub(super) fn new(
        field: &'a str,
        index: &'a selections::FieldIndex,
        records: Option<&'a HashMap<u32, ValueRecord>>,
    ) -> Self {
        Self {
            field,
            index,
            records,
        }
    }

    pub(crate) fn field(&self) -> &'a str {
        self.field
    }

    pub(crate) fn absent_after(
        &self,
        rows: &Change,
        touched: impl IntoIterator<Item = String>,
    ) -> BTreeSet<String> {
        let delta = self.index.project(rows, |row| {
            selections::RowRef::from_loc(row).resolve_field(self.field)
        });
        self.index
            .absent_after(&delta, touched)
            .into_iter()
            .collect()
    }

    pub(crate) fn count(&self, key: &str) -> usize {
        self.index
            .by_value
            .get(key)
            .map_or(0, |ids| ids.len() as usize)
    }

    pub(crate) fn record(&self, id: u32) -> Option<&'a ValueRecord> {
        self.records.and_then(|records| records.get(&id))
    }

    pub(crate) fn keys(&self) -> BTreeSet<String> {
        self.index
            .by_value
            .keys()
            .cloned()
            .chain(
                self.records
                    .into_iter()
                    .flat_map(|records| records.keys().map(u32::to_string)),
            )
            .collect()
    }

    pub(crate) fn get(&self, key: &str) -> Option<HeldValue> {
        let record = key.parse().ok().and_then(|id| self.record(id)).cloned();
        let count = self.count(key);
        (record.is_some() || count > 0).then_some(HeldValue { record, count })
    }

    pub(crate) fn project(
        &self,
        keys: impl IntoIterator<Item = String>,
    ) -> HashMap<String, Option<HeldValue>> {
        keys.into_iter()
            .map(|key| {
                let value = self.get(&key);
                (key, value)
            })
            .collect()
    }

    pub(crate) fn floor(&self) -> u32 {
        self.keys()
            .iter()
            .filter_map(|key| key.parse::<f64>().ok().map(|id| id as u32))
            .max()
            .unwrap_or(0)
    }

    pub(crate) fn named(&self, name: &str, visible: bool) -> Option<u32> {
        let name = name.to_lowercase();
        self.records?.iter().find_map(|(&id, record)| {
            ((!visible || self.count(&id.to_string()) > 0)
                && record_name(record).is_some_and(|current| current.to_lowercase() == name))
            .then_some(id)
        })
    }
}

pub(crate) fn record_color(record: &ValueRecord) -> Option<[u8; 3]> {
    hex_rgb(record.get("color")?.as_str()?)
}

fn hex_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim_start_matches('#');
    let h: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        _ => h.to_string(),
    };
    let n = u32::from_str_radix(h.get(..6)?, 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

impl Store {
    pub(crate) fn value_record(&self, field: &str, id: u32) -> Option<&ValueRecord> {
        self.value_meta.get(field)?.get(&id)
    }

    /// `field`'s records as they stand.
    pub(crate) fn records(&self, field: &str) -> HashMap<u32, ValueRecord> {
        self.value_meta
            .get(field)
            .map(|m| (**m).clone())
            .unwrap_or_default()
    }

    /// Highest id used by either metadata or rows, including rows with missing records.
    pub(crate) fn intern_floor(&mut self, field: &str) -> u32 {
        self.fields([field])[0].floor()
    }

    /// Create, patch, or reorder value records in one undoable edit. Rename collisions merge values.
    pub(crate) fn patch_field_values(
        &mut self,
        field: &str,
        patch: &FieldValuesPatch,
    ) -> AppResult<FieldValuesResult> {
        if !self.registry().get(field).is_some_and(|def| def.interned) {
            return Err(AppError(format!("'{field}' does not intern its values")));
        }
        let (floor, counted) = {
            let fields = self.fields([field]);
            let values = &fields[0];
            let counted: HashSet<u32> = values
                .keys()
                .into_iter()
                .filter(|key| values.count(key) > 0)
                .filter_map(|key| key.parse::<f64>().ok().map(|id| id as u32))
                .collect();
            (values.floor(), counted)
        };
        let before = self.records(field);
        let mut meta = before.clone();
        let resolved = intern(&mut meta, floor, &patch.create)?;
        let mut touched = resolved.clone();
        let mut merges: HashMap<u32, u32> = HashMap::new();
        {
            for u in &patch.update {
                let mut u = u.clone();
                let Some(id) = u.remove("id").and_then(|v| v.as_u64()).map(|n| n as u32) else {
                    return Err(AppError("a value patch names no `id`".into()));
                };
                let target = u
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .and_then(|name| {
                        let lower = name.to_lowercase();
                        meta.iter()
                            .find(|(&other, r)| {
                                other != id
                                    && record_name(r).is_some_and(|n| n.to_lowercase() == lower)
                            })
                            .map(|(&other, _)| other)
                    });
                if let Some(target_id) = target {
                    merges.insert(id, target_id);
                } else if meta.contains_key(&id) || counted.contains(&id) {
                    // Patching an id referenced by rows creates its missing metadata record.
                    merge_record(meta.entry(id).or_default(), u);
                    touched.push(id);
                }
            }
            if let Some(ordered) = &patch.reorder {
                for (i, id) in ordered.iter().enumerate() {
                    if let Some(r) = meta.get_mut(id) {
                        r.insert("order".into(), (i as u32).into());
                        touched.push(*id);
                    }
                }
            }
        }
        let patches = self.plan_value_merges(field, &merges)?;
        let piles = Piles::from([(field.to_string(), PileDelta::at(&before, &meta, touched))]);
        Ok(FieldValuesResult {
            resolved,
            mutation: self.write(
                patches.into_iter().map(Op::Put),
                &mut None,
                Entry {
                    piles,
                    ..Default::default()
                },
            ),
        })
    }

    /// Remap merged value ids in one pass, following merge chains to their final target.
    fn plan_value_merges(
        &mut self,
        field: &str,
        merges: &HashMap<u32, u32>,
    ) -> AppResult<Vec<Patch<Location>>> {
        if merges.is_empty() {
            return Ok(Vec::new());
        }
        let to = self.registry().assign(field)?;
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
        let mut patches: Vec<Patch<Location>> = Vec::new();
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
                let mut patch = row_patch(row.id());
                match to.write(&mut patch, row.flags(), &serde_json::json!(next)) {
                    Ok(()) => patches.push(patch),
                    Err(e) => err = Some(e),
                }
            }
        }
        match err {
            Some(e) => Err(e),
            None => Ok(patches),
        }
    }
}
