//! Patches, pending edits, and reversible changes to keyed values.

use serde_json::Value;
use std::collections::{hash_map, BTreeMap, BTreeSet, HashMap};
use std::hash::Hash;
use std::marker::PhantomData;

type Json = serde_json::Map<String, Value>;

/// Compare field values after normalizing their JSON representation.
pub fn same_field_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    a == b || matches!((a, b), (Some(a), Some(b)) if canonical(a) == canonical(b))
}

/// Normalize object keys and numbers so equivalent JSON values compare equal (e.g. `45` and `45.0`).
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
/// Whether `v` is its type's default: an empty nested patch, for one.
pub fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

pub fn number_value(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// A value that supports field patches. Implemented by `#[derive(mma_fields::Patch)]`.
pub trait Patchable: Sized {
    type Patch: Clone + PartialEq + std::fmt::Debug + serde::Serialize + serde::de::DeserializeOwned;
    /// The wire name and column of each field a patch writes.
    const WRITES: &'static [(&'static str, &'static str)];
    /// The wire names of the fields a patch changes key by key.
    const MERGED: &'static [&'static str];
    /// Wire names of fields that can be cleared with null.
    const CLEARS: &'static [&'static str];
    /// Apply `patch` to this value.
    fn patched(&self, patch: &Self::Patch) -> Self;
    /// The patch that turns `old` into `new`.
    fn between(old: &Self, new: &Self) -> Self::Patch;
    /// A patch setting every writable field to its current value.
    fn to_patch(&self) -> Self::Patch;
}

/// A change to some of a `T`'s fields: an absent field is unchanged.
pub type Patch<T> = <T as Patchable>::Patch;

/// An optional field update: absent keeps it, null clears it, and a value replaces it.
/// When updates are combined, the later update wins.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Field<T> {
    #[default]
    Keep,
    Clear,
    Set(T),
}

impl<T> Field<T> {
    pub fn is_keep(&self) -> bool {
        matches!(self, Field::Keep)
    }

    /// Combine two updates, applying `later` last.
    pub fn then(self, later: Self) -> Self {
        match later {
            Field::Keep => self,
            later => later,
        }
    }

    pub fn as_ref(&self) -> Field<&T> {
        match self {
            Field::Keep => Field::Keep,
            Field::Clear => Field::Clear,
            Field::Set(v) => Field::Set(v),
        }
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Field<U> {
        match self {
            Field::Keep => Field::Keep,
            Field::Clear => Field::Clear,
            Field::Set(v) => Field::Set(f(v)),
        }
    }

    /// Like `map`, where a value that maps to nothing clears.
    pub fn and_then<U>(self, f: impl FnOnce(T) -> Option<U>) -> Field<U> {
        match self {
            Field::Keep => Field::Keep,
            Field::Clear => Field::Clear,
            Field::Set(v) => f(v).into(),
        }
    }
}

impl<T: Clone> Field<T> {
    /// Apply this update to `old`.
    pub fn applied(&self, old: &Option<T>) -> Option<T> {
        match self {
            Field::Keep => old.clone(),
            Field::Clear => None,
            Field::Set(v) => Some(v.clone()),
        }
    }
}

impl<T: Clone + PartialEq> Field<T> {
    /// The update that turns `old` into `new`.
    pub fn between(old: &Option<T>, new: &Option<T>) -> Self {
        if old == new {
            Field::Keep
        } else {
            new.clone().into()
        }
    }
}

/// Replace a field with a whole value; `None` clears it.
impl<T> From<Option<T>> for Field<T> {
    fn from(v: Option<T>) -> Self {
        v.map_or(Field::Clear, Field::Set)
    }
}

impl<T: serde::Serialize> serde::Serialize for Field<T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Field::Set(v) => s.serialize_some(v),
            Field::Keep | Field::Clear => s.serialize_none(),
        }
    }
}

impl<'de, T: serde::Deserialize<'de>> serde::Deserialize<'de> for Field<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Option::<T>::deserialize(d)?.into())
    }
}

/// A map updated key by key. Null deletes a key; clearing the field removes the map.
/// A missing map is treated as empty when merging.
pub trait Merge: Sized {
    /// Apply `patch` to `old`.
    fn merged(old: &Option<Self>, patch: &Field<Self>) -> Option<Self>;
    /// The patch that turns `old` into `new`.
    fn between(old: &Option<Self>, new: &Option<Self>) -> Field<Self>;
}

