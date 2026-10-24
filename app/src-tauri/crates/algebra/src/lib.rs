//! Patches, pending edits, and reversible changes to keyed values.

use serde_json::Value;
use std::collections::{hash_map, BTreeMap, BTreeSet, HashMap, VecDeque};
use std::hash::Hash;
use std::marker::PhantomData;

type Object = serde_json::Map<String, Value>;

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
pub fn number_value(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        Value::from(v)
    }
}

/// A value that supports field patches. Implemented by `#[derive(mma_fields::Patch)]`.
pub trait Patchable: Sized {
    type Patch: Clone + PartialEq + std::fmt::Debug + serde::de::DeserializeOwned;
    /// The wire name and column of each field a patch writes.
    const WRITES: &'static [(&'static str, &'static str)] = &[];
    /// Wire names of fields that can be cleared with null.
    const CLEARS: &'static [&'static str] = &[];
    /// Apply `patch` to this value.
    fn patched(&self, patch: &Self::Patch) -> Self;
    /// The patch that turns `old` into `new`.
    fn between(old: &Self, new: &Self) -> Self::Patch;
    /// A patch setting every writable field to its current value.
    fn to_patch(&self) -> Self::Patch;
}

/// A change to some of a `T`'s fields: an absent field is unchanged.
pub type Patch<T> = <T as Patchable>::Patch;

/// A value written in its lossless form, the only form a patch has: without `Serialize`, a patch
/// cannot be written as JSON.
pub trait Encode {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error>;
}

/// A value serialized as its [`Encode`] form.
pub struct Encoded<'a, T: ?Sized>(pub &'a T);

impl<T: Encode + ?Sized> serde::Serialize for Encoded<'_, T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.encode(s)
    }
}

impl<T: Encode + ?Sized> Encode for Box<T> {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        (**self).encode(s)
    }
}

impl<T: Encode> Encode for Vec<T> {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.iter().map(Encoded))
    }
}

impl<K: serde::Serialize, V: Encode> Encode for HashMap<K, V> {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.iter().map(|(key, value)| (key, Encoded(value))))
    }
}

/// A value an optional slot holds, and how a patch writes it there.
/// A patchable value with a default fills an empty slot by patching its default.
pub trait Optional: Sized {
    type Patch: Clone + PartialEq + std::fmt::Debug + serde::de::DeserializeOwned;
    /// `patch` written over `old`, or over an empty slot; null when the result is no value.
    fn written(old: Option<&Self>, patch: &Self::Patch) -> Option<Self>;
    /// The patch that writes `new` over `old`, or into an empty slot.
    fn written_between(old: Option<&Self>, new: &Self) -> Self::Patch;
    /// A patch writing this whole value.
    fn writing(&self) -> Self::Patch;
}

impl<T: Patchable + Default> Optional for T {
    type Patch = Patch<T>;
    fn written(old: Option<&Self>, patch: &Self::Patch) -> Option<Self> {
        Some(match old {
            Some(old) => old.patched(patch),
            None => T::default().patched(patch),
        })
    }
    fn written_between(old: Option<&Self>, new: &Self) -> Self::Patch {
        match old {
            Some(old) => T::between(old, new),
            None => T::between(&T::default(), new),
        }
    }
    fn writing(&self) -> Self::Patch {
        Patchable::to_patch(self)
    }
}

/// An optional field update: absent keeps it, null clears it, and a value replaces it.
/// When updates are combined, the later update wins.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(remote = "Self")]
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

/// Read as JSON, null clears and a value sets; binary formats keep all three apart.
impl<T: serde::Serialize> serde::Serialize for Field<T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if !s.is_human_readable() {
            return Self::serialize(self, s);
        }
        match self {
            Field::Set(v) => s.serialize_some(v),
            Field::Keep | Field::Clear => s.serialize_none(),
        }
    }
}

impl<T: Encode> Encode for Field<T> {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        Field::serialize(&self.as_ref().map(Encoded), s)
    }
}

impl<'de, T: serde::Deserialize<'de>> serde::Deserialize<'de> for Field<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if d.is_human_readable() {
            Ok(Option::<T>::deserialize(d)?.into())
        } else {
            Self::deserialize(d)
        }
    }
}

impl<T: Optional + Clone + PartialEq> Patchable for Option<T> {
    type Patch = Field<<T as Optional>::Patch>;

    fn patched(&self, patch: &Self::Patch) -> Self {
        match patch {
            Field::Keep => self.clone(),
            Field::Clear => None,
            Field::Set(patch) => T::written(self.as_ref(), patch),
        }
    }

    fn between(old: &Self, new: &Self) -> Self::Patch {
        if old == new {
            return Field::Keep;
        }
        match new {
            None => Field::Clear,
            Some(value) => Field::Set(T::written_between(old.as_ref(), value)),
        }
    }

