//! Records for interned field values, such as tags.
//! A record's name identifies its value and its order places it in the field's list;
//! any other metadata, such as a colour, rides along in `extra`.
//! Values are visible while rows reference them; empty records remain available for reuse.

use super::*;
use crate::selections;
use crate::types::{AppError, AppResult, Location};
use crate::util::Rgb;
use mma_algebra::{trimmed_name, unique_name, Constrained, Edit, Field, Id, Op};
use std::collections::HashMap;

/// The names interned values carried, by field and then id.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(transparent)]
pub struct ValueNames(pub HashMap<String, HashMap<Id<ValueRecord>, String>>);

/// Metadata for one interned value.
#[derive(Clone, Debug, Default, mma_fields::Json, specta::Type, mma_fields::Patch)]
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

/// The name `id`'s record gives it, else the id itself.
pub(crate) fn value_name(
    records: &HashMap<Id<ValueRecord>, ValueRecord>,
    id: Id<ValueRecord>,
) -> String {
    records
        .get(&id)
        .and_then(|record| record.name.clone())
        .unwrap_or_else(|| id.to_string())
}

/// An interned field's id list with each id spelled as its name. Anything else is returned as is.
pub(crate) fn spelled(
    value: &serde_json::Value,
    records: &HashMap<Id<ValueRecord>, ValueRecord>,
) -> serde_json::Value {
    match value {
        serde_json::Value::Array(ids) => ids
            .iter()
            .filter_map(|id| {
                let id = Id::new(u32::try_from(id.as_u64()?).ok()?);
                Some(serde_json::Value::String(value_name(records, id)))
            })
            .collect(),
        other => other.clone(),
    }
}

/// The records among `records` that `rows` reference, by field.
pub(crate) fn referenced_records(
    records: &HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    rows: &[Location],
) -> HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>> {
    records
        .iter()
        .map(|(field, held)| {
            let used: HashSet<Id<ValueRecord>> = rows
                .iter()
                .flat_map(|row| selections::RowRef::from_loc(row).held_ids(field))
                .collect();
            let referenced = held
                .iter()
                .filter(|(id, _)| used.contains(id))
                .map(|(&id, record)| (id, record.clone()))
                .collect();
            (field.clone(), referenced)
        })
        .collect()
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

/// Access to a map's field values, narrowed by their declarations.
pub(crate) struct Fields<'a> {
    store: &'a mut Store,
    includes: fn(Option<&maps::FieldDef>) -> bool,
}

impl Store {
    pub(crate) fn fields(&mut self) -> Fields<'_> {
        Fields {
            store: self,
            includes: |_| true,
        }
    }
}

impl<'a> Fields<'a> {
    pub(crate) fn interned(mut self) -> Self {
        self.includes = |field| field.is_some_and(|field| field.interned);
        self
    }

    pub(crate) fn values(
        self,
        fields: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Vec<FieldValues<'a>> {
        let fields: Vec<_> = fields
            .into_iter()
            .filter(|field| (self.includes)(self.store.registry().get(field.as_ref())))
            .collect();
        self.store.prepare(
            fields
                .iter()
                .map(|field| selections::Index::Presence(field.as_ref().to_string())),
        );
        let store: &'a Store = self.store;
        fields
            .into_iter()
            .map(|field| {
                let (field, index) = store
                    .field_indexes
                    .get_key_value(field.as_ref())
                    .expect("prepared field index");
                FieldValues {
                    field,
                    index,
                    records: store.records.get(field).map(|records| &**records),
                }
            })
            .collect()
    }

    pub(crate) fn all(self) -> Vec<FieldValues<'a>> {
        let fields: Vec<_> = self
            .store
            .registry()
            .iter()
            .map(|(field, _)| field.to_string())
            .collect();
        self.values(fields)
    }

    /// Values absent after the projected change, among those moved or explicitly touched.
    pub(crate) fn absent_after(
        self,
        projections: &HashMap<String, selections::Projection>,
        touched: impl Fn(&str) -> Vec<String>,
    ) -> HashSet<(String, String)> {
        self.values(projections.keys())
            .into_iter()
            .flat_map(|values| {
                let field = values.field();
                values
                    .absent_after(&projections[field], touched(field))
                    .into_iter()
                    .map(move |key| (field.to_string(), key))
            })
            .collect()
    }
}

pub(crate) struct FieldValues<'a> {
    field: &'a str,
    index: &'a selections::FieldIndex,
    records: Option<&'a HashMap<Id<ValueRecord>, ValueRecord>>,
}

impl<'a> FieldValues<'a> {
    pub(crate) fn field(&self) -> &'a str {
        self.field
    }

    pub(crate) fn absent_after(
        &self,
        projection: &selections::Projection,
        touched: impl IntoIterator<Item = String>,
    ) -> BTreeSet<String> {
        let mut counts =
            projection.count_by(|(_, keys)| keys.iter().flatten().cloned().collect::<Vec<_>>());
        for key in touched {
            counts.entry(key).or_default();
        }
        counts
            .into_iter()
            .filter_map(|(key, delta)| (self.count(&key) as i64 + delta <= 0).then_some(key))
            .collect()
    }

    pub(crate) fn count(&self, key: &str) -> usize {
        self.index
            .by_value
            .get(key)
            .map_or(0, |ids| ids.len() as usize)
    }

    /// The records of the values at least one row holds.
    pub(crate) fn carried(&self) -> HashMap<Id<ValueRecord>, ValueRecord> {
        self.records
            .into_iter()
            .flatten()
            .filter(|(id, _)| self.count(&id.to_string()) > 0)
            .map(|(&id, record)| (id, record.clone()))
            .collect()
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
    /// Refuse any of `fields` this map does not intern.
    pub(crate) fn check_interned(
        &self,
        fields: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> AppResult<()> {
        let registry = self.registry();
        match fields
            .into_iter()
            .find(|field| !registry.get(field.as_ref()).is_some_and(|def| def.interned))
        {
            Some(field) => Err(AppError(format!(
                "'{}' does not intern its values",
                field.as_ref()
            ))),
            None => Ok(()),
        }
    }

    /// Every interned field's records as they stand.
    pub(crate) fn held_value_records(
        &self,
    ) -> HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>> {
        self.records
            .iter()
            .map(|(field, records)| (field.clone(), (**records).clone()))
            .collect()
    }

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
}

/// Where a merged value ends up, following merge chains to their final target.
pub(super) fn survivor(
    merges: &HashMap<Id<ValueRecord>, Id<ValueRecord>>,
    mut id: Id<ValueRecord>,
) -> Id<ValueRecord> {
    let mut seen = HashSet::new();
    while let Some(&next) = merges.get(&id) {
        if !seen.insert(id) {
            break;
        }
        id = next;
    }
    id
}