// RFC 7386 JSON Merge Patch, one level deep: a nested object is replaced, not merged.
impl Merge for Json {
    fn merged(old: &Option<Self>, patch: &Field<Self>) -> Option<Self> {
        let patch = match patch {
            Field::Keep => return old.clone(),
            Field::Clear => return None,
            Field::Set(patch) => patch,
        };
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

    fn between(old: &Option<Self>, new: &Option<Self>) -> Field<Self> {
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
        if patch.is_empty() {
            Field::Keep
        } else {
            Field::Set(patch)
        }
    }
}

/// An id that names what it identifies, so `Id<Location>` and `Id<ValueRecord>` never mix.
/// `Raw` is what the id holds: a number by default, text for ids such as a map's.
/// Serialized as `Raw`, so the stored and wire forms are unchanged.
#[repr(transparent)]
pub struct Id<T, Raw = u32>(Raw, PhantomData<fn() -> T>);

impl<T, Raw> Id<T, Raw> {
    pub const fn new(raw: Raw) -> Self {
        Id(raw, PhantomData)
    }

    pub fn raw(&self) -> &Raw {
        &self.0
    }
}

impl<T, Raw: Copy> Id<T, Raw> {
    pub fn get(self) -> Raw {
        self.0
    }
}

impl<T> Id<T> {
    /// The key of a row the store has not numbered yet.
    pub const UNSET: Self = Id::new(0);

    /// The raw numbers behind `ids`, without copying.
    pub fn raw_slice(ids: &[Self]) -> &[u32] {
        // SAFETY: `Id<T>` is `#[repr(transparent)]` over `u32`, so the slices share a layout.
        unsafe { std::slice::from_raw_parts(ids.as_ptr().cast(), ids.len()) }
    }

    /// `raw` read as ids, without copying.
    pub fn from_raw_slice(raw: &[u32]) -> &[Self] {
        // SAFETY: as above.
        unsafe { std::slice::from_raw_parts(raw.as_ptr().cast(), raw.len()) }
    }
}

// Written by hand so they hold for every `T`: a derive would demand `T: Clone`, `T: Eq`, ...
impl<T, Raw: Clone> Clone for Id<T, Raw> {
    fn clone(&self) -> Self {
        Id::new(self.0.clone())
    }
}
impl<T, Raw: Copy> Copy for Id<T, Raw> {}
impl<T, Raw: PartialEq> PartialEq for Id<T, Raw> {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl<T, Raw: Eq> Eq for Id<T, Raw> {}
impl<T, Raw: Ord> PartialOrd for Id<T, Raw> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl<T, Raw: Ord> Ord for Id<T, Raw> {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.cmp(&other.0)
    }
}
impl<T, Raw: Hash> Hash for Id<T, Raw> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.hash(state)
    }
}
impl<T, Raw: Default> Default for Id<T, Raw> {
    fn default() -> Self {
        Id::new(Raw::default())
    }
}
impl<T, Raw: std::fmt::Debug> std::fmt::Debug for Id<T, Raw> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl<T, Raw: std::fmt::Display> std::fmt::Display for Id<T, Raw> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl<T, Raw: serde::Serialize> serde::Serialize for Id<T, Raw> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}
impl<'de, T, Raw: serde::Deserialize<'de>> serde::Deserialize<'de> for Id<T, Raw> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Raw::deserialize(d).map(Id::new)
    }
}
impl<T, Raw: specta::Type> specta::Type for Id<T, Raw> {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        Raw::definition(types)
    }
}

/// A value addressed by key wherever it lives.
pub trait Keyed {
    type Key: Clone + Eq + Hash + Ord;
    fn key(&self) -> Self::Key;
}

/// A table row: a value at its key.
impl<K: Clone + Eq + Hash + Ord, V> Keyed for (K, V) {
    type Key = K;
    fn key(&self) -> K {
        self.0.clone()
    }
}

/// An edit to one keyed row: replace it, patch it, or remove it.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Op<T, P, K> {
    /// The row exactly as given.
    Set(T),
    /// A patch written over the row it names.
    Put(P),
    /// The row at this key removed.
    Remove(K),
}