    fn to_patch(&self) -> Self::Patch {
        self.as_ref().map(Optional::writing).into()
    }
}

/// Apply RFC 7396 to any JSON target and patch.
pub fn merge_patch(target: &Value, patch: &Value) -> Value {
    let Value::Object(changes) = patch else {
        return patch.clone();
    };
    let mut out = target.as_object().cloned().unwrap_or_default();
    for (key, patch) in changes {
        if patch.is_null() {
            out.remove(key);
        } else {
            out.insert(
                key.clone(),
                merge_patch(out.get(key).unwrap_or(&Value::Null), patch),
            );
        }
    }
    Value::Object(out)
}

/// A merge patch when the target state is expressible by RFC 7396.
pub fn merge_patch_between(old: &Value, new: &Value) -> Option<Value> {
    let patch = if let Value::Object(new) = new {
        let empty = Object::new();
        let old = old.as_object().unwrap_or(&empty);
        let mut patch = Object::new();
        for (key, value) in new {
            if old.get(key) != Some(value) {
                patch.insert(
                    key.clone(),
                    merge_patch_between(old.get(key).unwrap_or(&Value::Null), value)?,
                );
            }
        }
        for key in old.keys().filter(|key| !new.contains_key(*key)) {
            patch.insert(key.clone(), Value::Null);
        }
        Value::Object(patch)
    } else {
        new.clone()
    };
    (merge_patch(old, &patch) == *new).then_some(patch)
}

/// One operation of a JSON Patch (RFC 6902). Paths are JSON Pointers (RFC 6901).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PatchOp {
    /// Put `value` at `path`, replacing a member already there or inserting into an array.
    Add {
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        value: Value,
    },
    /// Remove the value at `path`.
    Remove { path: String },
    /// Replace the value at `path`, which must exist.
    Replace {
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        value: Value,
    },
    /// Remove the value at `from` and add it at `path`.
    Move { from: String, path: String },
    /// Add a copy of the value at `from` at `path`.
    Copy { from: String, path: String },
    /// Fail the patch unless the value at `path` equals `value`.
    Test {
        path: String,
        #[specta(type = specta_typescript::Unknown)]
        value: Value,
    },
}

impl PatchOp {
    pub fn add<'a>(path: impl IntoIterator<Item = &'a str>, value: impl serde::Serialize) -> Self {
        Self::Add {
            path: json_pointer(path),
            value: to_json(value),
        }
    }

    pub fn remove<'a>(path: impl IntoIterator<Item = &'a str>) -> Self {
        Self::Remove {
            path: json_pointer(path),
        }
    }

    pub fn replace<'a>(
        path: impl IntoIterator<Item = &'a str>,
        value: impl serde::Serialize,
    ) -> Self {
        Self::Replace {
            path: json_pointer(path),
            value: to_json(value),
        }
    }
}

fn to_json(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("a patch value serializes to JSON")
}

/// The JSON Pointer (RFC 6901) naming each of `segments` in turn; none names the whole document.
pub fn json_pointer<'a>(segments: impl IntoIterator<Item = &'a str>) -> String {
    segments
        .into_iter()
        .map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1")))
        .collect()
}

/// A value in its JSON form: the value itself in human-readable formats, and its JSON text in
/// binary ones, which cannot describe free JSON.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Json<T = Value>(pub T);

impl<T> std::ops::Deref for Json<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> From<T> for Json<T> {
    fn from(value: T) -> Self {
        Json(value)
    }
}

impl<T: serde::Serialize> serde::Serialize for Json<T> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            self.0.serialize(s)
        } else {
            let text = serde_json::to_string(&self.0).map_err(serde::ser::Error::custom)?;
            s.serialize_str(&text)
        }
    }
}

impl<'de, T: serde::de::DeserializeOwned> serde::Deserialize<'de> for Json<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if d.is_human_readable() {
            T::deserialize(d).map(Json)
        } else {
            let text = String::deserialize(d)?;
            serde_json::from_str(&text)
                .map(Json)
                .map_err(serde::de::Error::custom)
        }
    }
}

/// A write to a JSON value: an RFC 7396 merge patch, or a whole replacement for a value merging
/// cannot reach, such as one holding a nested null. It is read from JSON as a merge patch and
/// encoded with which write it is.
#[derive(Clone, Debug, PartialEq)]
pub enum JsonWrite<D = Value> {
    Merge(D),
    Replace(D),
}

impl<D> JsonWrite<D> {
    /// The JSON this write carries.
    pub fn value(&self) -> &D {
        match self {
            JsonWrite::Merge(v) | JsonWrite::Replace(v) => v,
        }
    }

