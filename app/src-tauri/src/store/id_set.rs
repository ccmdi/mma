use mma_algebra::Id;
use roaring::{bitmap::Iter, RoaringBitmap};
use std::fmt;
use std::iter::Map;
use std::marker::PhantomData;
use std::ops::{BitAnd, BitAndAssign, BitOr, BitOrAssign, Sub, SubAssign};

/// A set of ids of one kind, stored as a compressed bitmap.
#[derive(Clone, Default, PartialEq)]
pub(crate) struct IdSet<T> {
    raw: RoaringBitmap,
    marker: PhantomData<fn() -> T>,
}

impl<T> fmt::Debug for IdSet<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.raw.fmt(f)
    }
}
impl<T> IdSet<T> {
    pub(crate) fn new() -> Self {
        Self {
            raw: RoaringBitmap::new(),
            marker: PhantomData,
        }
    }
    pub(crate) fn insert(&mut self, id: Id<T>) -> bool {
        self.raw.insert(id.get())
    }
    pub(crate) fn remove(&mut self, id: Id<T>) -> bool {
        self.raw.remove(id.get())
    }
    pub(crate) fn contains(&self, id: Id<T>) -> bool {
        self.raw.contains(id.get())
    }
    pub(crate) fn clear(&mut self) {
        self.raw.clear();
    }
    pub(crate) fn len(&self) -> u64 {
        self.raw.len()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.raw.is_empty()
    }
    pub(crate) fn iter(&self) -> Map<Iter<'_>, fn(u32) -> Id<T>> {
        self.raw.iter().map(Id::new)
    }
}
impl<T> FromIterator<Id<T>> for IdSet<T> {
    fn from_iter<I: IntoIterator<Item = Id<T>>>(ids: I) -> Self {
        Self {
            raw: ids.into_iter().map(Id::get).collect(),
            marker: PhantomData,
        }
    }
}
impl<T> Extend<Id<T>> for IdSet<T> {
    fn extend<I: IntoIterator<Item = Id<T>>>(&mut self, ids: I) {
        self.raw.extend(ids.into_iter().map(Id::get));
    }
}
impl<'a, T> IntoIterator for &'a IdSet<T> {
    type Item = Id<T>;
    type IntoIter = Map<Iter<'a>, fn(u32) -> Id<T>>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
macro_rules! set_op {
    ($trait:ident, $method:ident, $assign:ident, $assign_method:ident, $op:tt, $op_assign:tt) => {
        impl<T> $trait for &IdSet<T> {
            type Output = IdSet<T>;
            fn $method(self, rhs: Self) -> Self::Output {
                IdSet { raw: &self.raw $op &rhs.raw, marker: PhantomData }
            }
        }
        impl<T> $trait<&Self> for IdSet<T> {
            type Output = Self;
            fn $method(mut self, rhs: &Self) -> Self {
                self.raw $op_assign &rhs.raw;
                self
            }
        }
        impl<T> $trait for IdSet<T> {
            type Output = Self;
            fn $method(mut self, rhs: Self) -> Self {
                self.raw $op_assign rhs.raw;
                self
            }
        }
        impl<T> $assign<&Self> for IdSet<T> {
            fn $assign_method(&mut self, rhs: &Self) {
                self.raw $op_assign &rhs.raw;
            }
        }
        impl<T> $assign for IdSet<T> {
            fn $assign_method(&mut self, rhs: Self) {
                self.raw $op_assign rhs.raw;
            }
        }
    };
}
set_op!(BitOr, bitor, BitOrAssign, bitor_assign, |, |=);
set_op!(BitAnd, bitand, BitAndAssign, bitand_assign, &, &=);
set_op!(Sub, sub, SubAssign, sub_assign, -, -=);

#[cfg(test)]
#[path = "id_set.test.rs"]
mod tests;