/// An edit to a keyed, patchable row.
pub type Edit<T> = Op<T, Patch<T>, <T as Keyed>::Key>;

impl<T: Patchable + Keyed> Edit<T>
where
    Patch<T>: Keyed<Key = T::Key>,
{
    pub fn key(&self) -> T::Key {
        match self {
            Op::Set(row) => row.key(),
            Op::Put(patch) => patch.key(),
            Op::Remove(key) => key.clone(),
        }
    }
}

impl<T: Patchable + Keyed + Clone> Edit<T> {
    /// Apply this edit to the underlying row. Patching a missing row has no effect.
    pub fn applied(&self, below: Option<T>, apply: impl Fn(&T, &Patch<T>) -> T) -> Option<T> {
        match self {
            Op::Set(row) => Some(row.clone()),
            Op::Remove(_) => None,
            Op::Put(patch) => below.map(|row| apply(&row, patch)),
        }
    }
}

/// A row whose table keeps one field unique and numbers others in sequence.
/// Implemented by `#[derive(mma_fields::Patch)]` for structs with `unique` or `sequence` fields.
pub trait Constrained: Keyed + Sized {
    /// The row's unique value, trimmed and compared case-insensitively.
    fn unique(&self) -> Option<String>;
    /// Fill each sequence field this row leaves empty with one past the highest in `rows`.
    fn sequence<'a>(&mut self, rows: impl Iterator<Item = &'a Self> + Clone)
    where
        Self: 'a;
    /// This row with the fields it leaves empty taken from `from`.
    fn filled(&self, from: &Self) -> Self;
    fn set_key(&mut self, key: Self::Key);
}

/// What edits to a constrained table did beyond the rows they wrote.
#[derive(Debug)]
pub struct Applied<K> {
    /// The key each keyless set landed on, in order.
    pub keys: Vec<K>,
    /// Rows whose write took a unique value another row holds, mapped to that row.
    pub redirects: HashMap<K, K>,
}

/// Apply edits to a table under its constraints.
/// A keyless set lands on the row holding its unique value, filling what that row leaves
/// empty, or takes a key from `next`; either way its empty sequence fields are numbered.
/// A write that takes a unique value another row holds leaves its row unchanged and is
/// reported in `redirects`.
pub fn apply<T>(
    table: &mut HashMap<T::Key, T>,
    edits: impl IntoIterator<Item = Edit<T>>,
    mut next: impl FnMut() -> T::Key,
) -> Applied<T::Key>
where
    T: Constrained + Patchable + Clone,
    T::Key: Default,
    Patch<T>: Keyed<Key = T::Key>,
{
    let mut holders: HashMap<String, T::Key> = table
        .iter()
        .filter_map(|(k, row)| Some((row.unique()?, k.clone())))
        .collect();
    let mut applied = Applied {
        keys: Vec::new(),
        redirects: HashMap::new(),
    };
    for edit in edits {
        let (key, row) = match edit {
            Op::Remove(key) => {
                if let Some(u) = table.remove(&key).and_then(|row| row.unique()) {
                    if holders.get(&u) == Some(&key) {
                        holders.remove(&u);
                    }
                }
                continue;
            }
            Op::Set(row) if row.key() == T::Key::default() => {
                let (key, mut row) = match row.unique().and_then(|u| holders.get(&u)) {
                    Some(held) => (held.clone(), table[held].filled(&row)),
                    None => {
                        let key = next();
                        let mut row = row;
                        row.set_key(key.clone());
                        (key, row)
                    }
                };
                row.sequence(table.values().filter(|other| other.key() != key));
                if let Some(u) = row.unique() {
                    holders.insert(u, key.clone());
                }
                applied.keys.push(key.clone());
                table.insert(key, row);
                continue;
            }
            Op::Set(row) => (row.key(), row),
            Op::Put(patch) => match table.get(&patch.key()) {
                Some(old) => (patch.key(), old.patched(&patch)),
                None => continue,
            },
        };
        let was = table.get(&key).and_then(Constrained::unique);
        let unique = row.unique();
        if unique != was {
            match unique.as_ref().and_then(|u| holders.get(u)) {
                Some(held) if *held != key => {
                    applied.redirects.insert(key, held.clone());
                    continue;
                }
                _ => {}
            }
            if let Some(was) = was.filter(|was| holders.get(was) == Some(&key)) {
                holders.remove(&was);
            }
            if let Some(u) = unique {
                holders.insert(u, key.clone());
            }
        }
        table.insert(key, row);
    }
    applied
}