    pub fn map<E>(self, f: impl FnOnce(D) -> E) -> JsonWrite<E> {
        match self {
            JsonWrite::Merge(v) => JsonWrite::Merge(f(v)),
            JsonWrite::Replace(v) => JsonWrite::Replace(f(v)),
        }
    }

    /// How this write writes its JSON.
    pub fn policy(&self) -> Policy {
        match self {
            JsonWrite::Merge(_) => Policy::Merge,
            JsonWrite::Replace(_) => Policy::Replace,
        }
    }
}

/// A merge patch.
impl<D> From<D> for JsonWrite<D> {
    fn from(v: D) -> Self {
        JsonWrite::Merge(v)
    }
}

impl<D: Default> Default for JsonWrite<D> {
    fn default() -> Self {
        JsonWrite::Merge(D::default())
    }
}

impl<D: serde::Serialize> Encode for JsonWrite<D> {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        serde::Serialize::serialize(&(self.policy(), Json(self.value())), s)
    }
}

impl<'de, D: serde::de::DeserializeOwned> serde::Deserialize<'de> for JsonWrite<D> {
    fn deserialize<De: serde::Deserializer<'de>>(d: De) -> Result<Self, De::Error> {
        if d.is_human_readable() {
            return D::deserialize(d).map(JsonWrite::Merge);
        }
        let (policy, Json(value)) = <(Policy, Json<D>)>::deserialize(d)?;
        Ok(match policy {
            Policy::Merge => JsonWrite::Merge(value),
            Policy::Replace => JsonWrite::Replace(value),
        })
    }
}

impl JsonWrite {
    /// The write that turns `old` into `new`: a merge patch wherever one reaches it.
    pub fn between(old: &Value, new: &Value) -> Self {
        merge_patch_between(old, new)
            .map_or_else(|| JsonWrite::Replace(new.clone()), JsonWrite::Merge)
    }
}

/// How a patch writes a JSON value: merged into it per RFC 7396, or written over it whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Policy {
    Merge,
    Replace,
}

impl Policy {
    fn written(self, target: &Value, patch: &Value) -> Value {
        match self {
            Policy::Merge => merge_patch(target, patch),
            Policy::Replace => patch.clone(),
        }
    }

    fn patch_between(self, old: &Value, new: &Value) -> Option<Value> {
        match self {
            Policy::Merge => merge_patch_between(old, new),
            Policy::Replace => Some(new.clone()),
        }
    }
}

/// `patch` written over `target` under `policy`, with each of `fields` under its own policy.
fn policy_patched(
    target: &Value,
    patch: &Value,
    policy: Policy,
    fields: &[(&str, Policy)],
) -> Value {
    let mut out = policy.written(target, patch);
    if let (Some(changes), Some(out)) = (patch.as_object(), out.as_object_mut()) {
        for &(key, field) in fields {
            if let Some(change) = changes.get(key) {
                out.insert(
                    key.to_owned(),
                    field.written(target.get(key).unwrap_or(&Value::Null), change),
                );
            }
        }
    }
    out
}

/// The patch that `policy_patched` writes over `old` to reach `new`, when one does.
fn policy_between(
    old: &Value,
    new: &Value,
    policy: Policy,
    fields: &[(&str, Policy)],
) -> Option<Value> {
    let mut base_old = old.clone();
    let mut base_new = new.clone();
    for &(key, _) in fields {
        if let Some(map) = base_old.as_object_mut() {
            map.remove(key);
        }
        if let Some(map) = base_new.as_object_mut() {
            map.remove(key);
        }
    }
    let mut patch = policy.patch_between(&base_old, &base_new)?;
    if let Some(changes) = patch.as_object_mut() {
        for &(key, field) in fields {
            if policy == Policy::Replace || old.get(key) != new.get(key) {
                let after = new.get(key).unwrap_or(&Value::Null);
                changes.insert(
                    key.to_owned(),
                    field.patch_between(old.get(key).unwrap_or(&Value::Null), after)?,
                );
            }
        }
    }
    (policy_patched(old, &patch, policy, fields) == *new).then_some(patch)
}

/// `value` with `patch` written over it under `policy`, each of `fields` under its own policy.
pub fn json_patched<T: serde::Serialize + serde::de::DeserializeOwned>(
    value: &T,
    patch: &JsonWrite,
    policy: Policy,
    fields: &[(&str, Policy)],
) -> T {
    let patched = match patch {
        JsonWrite::Merge(patch) => policy_patched(
            &serde_json::to_value(value).expect("patch target serializes"),
            patch,
            policy,
            fields,
        ),
        JsonWrite::Replace(value) => value.clone(),
    };
    serde_json::from_value(patched).expect("patched JSON fits the target type")
}

