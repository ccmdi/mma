//! Records for interned field values, such as tags.
//! A record's name identifies its value and its order places it in the field's list;
//! any other metadata, such as a colour, rides along in `extra`.
//! Values are visible while rows reference them; empty records remain available for reuse.

use super::*;
use crate::selections;
use crate::types::{AppError, AppResult};
use crate::util::Rgb;
use mma_algebra::{trimmed_name, unique_name, Constrained, Edit, Field, Id, Op, Patch};
use std::collections::HashMap;

/// Metadata for one interned value.
#[derive(
    Clone, Debug, Default, serde::Serialize, serde::Deserialize, specta::Type, mma_fields::Patch,
)]
#[serde(rename_all = "camelCase")]
pub struct ValueRecord {
    #[patch(key)]
    pub id: Id<ValueRecord>,
    /// The value's display name, unique within its field regardless of case.
    #[patch(unique)]
    #[specta(optional)]
    pub name: Option<String>,
    /// The value's place in its field's list.
    #[patch(sequence)]
    #[specta(optional)]
    pub order: Option<u32>,
    /// Any other metadata, such as a colour.
    #[patch(merge)]
    #[serde(flatten)]
    #[specta(type = HashMap<String, specta_typescript::Unknown>)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ValueRecord {
    /// The colour someone chose for this value, if any.
    pub(crate) fn color(&self) -> Option<Rgb> {
        self.extra.get("color")?.as_str()?.parse().ok()
    }

    /// The colour the value is drawn in: its chosen one, else its name's.
    pub(crate) fn shown_color(&self) -> Option<Rgb> {
        self.color()
            .or_else(|| self.name.as_deref().map(Rgb::for_name))
    }
}

/// Match source records to `target` by name, case-insensitively, and return the id remap.
/// New ids are allocated above `floor`; held metadata wins, and source records join the end of
/// the target's order in their own order.
pub(crate) fn reconcile_values_by_name<'a>(
    source: impl IntoIterator<Item = &'a ValueRecord>,
    target: &mut HashMap<Id<ValueRecord>, ValueRecord>,
    floor: u32,
) -> HashMap<Id<ValueRecord>, Id<ValueRecord>> {
    let mut named: Vec<&ValueRecord> = source
        .into_iter()
        .filter(|r| r.unique().is_some())
        .collect();
    named.sort_by(|a, b| {
        a.order
            .unwrap_or(u32::MAX)
            .cmp(&b.order.unwrap_or(u32::MAX))
            .then_with(|| a.name.cmp(&b.name))
    });
    let adds = named.iter().map(|r| {
        Op::Add(ValueRecord {
            order: None,
            ..(*r).clone()
        })
    });
    let applied = mma_algebra::apply(target, adds, Id::new(floor));
    named.iter().map(|r| r.id).zip(applied.keys).collect()
}

/// The edit with its name trimmed. A record's name is never cleared, a new record needs one,
/// and records are never removed.
pub(crate) fn named(edit: Edit<ValueRecord>) -> AppResult<Edit<ValueRecord>> {
    let trimmed = |name: &str| trimmed_name(name).map(str::to_string);
    match edit {
        Op::Remove(_) => Err(AppError("a value record outlives its rows".into())),
        Op::Add(mut rec) => {
            rec.name = rec.name.as_deref().and_then(trimmed);
            match rec.name {
                None => Err(AppError("an interned value needs a name".into())),
                Some(_) => Ok(Op::Add(rec)),
            }
        }
        Op::Set(mut rec) => {
            rec.name = rec.name.as_deref().and_then(trimmed);
            Ok(Op::Set(rec))
        }
        Op::Put(mut patch) => {
            patch.name = match &patch.name {
                Field::Set(name) => trimmed(name).map_or(Field::Keep, Field::Set),
                _ => Field::Keep,
            };
            Ok(Op::Put(patch))
        }
    }
}

pub(crate) struct FieldValues<'a> {
    field: &'a str,
    index: &'a selections::FieldIndex,
    records: Option<&'a HashMap<Id<ValueRecord>, ValueRecord>>,
}