/// Pending edits applied over the current underlying rows.
/// Underlying changes remain visible in fields the layer has not overwritten.
#[derive(Clone, Debug, PartialEq)]
pub struct Layer<T: Patchable + Keyed> {
    ops: BTreeMap<T::Key, Vec<Edit<T>>>,
}

impl<T: Patchable + Keyed> Default for Layer<T> {
    fn default() -> Self {
        Self {
            ops: BTreeMap::new(),
        }
    }
}

/// Append edits by key. Replacing or removing a row discards its earlier edits.
impl<T: Patchable + Keyed> Extend<Edit<T>> for Layer<T>
where
    Patch<T>: Keyed<Key = T::Key>,
{
    fn extend<I: IntoIterator<Item = Edit<T>>>(&mut self, ops: I) {
        for op in ops {
            let held = self.ops.entry(op.key()).or_default();
            if !matches!(op, Op::Put(_)) {
                held.clear();
            }
            held.push(op);
        }
    }
}

impl<T: Patchable + Keyed> FromIterator<Edit<T>> for Layer<T>
where
    Patch<T>: Keyed<Key = T::Key>,
{
    fn from_iter<I: IntoIterator<Item = Edit<T>>>(ops: I) -> Self {
        let mut layer = Self::default();
        layer.extend(ops);
        layer
    }
}

impl<T: Patchable + Keyed> Layer<T>
where
    Patch<T>: Keyed<Key = T::Key>,
{
    /// Every pending edit, each row's in the order it was made.
    pub fn into_edits(self) -> impl Iterator<Item = Edit<T>> {
        self.ops.into_values().flatten()
    }

    /// Rewrite every pending edit, keeping each row's edits in order.
    pub fn map_edits(self, f: impl FnMut(Edit<T>) -> Edit<T>) -> Self {
        self.into_edits().map(f).collect()
    }
}

impl<T: Patchable + Keyed + Clone + PartialEq> Layer<T> {
    /// Read a row with this layer's pending edits applied to `below`.
    pub fn get(
        &self,
        key: T::Key,
        below: Option<T>,
        apply: impl Fn(&T, &Patch<T>) -> T,
    ) -> Option<T> {
        self.ops
            .get(&key)
            .into_iter()
            .flatten()
            .fold(below, |row, op| op.applied(row, &apply))
    }

    /// The before and after states of each row affected by this layer.
    pub fn resolve<'a>(
        &'a self,
        below: impl Fn(T::Key) -> Option<T> + 'a,
        apply: impl Fn(&T, &Patch<T>) -> T + 'a,
    ) -> impl Iterator<Item = Transition<T>> + 'a {
        self.ops.keys().map(move |key| {
            let before = below(key.clone());
            let after = self.get(key.clone(), before.clone(), &apply);
            Transition::new(before, after)
        })
    }

    pub fn keys(&self) -> impl Iterator<Item = T::Key> + '_ {
        self.ops.keys().cloned()
    }

    /// Whether this layer has pending edits for `key`.
    pub fn holds(&self, key: T::Key) -> bool {
        self.ops.contains_key(&key)
    }

    /// Discard pending edits for `key`.
    pub fn remove(&mut self, key: T::Key) {
        self.ops.remove(&key);
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }
}

/// A row's before and after states; `None` means the row does not exist.
/// Transitions can be combined when their adjacent states match.
#[derive(Clone, Debug, PartialEq)]
pub struct Transition<T> {
    pub before: Option<T>,
    pub after: Option<T>,
}

impl<T> Transition<T> {
    pub fn new(before: Option<T>, after: Option<T>) -> Self {
        Self { before, after }
    }

    pub fn inverse(self) -> Self {
        Self::new(self.after, self.before)
    }
}

impl<T: PartialEq> Transition<T> {
    /// Combine transitions when this one ends where `later` starts.
    pub fn then(self, later: Self) -> Option<Self> {
        (self.after == later.before).then(|| Self {
            before: self.before,
            after: later.after,
        })
    }