/// The write that `json_patched` turns `old` into `new` with.
pub fn json_between<T: serde::Serialize>(
    old: &T,
    new: &T,
    policy: Policy,
    fields: &[(&str, Policy)],
) -> JsonWrite {
    let old = serde_json::to_value(old).expect("patch target serializes");
    let new = serde_json::to_value(new).expect("patch target serializes");
    policy_between(&old, &new, policy, fields)
        .map_or_else(|| JsonWrite::Replace(new), JsonWrite::Merge)
}

impl Patchable for Json {
    type Patch = JsonWrite;
    fn patched(&self, patch: &Self::Patch) -> Self {
        Json(match patch {
            JsonWrite::Merge(patch) => merge_patch(self, patch),
            JsonWrite::Replace(value) => value.clone(),
        })
    }
    fn between(old: &Self, new: &Self) -> Self::Patch {
        JsonWrite::between(old, new)
    }
    fn to_patch(&self) -> Self::Patch {
        JsonWrite::Merge(self.0.clone())
    }
}

/// Keyed edits preserve untouched entries; patching an absent entry starts from its default.
impl<K, V> Patchable for HashMap<K, V>
where
    K: Clone + Eq + Hash + std::fmt::Debug + serde::Serialize + serde::de::DeserializeOwned,
    V: Patchable
        + Clone
        + Default
        + PartialEq
        + std::fmt::Debug
        + serde::Serialize
        + serde::de::DeserializeOwned,
{
    type Patch = HashMap<K, Op<V, Patch<V>, ()>>;

    fn patched(&self, patch: &Self::Patch) -> Self {
        let mut out = self.clone();
        for (key, edit) in patch {
            match edit.applied(Some(out.get(key).cloned().unwrap_or_default()), V::patched) {
                Some(value) => {
                    out.insert(key.clone(), value);
                }
                None => {
                    out.remove(key);
                }
            }
        }
        out
    }

    fn between(old: &Self, new: &Self) -> Self::Patch {
        let mut patch = HashMap::new();
        for (key, value) in new {
            match old.get(key) {
                Some(before) if before == value => {}
                Some(before) => {
                    patch.insert(key.clone(), Op::Put(V::between(before, value)));
                }
                None => {
                    patch.insert(key.clone(), Op::Set(value.clone()));
                }
            }
        }
        for key in old.keys().filter(|key| !new.contains_key(*key)) {
            patch.insert(key.clone(), Op::Remove(()));
        }
        patch
    }

    fn to_patch(&self) -> Self::Patch {
        self.iter()
            .map(|(key, value)| (key.clone(), Op::Set(value.clone())))
            .collect()
    }
}

impl Patchable for Object {
    type Patch = JsonWrite<Self>;
    fn patched(&self, patch: &Self::Patch) -> Self {
        match patch {
            JsonWrite::Merge(patch) => {
                merge_patch(&Value::Object(self.clone()), &Value::Object(patch.clone()))
                    .as_object()
                    .cloned()
                    .expect("object merge returns an object")
            }
            JsonWrite::Replace(value) => value.clone(),
        }
    }
    fn between(old: &Self, new: &Self) -> Self::Patch {
        match JsonWrite::between(&Value::Object(old.clone()), &Value::Object(new.clone())) {
            JsonWrite::Merge(Value::Object(patch)) => JsonWrite::Merge(patch),
            _ => JsonWrite::Replace(new.clone()),
        }
    }
    fn to_patch(&self) -> Self::Patch {
        JsonWrite::Merge(self.clone())
    }
}

/// How a patchable value and its patch look on the wire.
pub trait Wire {
    type Value;
    type Patch;
}

impl Wire for Json {
    type Value = specta_typescript::Unknown;
    type Patch = specta_typescript::Unknown;
}

impl Wire for Object {
    type Value = HashMap<String, specta_typescript::Unknown>;
    type Patch = Self::Value;
}

impl<K, V: Wire> Wire for HashMap<K, V> {
    type Value = HashMap<K, V::Value>;
    type Patch = HashMap<K, Op<V::Value, V::Patch, ()>>;
}

/// Where a tree node holds its children, and how they are visited and rebuilt.
pub trait ChildSlot<S> {
    /// The same slot over another child type.
    type Of<T>;
    /// The children held, in order.
    fn held(&self) -> Vec<&S>;
    /// The slot with each child mapped through `map`.
    fn mapped<T>(self, map: impl FnMut(S) -> T) -> Self::Of<T>;
    /// A copy of the slot with each child mapped through `map`.
    fn mapped_ref<T>(&self, map: impl FnMut(&S) -> T) -> Self::Of<T>;
    /// A slot filled, in order, from `children`.
    fn filled<T>(children: &mut impl Iterator<Item = T>) -> Self::Of<T>;
}

