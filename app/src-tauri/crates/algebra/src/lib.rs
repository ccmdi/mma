//! How keyed values change: patches, merges, one equality, and the change a write leaves
//! behind. Nothing here knows what the values are.

use serde_json::Value;
use std::collections::HashMap;
use std::hash::Hash;

type Json = serde_json::Map<String, Value>;

/// Two field values are the same when their canonical spellings are.
pub fn same_field_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    a == b || matches!((a, b), (Some(a), Some(b)) if canonical(a) == canonical(b))
}

/// `v` spelled one way: object keys sorted, and every number as the JSON a JS writer would
/// store, so `45` and `45.0` are one value.
pub fn canonical(v: &Value) -> Value {
    match v {
        Value::Number(n) => n.as_f64().map_or_else(|| v.clone(), number_value),
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), canonical(&m[k])))
                    .collect(),
            )
        }
        _ => v.clone(),
    }
}

/// A number as JSON: whole values as integers, the rest as floats.
pub fn number_value(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// A type whose values change by patch: each field a patch can set, written over a
/// value or read off two of them. `#[derive(mma_fields::Patch)]` implements it.
pub trait Patchable: Sized {
    type Patch: serde::Serialize;
    /// The wire name and column of each field a patch writes.
    const WRITES: &'static [(&'static str, &'static str)];
    /// The wire names of the fields a patch changes key by key.
    const MERGED: &'static [&'static str];
    /// This value with `patch` written over it.
    fn patched(&self, patch: &Self::Patch) -> Self;
    /// The patch that turns `old` into `new`.
    fn between(old: &Self, new: &Self) -> Self::Patch;
}

/// A change to some of a `T`'s fields: an absent field is unchanged.
pub type Patch<T> = <T as Patchable>::Patch;

/// A map a patch changes key by key: a null value deletes its key, a null patch clears
/// the map, and an absent map is empty.
pub trait Merge: Sized {
    /// `old` with `patch` written over it.
    fn merged(old: &Option<Self>, patch: &Option<Self>) -> Option<Self>;
    /// The patch that turns `old` into `new`, or `None` when they hold the same.
    fn between(old: &Option<Self>, new: &Option<Self>) -> Option<Option<Self>>;
}

impl Merge for Json {
    fn merged(old: &Option<Self>, patch: &Option<Self>) -> Option<Self> {
        let patch = patch.as_ref()?;
        let mut m = old.clone().unwrap_or_default();
        for (k, v) in patch {
            if v.is_null() {
                m.remove(k);
            } else {
                m.insert(k.clone(), v.clone());
            }
        }
        (!m.is_empty()).then_some(m)
    }

    fn between(old: &Option<Self>, new: &Option<Self>) -> Option<Option<Self>> {
        let none = Json::new();
        let (old, new) = (old.as_ref().unwrap_or(&none), new.as_ref().unwrap_or(&none));
        let mut patch: Json = new
            .iter()
            .filter(|(k, v)| !same_field_value(old.get(*k), Some(v)))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for k in old.keys().filter(|k| !new.contains_key(*k)) {
            patch.insert(k.clone(), Value::Null);
        }
        (!patch.is_empty()).then_some(Some(patch))
    }
}

/// A value addressed by key wherever it lives.
pub trait Keyed {
    type Key: Copy + Eq + Hash + Ord;
    fn key(&self) -> Self::Key;
}

/// What one write did to the rows: each row as it was and as it became. The inverse
/// undoes it, and `then` composes two into one.
#[derive(Clone, Debug, PartialEq)]
pub struct Change<T> {
    pub added: Vec<T>,
    /// Removed rows in full, so a consumer can move off their old values.
    pub removed: Vec<T>,
    pub updated: Vec<(T, T)>,
}

impl<T> Default for Change<T> {
    fn default() -> Self {
        Self {
            added: Vec::new(),
            removed: Vec::new(),
            updated: Vec::new(),
        }
    }
}

impl<T: Keyed + PartialEq + Clone> Change<T> {
    /// From each row's state before and after. A row absent on both sides, or the same on
    /// both, is no change.
    pub fn from_rows(rows: impl IntoIterator<Item = (Option<T>, Option<T>)>) -> Self {
        let mut change = Self::default();
        for row in rows {
            match row {
                (None, Some(new)) => change.added.push(new),
                (Some(old), None) => change.removed.push(old),
                (Some(old), Some(new)) if old != new => change.updated.push((old, new)),
                _ => {}
            }
        }
        change
    }

    /// From the rows it created and the rows it removed: a row on both sides was updated.
    pub fn from_sides(created: Vec<T>, removed: Vec<T>) -> Self {
        let mut before: HashMap<T::Key, T> = removed.into_iter().map(|r| (r.key(), r)).collect();
        let mut rows: Vec<_> = created
            .into_iter()
            .map(|r| (before.remove(&r.key()), Some(r)))
            .collect();
        rows.extend(before.into_values().map(|r| (Some(r), None)));
        Self::from_rows(rows)
    }

    /// The rows it created and the rows it removed.
    pub fn sides(&self) -> (Vec<T>, Vec<T>) {
        let created = self.added.iter().chain(self.updated.iter().map(|(_, n)| n));
        let removed = self
            .removed
            .iter()
            .chain(self.updated.iter().map(|(o, _)| o));
        (created.cloned().collect(), removed.cloned().collect())
    }

    /// The change that undoes this one.
    pub fn inverse(&self) -> Self {
        Self {
            added: self.removed.clone(),
            removed: self.added.clone(),
            updated: self
                .updated
                .iter()
                .map(|(o, n)| (n.clone(), o.clone()))
                .collect(),
        }
    }

    /// This change and then `later`, as one: each row keeps its first state before and its
    /// last after.
    pub fn then(self, later: Self) -> Self {
        let mut order: Vec<T::Key> = Vec::new();
        let mut rows: HashMap<T::Key, (Option<T>, Option<T>)> = HashMap::new();
        for (before, after) in self.into_rows().chain(later.into_rows()) {
            let Some(key) = after.as_ref().or(before.as_ref()).map(T::key) else {
                continue;
            };
            match rows.get_mut(&key) {
                Some(row) => row.1 = after,
                None => {
                    order.push(key);
                    rows.insert(key, (before, after));
                }
            }
        }
        Self::from_rows(order.into_iter().filter_map(|key| rows.remove(&key)))
    }

    pub fn into_rows(self) -> impl Iterator<Item = (Option<T>, Option<T>)> {
        let added = self.added.into_iter().map(|r| (None, Some(r)));
        let removed = self.removed.into_iter().map(|r| (Some(r), None));
        let updated = self.updated.into_iter().map(|(o, n)| (Some(o), Some(n)));
        added.chain(removed).chain(updated)
    }

    /// No rows moved.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    /// Whether it created or updated the row at `key`.
    pub fn touches(&self, key: T::Key) -> bool {
        self.added.iter().any(|r| r.key() == key)
            || self.updated.iter().any(|(_, n)| n.key() == key)
    }

    pub fn len(&self) -> usize {
        self.added.len() + self.removed.len() + self.updated.len()
    }

    /// The highest key on either side.
    pub fn max_key(&self) -> Option<T::Key> {
        let (added, removed) = (self.added.iter(), self.removed.iter());
        let updated = self.updated.iter().map(|(_, n)| n);
        added.chain(removed).chain(updated).map(T::key).max()
    }
}

#[cfg(test)]
#[path = "lib.test.rs"]
mod tests;
