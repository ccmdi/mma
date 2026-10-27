//! Equality indexes over projected row keys. Ownership determines their lifetime: a query
//! keeps a local index; a store keeps indexes it maintains across changes.

use super::id_set::IdSet;
use mma_algebra::{Change, Id};
use std::borrow::Borrow;
use std::collections::{BTreeSet, HashMap};
use std::hash::Hash;

/// The keys a row contributes, and whether the projected value is present. A present
/// value can contribute no keys, as with a field indexed only for presence.
pub(crate) trait Projection<R> {
    type Key: Clone + Eq + Hash + Ord;

    fn project(&self, row: &R, emit: impl FnMut(Self::Key)) -> bool;
}

impl<R, P: Projection<R>> Projection<R> for &P {
    type Key = P::Key;

    fn project(&self, row: &R, emit: impl FnMut(Self::Key)) -> bool {
        P::project(self, row, emit)
    }
}

/// Distinct key spaces allow alternatives with equal underlying key types.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Key<A, B> {
    First(A),
    Second(B),
}

/// Index both alternatives; query either both or the first present projection.
pub(crate) struct Choice<A, B>(pub A, pub B);

impl<A, B> Choice<A, B> {
    pub fn preferred(&self) -> Preferred<'_, A, B> {
        Preferred(self)
    }
}

impl<R, A: Projection<R>, B: Projection<R>> Projection<R> for Choice<A, B> {
    type Key = Key<A::Key, B::Key>;

    fn project(&self, row: &R, mut emit: impl FnMut(Self::Key)) -> bool {
        let first = self.0.project(row, |key| emit(Key::First(key)));
        let second = self.1.project(row, |key| emit(Key::Second(key)));
        first || second
    }
}

pub(crate) struct Preferred<'a, A, B>(&'a Choice<A, B>);

impl<R, A: Projection<R>, B: Projection<R>> Projection<R> for Preferred<'_, A, B> {
    type Key = Key<A::Key, B::Key>;

    fn project(&self, row: &R, mut emit: impl FnMut(Self::Key)) -> bool {
        let Choice(first, second) = self.0;
        first.project(row, |key| emit(Key::First(key)))
            || second.project(row, |key| emit(Key::Second(key)))
    }
}

/// A composite projection contributes the pairs of its components' keys.
impl<R, A: Projection<R>, B: Projection<R>> Projection<R> for (A, B) {
    type Key = (A::Key, B::Key);

    fn project(&self, row: &R, mut emit: impl FnMut(Self::Key)) -> bool {
        let mut present = false;
        self.0.project(row, |left| {
            self.1.project(row, |right| {
                present = true;
                emit((left.clone(), right));
            });
        });
        present
    }
}

/// The ids holding a projected value and the ids associated with each of its keys.
pub(crate) struct Index<K, T, P, B = IdSet<T>> {
    pub projection: P,
    pub rows: IdSet<T>,
    pub by_value: HashMap<K, B>,
}

/// What an index retains for one key. Store indexes retain row ids; a local membership
/// index retains just the key, with no per-key bitmap allocation.
pub(crate) trait Bucket<T> {
    fn empty() -> Self;
    fn insert(&mut self, id: Id<T>);
    fn is_empty(&self) -> bool;
}

impl<T> Bucket<T> for IdSet<T> {
    fn empty() -> Self {
        Self::new()
    }
    fn insert(&mut self, id: Id<T>) {
        IdSet::insert(self, id);
    }
    fn is_empty(&self) -> bool {
        IdSet::is_empty(self)
    }
}

/// A key-only bucket. These indexes are built for a read and dropped after it, never updated.
pub(crate) struct Present;

impl<T> Bucket<T> for Present {
    fn empty() -> Self {
        Self
    }
    fn insert(&mut self, _id: Id<T>) {}
    fn is_empty(&self) -> bool {
        false
    }
}

/// A change expressed in the keys each row contributes to an index.
pub(crate) type Contributions<K, T> = Change<(Id<T>, Option<Vec<K>>)>;

impl<K: Clone + Eq + Hash + Ord, T, P> Index<K, T, P> {
    pub fn new(projection: P) -> Self {
        Self {
            projection,
            rows: IdSet::new(),
            by_value: HashMap::new(),
        }
    }

    pub fn membership(projection: P) -> Index<K, T, P, Present> {
        Index {
            projection,
            rows: IdSet::new(),
            by_value: HashMap::new(),
        }
    }

    pub fn count<Q: Eq + Hash + ?Sized>(&self, key: &Q) -> usize
    where
        K: Borrow<Q>,
    {
        self.by_value.get(key).map_or(0, |ids| ids.len() as usize)
    }
}

impl<K: Clone + Eq + Hash + Ord, T, P, B: Bucket<T>> Index<K, T, P, B> {
    /// Read only the projection, never an owned copy of the whole row.
    pub fn insert<R>(&mut self, id: Id<T>, row: &R)
    where
        P: Projection<R, Key = K>,
    {
        let postings = &mut self.by_value;
        if self.projection.project(row, |key| {
            postings.entry(key).or_insert_with(B::empty).insert(id);
        }) {
            self.rows.insert(id);
        }
    }

    pub fn contains<Q: Eq + Hash + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.by_value
            .get(key)
            .is_some_and(|bucket| !bucket.is_empty())
    }

    /// Query using another projection into the same key space, such as a preferred choice.
    pub fn matches<R>(&self, projection: &impl Projection<R, Key = K>, row: &R) -> bool {
        let mut found = false;
        projection.project(row, |key| found |= self.contains(&key));
        found
    }

    pub fn project<R>(&self, change: &Change<R>, id: impl Fn(&R) -> Id<T>) -> Contributions<K, T>
    where
        P: Projection<R, Key = K>,
    {
        change.project(|row| {
            let mut keys = Vec::new();
            let present = self.projection.project(row, |key| keys.push(key));
            keys.sort();
            keys.dedup();
            (id(row), present.then_some(keys))
        })
    }
}

impl<K: Clone + Eq + Hash + Ord, T, P> Index<K, T, P> {
    /// Remove old contributions before inserting new ones. Set membership counts each row
    /// once even when a list repeats a key.
    pub fn apply(&mut self, change: &Contributions<K, T>) -> BTreeSet<K> {
        let mut moved = BTreeSet::new();
        for ((id, keys), present) in change
            .before()
            .map(|row| (row, false))
            .chain(change.after().map(|row| (row, true)))
        {
            let Some(keys) = keys else { continue };
            if present {
                self.rows.insert(*id);
            } else {
                self.rows.remove(*id);
            }
            for key in keys {
                let ids = self.by_value.entry(key.clone()).or_insert_with(IdSet::new);
                if present {
                    ids.insert(*id);
                } else {
                    ids.remove(*id);
                }
                moved.insert(key.clone());
            }
        }
        moved
    }
}

#[cfg(test)]
#[path = "index.test.rs"]
mod tests;