impl<S> ChildSlot<S> for Vec<S> {
    type Of<T> = Vec<T>;
    fn held(&self) -> Vec<&S> {
        self.iter().collect()
    }
    fn mapped<T>(self, map: impl FnMut(S) -> T) -> Vec<T> {
        self.into_iter().map(map).collect()
    }
    fn mapped_ref<T>(&self, map: impl FnMut(&S) -> T) -> Vec<T> {
        self.iter().map(map).collect()
    }
    fn filled<T>(children: &mut impl Iterator<Item = T>) -> Vec<T> {
        children.collect()
    }
}

impl<S> ChildSlot<S> for Option<Box<S>> {
    type Of<T> = Option<Box<T>>;
    fn held(&self) -> Vec<&S> {
        self.as_deref().into_iter().collect()
    }
    fn mapped<T>(self, mut map: impl FnMut(S) -> T) -> Option<Box<T>> {
        self.map(|child| Box::new(map(*child)))
    }
    fn mapped_ref<T>(&self, mut map: impl FnMut(&S) -> T) -> Option<Box<T>> {
        self.as_deref().map(|child| Box::new(map(child)))
    }
    fn filled<T>(children: &mut impl Iterator<Item = T>) -> Option<Box<T>> {
        children.next().map(Box::new)
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

/// Ids handed out together, one after another.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct IdRange<_T> {
    /// The first id in the run.
    pub first: Id<_T>,
    /// How many ids the run holds.
    pub len: u32,
}

impl<_T> Default for IdRange<_T> {
    fn default() -> Self {
        Self {
            first: Id::new(0),
            len: 0,
        }
    }
}

impl<_T> IdRange<_T> {
    /// The `i`th id of the run, or nothing past its end.
    pub fn nth(&self, i: u32) -> Option<Id<_T>> {
        (i < self.len).then(|| Id::new(self.first.0 + i))
    }

    /// Whether `id` is one of the run's.
    pub fn contains(&self, id: Id<_T>) -> bool {
        id.0.checked_sub(self.first.0).is_some_and(|i| i < self.len)
    }

    /// Every id of the run, in order.
    pub fn iter(&self) -> impl Iterator<Item = Id<_T>> {
        let first = self.first.0;
        (first..first + self.len).map(Id::new)
    }
}

impl<T> Ids<Id<T>> {
    /// Hand out `len` ids no row holds, one after another, or none when the lease cannot fit them.
    pub fn take_run(&mut self, len: u32) -> Result<IdRange<T>, Exhausted> {
        let first = self.next;
        let next = Id::new(first.0.checked_add(len).ok_or(Exhausted)?);
        if self.end.is_some_and(|end| next > end) {
            return Err(Exhausted);
        }
        self.next = next;
        Ok(IdRange { first, len })
    }

    /// Hand out only the ids of `lease` from now on.
    pub fn lease(&mut self, lease: IdRange<T>) {
        self.next = lease.first;
        self.end = Some(Id::new(lease.first.0 + lease.len));
    }

    /// How many ids are left to hand out, or `None` when no lease bounds them.
    pub fn remaining(&self) -> Option<u32> {
        self.end.map(|end| end.0.saturating_sub(self.next.0))
    }
}

/// A value addressed by key wherever it lives.
pub trait Keyed {
    type Key: Clone + Eq + Hash + Ord;
    fn key(&self) -> Self::Key;
    fn set_key(&mut self, key: Self::Key);
}

/// A table row: a value at its key.
impl<K: Clone + Eq + Hash + Ord, V> Keyed for (K, V) {
    type Key = K;
    fn key(&self) -> K {
        self.0.clone()
    }
    fn set_key(&mut self, key: K) {
        self.0 = key;
    }
}

/// Compare a keyed value with the state held there, including absence.
pub trait Holds<T: Keyed> {
    fn holds(&self, key: &T::Key, expected: Option<&T>) -> bool;
}

impl<K: Clone + Eq + Hash + Ord, V: PartialEq> Holds<(K, V)> for HashMap<K, V> {
    fn holds(&self, key: &K, expected: Option<&(K, V)>) -> bool {
        expected.is_none_or(|(expected, _)| expected == key)
            && self.get(key) == expected.map(|(_, value)| value)
    }
}

impl<T: Keyed + PartialEq> Holds<T> for BTreeMap<T::Key, T> {
    fn holds(&self, key: &T::Key, expected: Option<&T>) -> bool {
        self.get(key) == expected
    }
}

/// A value kept in step with a collection by applying each change to it.
pub trait Follows<T> {
    fn apply(&mut self, change: &Change<T>);
}

/// Keyed rows, at most one under each key.
pub trait Table<T: Keyed> {
    /// The row under `key`.
    fn row(&self, key: &T::Key) -> Option<T>;
    /// The key of every row held.
    fn row_keys(&self) -> impl Iterator<Item = T::Key> + '_;
    fn remove_row(&mut self, key: &T::Key);
    /// Hold `row` under its key, replacing the row there.
    fn insert_row(&mut self, row: T);
}

/// A table of values by key, its rows the key and value paired.
impl<K: Clone + Eq + Hash + Ord, V: Clone> Table<(K, V)> for HashMap<K, V> {
    fn row(&self, key: &K) -> Option<(K, V)> {
        self.get(key).map(|value| (key.clone(), value.clone()))
    }
    fn row_keys(&self) -> impl Iterator<Item = K> + '_ {
        self.keys().cloned()
    }
    fn remove_row(&mut self, key: &K) {
        self.remove(key);
    }
    fn insert_row(&mut self, (key, value): (K, V)) {
        self.insert(key, value);
    }
}