    pub fn is_identity(&self) -> bool {
        self.before == self.after
    }
}

impl<T: Keyed> Transition<T> {
    /// The row's key, or `None` if it is absent on both sides.
    pub fn key(&self) -> Option<T::Key> {
        self.after.as_ref().or(self.before.as_ref()).map(T::key)
    }
}

/// Keys of added, removed, and updated rows.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Keys<K> {
    /// The rows the change created.
    pub added: Vec<K>,
    /// The rows the change deleted.
    pub removed: Vec<K>,
    /// The rows the change rewrote.
    pub updated: Vec<K>,
}

/// Counts of added, removed, and updated rows.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct Counts {
    /// Rows the change created.
    pub added: u32,
    /// Rows the change deleted.
    pub removed: u32,
    /// Rows the change rewrote.
    pub updated: u32,
}

/// Added, removed, and updated rows, with enough information to undo or combine changes.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct Change<T> {
    /// The rows it created.
    pub added: Vec<T>,
    /// Removed rows, including their old values.
    pub removed: Vec<T>,
    /// Updated rows as before/after pairs.
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

/// Group transitions into additions, removals, and updates, ignoring unchanged rows.
impl<T: PartialEq> FromIterator<Transition<T>> for Change<T> {
    fn from_iter<I: IntoIterator<Item = Transition<T>>>(rows: I) -> Self {
        let mut change = Self::default();
        for row in rows {
            match (row.before, row.after) {
                (None, Some(new)) => change.added.push(new),
                (Some(old), None) => change.removed.push(old),
                (Some(old), Some(new)) if old != new => change.updated.push((old, new)),
                _ => {}
            }
        }
        change
    }
}

impl<T> Change<T> {
    pub fn transitions(&self) -> impl Iterator<Item = Transition<&T>> {
        shaped(
            self.added.iter(),
            self.removed.iter(),
            self.updated.iter().map(|(o, n)| (o, n)),
        )
    }

    pub fn into_transitions(self) -> impl Iterator<Item = Transition<T>> {
        shaped(
            self.added.into_iter(),
            self.removed.into_iter(),
            self.updated.into_iter(),
        )
    }

    pub fn before(&self) -> impl Iterator<Item = &T> {
        self.transitions().filter_map(|t| t.before)
    }

    pub fn after(&self) -> impl Iterator<Item = &T> {
        self.transitions().filter_map(|t| t.after)
    }

    /// All new and old rows, including both sides of updates.
    pub fn sides(&self) -> (Vec<T>, Vec<T>)
    where
        T: Clone,
    {
        (
            self.after().cloned().collect(),
            self.before().cloned().collect(),
        )
    }

    pub fn len(&self) -> usize {
        self.added.len() + self.removed.len() + self.updated.len()
    }

    /// Counts of added, removed, and updated rows.
    pub fn counts(&self) -> Counts {
        Counts {
            added: self.added.len() as u32,
            removed: self.removed.len() as u32,
            updated: self.updated.len() as u32,
        }
    }

    pub fn count_by<K: Eq + Hash, I: IntoIterator<Item = K>>(
        &self,
        project: impl Fn(&T) -> I,
    ) -> HashMap<K, i64> {
        let mut counts = HashMap::new();
        for row in self.before() {
            for key in project(row) {
                *counts.entry(key).or_default() -= 1;
            }
        }
        for row in self.after() {
            for key in project(row) {
                *counts.entry(key).or_default() += 1;
            }
        }
        counts
    }

    pub fn project<U: PartialEq>(&self, project: impl Fn(&T) -> U) -> Change<U> {
        self.transitions()
            .map(|t| Transition::new(t.before.map(&project), t.after.map(&project)))
            .collect()
    }
}

/// Pair old and new rows into transitions by key.
fn shaped<T>(
    added: impl Iterator<Item = T>,
    removed: impl Iterator<Item = T>,
    updated: impl Iterator<Item = (T, T)>,
) -> impl Iterator<Item = Transition<T>> {
    let added = added.map(|r| Transition::new(None, Some(r)));
    let removed = removed.map(|r| Transition::new(Some(r), None));
    added
        .chain(removed)
        .chain(updated.map(|(o, n)| Transition::new(Some(o), Some(n))))
}