impl<'a> FieldValues<'a> {
    pub(super) fn new(
        field: &'a str,
        index: &'a selections::FieldIndex,
        records: Option<&'a HashMap<Id<ValueRecord>, ValueRecord>>,
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

    pub(crate) fn record(&self, id: Id<ValueRecord>) -> Option<&'a ValueRecord> {
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
                    .flat_map(|records| records.keys().map(ToString::to_string)),
            )
            .collect()
    }

    pub(crate) fn get(&self, key: &str) -> Option<HeldValue> {
        let record = key
            .parse()
            .ok()
            .and_then(|id| self.record(Id::new(id)))
            .cloned();
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

    /// The value named `name` that at least one row holds.
    pub(crate) fn named(&self, name: &str) -> Option<Id<ValueRecord>> {
        let name = unique_name(name)?;
        self.records?.iter().find_map(|(&id, record)| {
            (self.count(&id.to_string()) > 0
                && record.unique().is_some_and(|current| current == name))
            .then_some(id)
        })
    }
}

impl Store {
    pub(crate) fn value_record(&self, field: &str, id: Id<ValueRecord>) -> Option<&ValueRecord> {
        self.records.get(field)?.get(&id)
    }

    /// `field`'s records as they stand.
    pub(crate) fn records(&self, field: &str) -> HashMap<Id<ValueRecord>, ValueRecord> {
        self.records
            .get(field)
            .map(|m| (**m).clone())
            .unwrap_or_default()
    }

    /// Highest id used by either metadata or rows, including rows with missing records.
    pub(crate) fn intern_floor(&mut self, field: &str) -> u32 {
        self.fields([field])[0].floor()
    }

    /// Apply edits to `field`'s value records in one undoable edit.
    /// Renaming onto a name another record holds merges the two values and remaps their rows.
    pub(crate) fn edit_values(
        &mut self,
        field: &str,
        edits: Vec<Edit<ValueRecord>>,
    ) -> AppResult<Mutation<ValueRecord>> {
        if !self.registry().get(field).is_some_and(|def| def.interned) {
            return Err(AppError(format!("'{field}' does not intern its values")));
        }
        let edits = edits
            .into_iter()
            .map(named)
            .collect::<AppResult<Vec<_>>>()?;
        let (floor, held) = {
            let fields = self.fields([field]);
            let values = &fields[0];
            let held: Vec<Id<ValueRecord>> = values
                .keys()
                .into_iter()
                .filter(|key| values.count(key) > 0)
                .filter_map(|key| key.parse().ok().map(Id::new))
                .collect();
            (values.floor(), held)
        };
        let before = self.records(field);
        let bare = |id: Id<ValueRecord>| ValueRecord {
            id,
            ..Default::default()
        };
        let mut after = before.clone();
        for id in held {
            after.entry(id).or_insert_with(|| bare(id));
        }
        let applied = mma_algebra::apply(&mut after, edits, Id::new(floor));
        after.retain(|&id, rec| before.contains_key(&id) || *rec != bare(id));
        let patches = self.plan_value_merges(field, &applied.redirects)?;
        let keys: Vec<Id<ValueRecord>> = before.keys().chain(after.keys()).copied().collect();
        let delta = RecordDelta::at(&before, &after, keys);
        let records =
            RecordDeltas::from_iter((!delta.is_empty()).then(|| (field.to_string(), delta)));
        let mutation = self.write(
            patches.into_iter().map(Op::Put),
            &mut None,
            Entry {
                records,
                ..Default::default()
            },
        );
        Ok(Mutation {
            keys: applied.keys,
            version: mutation.version,
            history_cleared: mutation.history_cleared,
        })
    }

    /// Remap merged value ids in one pass, following merge chains to their final target.
    fn plan_value_merges(
        &mut self,
        field: &str,
        merges: &HashMap<Id<ValueRecord>, Id<ValueRecord>>,
    ) -> AppResult<Vec<Patch<Location>>> {
        if merges.is_empty() {
            return Ok(Vec::new());
        }
        let to = self.registry().assign(field)?;
        let resolve = |mut id: Id<ValueRecord>| {
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
                let current: Vec<Id<ValueRecord>> = list
                    .iter()
                    .filter_map(|v| v.as_u64().map(|n| Id::new(n as u32)))
                    .collect();
                if !current.iter().any(|id| merges.contains_key(id)) {
                    continue;
                }
                let mut next: Vec<Id<ValueRecord>> = Vec::with_capacity(current.len());
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