impl<T: Keyed + Clone> Table<T> for BTreeMap<T::Key, T> {
    fn row(&self, key: &T::Key) -> Option<T> {
        self.get(key).cloned()
    }
    fn row_keys(&self) -> impl Iterator<Item = T::Key> + '_ {
        self.keys().cloned()
    }
    fn remove_row(&mut self, key: &T::Key) {
        self.remove(key);
    }
    fn insert_row(&mut self, row: T) {
        self.insert(row.key(), row);
    }
}

/// `rows` held under their keys, in key order.
pub fn by_key<T: Keyed>(rows: impl IntoIterator<Item = T>) -> BTreeMap<T::Key, T> {
    rows.into_iter().map(|row| (row.key(), row)).collect()
}

/// A key a table numbers in order: each new row takes the one after the highest in use.
pub trait Sequential: Clone + Ord + Default {
    fn after(&self) -> Self;
}

impl Sequential for u32 {
    fn after(&self) -> u32 {
        self + 1
    }
}

impl<T> Sequential for Id<T> {
    fn after(&self) -> Self {
        Id::new(self.0 + 1)
    }
}

/// Hands out keys above every key it has seen, so it never hands out one twice. A leased one
/// hands out only keys below the end of its lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ids<K> {
    next: K,
    end: Option<K>,
}

/// Every key the lease allows is taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exhausted;

impl std::fmt::Display for Exhausted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("every key the lease allows is taken")
    }
}

impl std::error::Error for Exhausted {}

impl<K: Sequential> Default for Ids<K> {
    fn default() -> Self {
        Self::starting_at(K::default().after())
    }
}

impl<K: Sequential> Ids<K> {
    /// Keys from `next` up.
    pub fn starting_at(next: K) -> Self {
        Self { next, end: None }
    }

    /// Keys above every one in `seen`.
    pub fn above(seen: impl IntoIterator<Item = K>) -> Self {
        let mut ids = Self::default();
        for key in seen {
            ids.saw(&key);
        }
        ids
    }

    /// The key the next new row takes.
    pub fn next(&self) -> &K {
        &self.next
    }

    /// Hand out a key no row holds.
    pub fn take(&mut self) -> Result<K, Exhausted> {
        if self.end.as_ref().is_some_and(|end| self.next >= *end) {
            return Err(Exhausted);
        }
        let key = self.next.clone();
        self.next = key.after();
        Ok(key)
    }

    /// `key` is in use, so later keys go above it. A key past the lease is someone else's.
    pub fn saw(&mut self, key: &K) {
        if *key >= self.next && self.end.as_ref().is_none_or(|end| key < end) {
            self.next = key.after();
        }
    }

    /// The key `edit` names, and the edit as written there: an added row takes a fresh key
    /// and is set at it, and a row set at a key keeps later keys above it.
    pub fn key<T, P>(&mut self, edit: Op<T, P, K>) -> Result<(K, Op<T, P, K>), Exhausted>
    where
        T: Keyed<Key = K>,
        P: Keyed<Key = K>,
    {
        Ok(match edit {
            Op::Add(mut row) => {
                let key = self.take()?;
                row.set_key(key.clone());
                (key, Op::Set(row))
            }
            Op::Set(row) => {
                let key = row.key();
                self.saw(&key);
                (key, Op::Set(row))
            }
            Op::Put(patch) => (patch.key(), Op::Put(patch)),
            Op::Remove(key) => (key.clone(), Op::Remove(key)),
        })
    }