impl<T: Keyed + PartialEq> Change<T> {
    /// Build a change from new and old rows. A key present on both sides is an update.
    pub fn from_sides(created: Vec<T>, removed: Vec<T>) -> Self {
        let mut before: HashMap<T::Key, T> = removed.into_iter().map(|r| (r.key(), r)).collect();
        let mut rows: Vec<_> = created
            .into_iter()
            .map(|r| Transition::new(before.remove(&r.key()), Some(r)))
            .collect();
        rows.extend(before.into_values().map(|r| Transition::new(Some(r), None)));
        rows.into_iter().collect()
    }

    /// Whether this change adds or updates `key`.
    pub fn touches(&self, key: T::Key) -> bool {
        self.after().any(|r| r.key() == key)
    }

    pub fn keys_iter(&self) -> impl Iterator<Item = T::Key> + '_ {
        self.transitions()
            .filter_map(|t| t.after.or(t.before))
            .map(T::key)
    }

    /// Keys of added, removed, and updated rows.
    pub fn keys(&self) -> Keys<T::Key> {
        Keys {
            added: self.added.iter().map(T::key).collect(),
            removed: self.removed.iter().map(T::key).collect(),
            updated: self.updated.iter().map(|(_, n)| n.key()).collect(),
        }
    }

    /// The highest key on either side.
    pub fn max_key(&self) -> Option<T::Key> {
        self.keys_iter().max()
    }
}

impl<K: Clone + Eq + Hash + Ord, V: PartialEq + Clone> Change<(K, V)> {
    /// Compare `before` and `after` at the given keys.
    pub fn at(
        before: &HashMap<K, V>,
        after: &HashMap<K, V>,
        keys: impl IntoIterator<Item = K>,
    ) -> Self {
        let row = |table: &HashMap<K, V>, k: &K| table.get(k).map(|v| (k.clone(), v.clone()));
        let keys: BTreeSet<K> = keys.into_iter().collect();
        keys.iter()
            .map(|k| Transition::new(row(before, k), row(after, k)))
            .collect()
    }

    /// Apply this change to `table`.
    pub fn apply_to(&self, table: &mut HashMap<K, V>) {
        for (k, _) in self.before() {
            table.remove(k);
        }
        for (k, v) in self.after() {
            table.insert(k.clone(), v.clone());
        }
    }
}

/// A reversible change that can be combined with a compatible later change.
pub trait Delta: Default + Sized {
    /// Whether this change's final state matches `later`'s initial state.
    fn meets(&self, later: &Self) -> bool;
    /// Combine with a compatible later change.
    fn compose(self, later: Self) -> Self;
    fn inverse(&self) -> Self;
    fn is_empty(&self) -> bool;

    /// Combine compatible changes; otherwise return both unchanged.
    fn then(self, later: Self) -> Result<Self, (Self, Self)> {
        if self.meets(&later) {
            Ok(self.compose(later))
        } else {
            Err((self, later))
        }
    }
}

impl<T: Keyed + PartialEq + Clone> Delta for Change<T> {
    fn meets(&self, later: &Self) -> bool {
        let ends: HashMap<T::Key, Option<&T>> = self
            .transitions()
            .filter_map(|t| Some((t.after.or(t.before)?.key(), t.after)))
            .collect();
        later.transitions().all(|t| {
            t.after
                .or(t.before)
                .and_then(|row| ends.get(&row.key()))
                .is_none_or(|end| *end == t.before)
        })
    }

    /// Keep each row's earliest before state and latest after state.
    fn compose(self, later: Self) -> Self {
        let mut order: Vec<T::Key> = Vec::new();
        let mut rows: HashMap<T::Key, Transition<T>> = HashMap::new();
        for t in self.into_transitions().chain(later.into_transitions()) {
            let Some(key) = t.key() else {
                continue;
            };
            match rows.entry(key) {
                hash_map::Entry::Occupied(mut held) => held.get_mut().after = t.after,
                hash_map::Entry::Vacant(slot) => {
                    order.push(slot.key().clone());
                    slot.insert(t);
                }
            }
        }
        order
            .into_iter()
            .filter_map(|key| rows.remove(&key))
            .collect()
    }