    /// `edits` each as [`Self::key`] writes it, and the keys the added rows took in order. When
    /// not every added row can take a key, none is taken.
    pub fn key_all<T, P>(
        &mut self,
        edits: impl IntoIterator<Item = Op<T, P, K>>,
    ) -> Result<(Vec<Op<T, P, K>>, Vec<K>), Exhausted>
    where
        T: Keyed<Key = K>,
        P: Keyed<Key = K>,
    {
        let mut ids = self.clone();
        let mut added = Vec::new();
        let keyed = edits
            .into_iter()
            .map(|edit| {
                let new = matches!(edit, Op::Add(_));
                let (key, edit) = ids.key(edit)?;
                if new {
                    added.push(key);
                }
                Ok(edit)
            })
            .collect::<Result<_, _>>()?;
        *self = ids;
        Ok((keyed, added))
    }
}

/// A unique name as rows compare it: trimmed, case folded, and absent when blank.
pub fn unique_name(name: &str) -> Option<String> {
    trimmed_name(name).map(str::to_lowercase)
}

/// A name as rows store it: trimmed, and absent when blank.
pub fn trimmed_name(name: &str) -> Option<&str> {
    Some(name.trim()).filter(|name| !name.is_empty())
}

/// An edit to one keyed row: add it, replace it, patch it, or remove it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Op<T, P, K> {
    /// A new row, given the next free key in place of the one it carries.
    Add(T),
    /// The row exactly as given.
    Set(T),
    /// A patch written over the row it names.
    Put(P),
    /// The row at this key removed.
    Remove(K),
}

/// An edit to a keyed, patchable row.
pub type Edit<T> = Op<T, Patch<T>, <T as Keyed>::Key>;

impl<T: serde::Serialize, P: Encode, K: serde::Serialize> Encode for Op<T, P, K> {
    fn encode<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let op = match self {
            Op::Add(row) => Op::Add(row),
            Op::Set(row) => Op::Set(row),
            Op::Put(patch) => Op::Put(Encoded(patch)),
            Op::Remove(key) => Op::Remove(key),
        };
        serde::Serialize::serialize(&op, s)
    }
}

impl<T: Clone, P, K> Op<T, P, K> {
    /// Apply this edit to the underlying row. Patching a missing row has no effect.
    pub fn applied(&self, below: Option<T>, apply: impl Fn(&T, &P) -> T) -> Option<T> {
        match self {
            Op::Add(row) | Op::Set(row) => Some(row.clone()),
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
/// An added row lands on the row holding its unique value, filling what that row leaves
/// empty, or takes a key above `floor` and every key in the table; either way its empty
/// sequence fields are numbered. A write that takes a unique value another row holds leaves
/// its row unchanged and is reported in `redirects`.
pub fn apply<T>(
    table: &mut HashMap<T::Key, T>,
    edits: impl IntoIterator<Item = Edit<T>>,
    floor: T::Key,
) -> Applied<T::Key>
where
    T: Constrained + Patchable + Clone,
    T::Key: Sequential,
    Patch<T>: Keyed<Key = T::Key>,
{
    let mut ids = Ids::above(table.keys().cloned().chain([floor]));
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
            Op::Add(row) => {
                let (key, mut row) = match row.unique().and_then(|u| holders.get(&u)) {
                    Some(held) => (held.clone(), table[held].filled(&row)),
                    None => {
                        let key = ids.take().expect("an unleased Ids never runs out");
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
            Op::Set(row) => {
                ids.saw(&row.key());
                (row.key(), row)
            }
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

impl<T: Patchable + Keyed> Layer<T>
where
    Patch<T>: Keyed<Key = T::Key>,
{
    /// Append keyed edits by the key each names, as [`Ids::key_all`] writes them. Replacing
    /// or removing a row discards its earlier edits.
    pub fn write(&mut self, edits: impl IntoIterator<Item = Edit<T>>) {
        for edit in edits {
            let key = match &edit {
                Op::Add(row) | Op::Set(row) => row.key(),
                Op::Put(patch) => patch.key(),
                Op::Remove(key) => key.clone(),
            };
            let held = self.ops.entry(key).or_default();
            if !matches!(edit, Op::Put(_)) {
                held.clear();
            }
            held.push(edit);
        }
    }

    /// Rewrite every pending edit, keeping each row's edits in order.
    pub fn map_edits(self, f: impl FnMut(Edit<T>) -> Edit<T>) -> Self {
        let mut layer = Self::default();
        layer.write(self.into_edits().map(f));
        layer
    }

    /// Every pending edit, each row's in the order it was made.
    pub fn into_edits(self) -> impl Iterator<Item = Edit<T>> {
        self.ops.into_values().flatten()
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

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
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

    /// The net change in rows under each key `project` files a row under, counting a row
    /// before as minus one and a row after as plus one.
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

    /// This change seen through `project`, dropping rows whose projection did not change.
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

impl<T: Keyed + PartialEq + Clone> Change<T> {
    /// Compare `before` and `after` at the given keys, in key order.
    pub fn at(
        before: &impl Table<T>,
        after: &impl Table<T>,
        keys: impl IntoIterator<Item = T::Key>,
    ) -> Self {
        let keys: BTreeSet<T::Key> = keys.into_iter().collect();
        keys.iter()
            .map(|k| Transition::new(before.row(k), after.row(k)))
            .collect()
    }

    /// Compare `before` and `after` at every key either holds, in key order.
    pub fn between(before: &impl Table<T>, after: &impl Table<T>) -> Self {
        Self::at(before, after, before.row_keys().chain(after.row_keys()))
    }

    /// Apply this change to `table`.
    pub fn apply_to(&self, table: &mut impl Table<T>) {
        for row in self.before() {
            table.remove_row(&row.key());
        }
        for row in self.after() {
            table.insert_row(row.clone());
        }
    }
}

impl<T: Keyed> Change<T> {
    /// Whether `table` still holds every state this change starts from, naming the keys it does not.
    pub fn standing_on(&self, table: &impl Holds<T>) -> Result<(), Moved<T::Key>> {
        let moved: Vec<T::Key> = self
            .transitions()
            .filter_map(|t| {
                let key = t.before.or(t.after)?.key();
                (!table.holds(&key, t.before)).then_some(key)
            })
            .collect();
        if moved.is_empty() {
            Ok(())
        } else {
            Err(Moved(moved))
        }
    }
}

/// The keys whose rows no longer hold the state a change starts from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Moved<K>(pub Vec<K>);

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

/// For each key, the keys computed from it.
#[derive(Clone, Debug, PartialEq)]
pub struct Dependents<K: Eq + Hash>(HashMap<K, Vec<K>>);

impl<K: Eq + Hash> Default for Dependents<K> {
    fn default() -> Self {
        Self(HashMap::new())
    }
}

impl<K: Clone + Eq + Hash> Dependents<K> {
    pub fn new(edges: HashMap<K, Vec<K>>) -> Self {
        Self(edges)
    }

    /// The inputs `changed` reports as changed.
    pub fn inputs_changed_by(&self, changed: impl Fn(&K) -> bool) -> Vec<K> {
        self.0.keys().filter(|key| changed(key)).cloned().collect()
    }

    /// The keys computed directly from any of `inputs`.
    pub fn outputs_of<'a>(
        &'a self,
        inputs: impl IntoIterator<Item = &'a K>,
    ) -> std::collections::HashSet<K>
    where
        K: 'a,
    {
        inputs
            .into_iter()
            .flat_map(|input| self.0.get(input).into_iter().flatten())
            .cloned()
            .collect()
    }

    /// Every key computed, directly or through others, from `inputs`, stopping at keys the
    /// same write sets itself.
    pub fn invalidated(
        &self,
        mut inputs: Vec<K>,
        written: impl Fn(&K) -> bool,
    ) -> std::collections::HashSet<K> {
        let mut stale = std::collections::HashSet::new();
        while let Some(input) = inputs.pop() {
            for output in self.0.get(&input).into_iter().flatten() {
                if !written(output) && stale.insert(output.clone()) {
                    inputs.push(output.clone());
                }
            }
        }
        stale
    }
}

/// The newest values put under rising keys, at most `cap` of them, the oldest let go first.
pub struct Recent<K, V> {
    cap: usize,
    held: VecDeque<(K, V)>,
}

impl<K: Ord, V> Recent<K, V> {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            held: VecDeque::new(),
        }
    }

    /// Keep `value` under `key`, above every key held, letting go of the oldest past the cap.
    pub fn put(&mut self, key: K, value: V) {
        self.held.push_back((key, value));
        if self.held.len() > self.cap {
            self.held.pop_front();
        }
    }

    /// The value held under `key`.
    pub fn get(&self, key: &K) -> Option<&V> {
        self.held
            .iter()
            .find(|(held, _)| held == key)
            .map(|(_, value)| value)
    }

    /// The oldest key still held.
    pub fn oldest(&self) -> Option<&K> {
        self.held.front().map(|(key, _)| key)
    }

    /// The newest key put.
    pub fn newest(&self) -> Option<&K> {
        self.held.back().map(|(key, _)| key)
    }

    /// The values held under keys above `key`, oldest first.
    pub fn after<'a>(&'a self, key: &'a K) -> impl Iterator<Item = &'a V> + 'a {
        self.held
            .iter()
            .filter(move |(held, _)| held > key)
            .map(|(_, value)| value)
    }

    /// Let go of everything.
    pub fn clear(&mut self) {
        self.held.clear();
    }
}

#[cfg(test)]
#[path = "lib.test.rs"]
mod tests;