    fn inverse(&self) -> Self {
        self.transitions()
            .map(|t| Transition::new(t.after.cloned(), t.before.cloned()))
            .collect()
    }

    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }
}

impl<K: Clone + Eq + Hash, D: Delta> Delta for HashMap<K, D> {
    fn meets(&self, later: &Self) -> bool {
        later
            .iter()
            .all(|(key, delta)| self.get(key).is_none_or(|held| held.meets(delta)))
    }

    fn compose(mut self, later: Self) -> Self {
        for (key, delta) in later {
            let held = self.remove(&key).unwrap_or_default();
            self.insert(key, held.compose(delta));
        }
        self
    }

    fn inverse(&self) -> Self {
        self.iter()
            .map(|(key, delta)| (key.clone(), delta.inverse()))
            .collect()
    }

    fn is_empty(&self) -> bool {
        self.values().all(Delta::is_empty)
    }
}

pub fn ordered_table<T: Keyed>(rows: impl IntoIterator<Item = T>) -> HashMap<T::Key, (u32, T)> {
    rows.into_iter()
        .enumerate()
        .map(|(i, row)| (row.key(), (i as u32, row)))
        .collect()
}

pub fn ordered_rows<K, T>(table: HashMap<K, (u32, T)>) -> Vec<T> {
    let mut rows: Vec<_> = table.into_values().collect();
    rows.sort_by_key(|(order, _)| *order);
    rows.into_iter().map(|(_, row)| row).collect()
}

pub trait Dependencies<K> {
    fn inputs_changed_by(&self, changed: impl Fn(&K) -> bool) -> Vec<K>;
    fn outputs_of<'a>(
        &'a self,
        inputs: impl IntoIterator<Item = &'a K>,
    ) -> std::collections::HashSet<K>
    where
        K: 'a;
    fn invalidated(
        &self,
        inputs: Vec<K>,
        written: impl Fn(&K) -> bool,
    ) -> std::collections::HashSet<K>;
}

impl<K: Clone + Eq + Hash> Dependencies<K> for HashMap<K, Vec<K>> {
    fn inputs_changed_by(&self, changed: impl Fn(&K) -> bool) -> Vec<K> {
        self.keys().filter(|key| changed(key)).cloned().collect()
    }

    fn outputs_of<'a>(
        &'a self,
        inputs: impl IntoIterator<Item = &'a K>,
    ) -> std::collections::HashSet<K>
    where
        K: 'a,
    {
        inputs
            .into_iter()
            .flat_map(|input| self.get(input).into_iter().flatten())
            .cloned()
            .collect()
    }

    fn invalidated(
        &self,
        mut inputs: Vec<K>,
        written: impl Fn(&K) -> bool,
    ) -> std::collections::HashSet<K> {
        let mut stale = std::collections::HashSet::new();
        while let Some(input) = inputs.pop() {
            for output in self.get(&input).into_iter().flatten() {
                if !written(output) && stale.insert(output.clone()) {
                    inputs.push(output.clone());
                }
            }
        }
        stale
    }
}

pub fn rank_by<T, S>(
    rows: impl IntoIterator<Item = T>,
    take: Option<usize>,
    score: impl Fn(&T) -> Option<S>,
    compare: impl Fn(&S, &S) -> std::cmp::Ordering,
) -> Vec<T> {
    let mut scored: Vec<_> = rows
        .into_iter()
        .enumerate()
        .map(|(order, row)| {
            let value = score(&row);
            (row, value, order)
        })
        .collect();
    let better = |a: &(T, Option<S>, usize), b: &(T, Option<S>, usize)| {
        use std::cmp::Ordering;
        let order = match (&a.1, &b.1) {
            (Some(a), Some(b)) => compare(a, b),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        order.then_with(|| a.2.cmp(&b.2))
    };
    if let Some(take) = take {
        if take == 0 {
            return Vec::new();
        }
        if take < scored.len() {
            scored.select_nth_unstable_by(take - 1, &better);
            scored.truncate(take);
        }
    }
    scored.sort_by(better);
    scored.into_iter().map(|(row, _, _)| row).collect()
}

#[cfg(test)]
#[path = "lib.test.rs"]
mod tests;
