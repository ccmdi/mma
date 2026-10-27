//! Schema-derived column projections and dynamically named field projections.

use super::{index_keys, RowRef};
use crate::store::arrow::Column;
use crate::store::engine::ValueRecord;
use crate::store::index::{Choice, Contributions, Index, Projection};
use crate::store::maps::IndexShape;
use crate::types::{Location, LocationFlags, RawExtra};
use compact_str::CompactString;
use mma_algebra::Id;
use std::collections::HashMap;
use std::hash::Hash;

/// A field name and the keys its declared type contributes. Built-in and JSON fields use
/// the same projection after the row's field reader resolves their value.
pub(crate) struct FieldProjection {
    pub field: String,
    pub shape: IndexShape,
}

impl Projection<serde_json::Value> for FieldProjection {
    type Key = String;

    fn project(&self, value: &serde_json::Value, mut emit: impl FnMut(String)) -> bool {
        if value.is_null() {
            return false;
        }
        for key in index_keys(self.shape, value) {
            emit(key);
        }
        true
    }
}

impl Projection<RowRef<'_, '_>> for FieldProjection {
    type Key = String;

    fn project(&self, row: &RowRef<'_, '_>, emit: impl FnMut(String)) -> bool {
        row.resolve_field(&self.field)
            .is_some_and(|value| self.project(&value, emit))
    }
}

impl Projection<Location> for FieldProjection {
    type Key = String;

    fn project(&self, row: &Location, emit: impl FnMut(String)) -> bool {
        self.project(&RowRef::from_loc(row), emit)
    }
}

/// Store-owned field indexes; operation-local indexes use the same generic `Index`.
pub(crate) type FieldIndex = Index<String, Location, FieldProjection>;
pub(crate) type FieldIndexes = HashMap<String, FieldIndex>;
pub(crate) type FieldContributions = Contributions<String, Location>;

/// A typed reader generated from a real `Location` column, shared by borrowed and owned rows.
pub(crate) struct ColumnProjection<T: Column> {
    read: for<'r, 'a, 'v> fn(&'r RowRef<'a, 'v>) -> T::Cell<'r>,
}

/// A column's equality keys. Floating point keys use exact bits with signed zero normalized.
pub(crate) trait KeyColumn: Column {
    type Key: Clone + Eq + Hash + Ord;
    fn project(cell: Self::Cell<'_>, emit: impl FnMut(Self::Key)) -> bool;
}

impl KeyColumn for f64 {
    type Key = u64;
    fn project(cell: f64, mut emit: impl FnMut(u64)) -> bool {
        emit((cell + 0.0).to_bits());
        true
    }
}

impl KeyColumn for Option<CompactString> {
    type Key = String;
    fn project(cell: Option<&str>, mut emit: impl FnMut(String)) -> bool {
        match cell.filter(|value| !value.is_empty()) {
            Some(value) => {
                emit(value.to_owned());
                true
            }
            None => false,
        }
    }
}

impl<T: 'static> KeyColumn for Vec<Id<T>> {
    type Key = Id<T>;
    fn project(cell: &[Id<T>], mut emit: impl FnMut(Id<T>)) -> bool {
        for &id in cell {
            emit(id);
        }
        !cell.is_empty()
    }
}

impl<T: KeyColumn> Projection<RowRef<'_, '_>> for ColumnProjection<T> {
    type Key = T::Key;
    fn project(&self, row: &RowRef<'_, '_>, emit: impl FnMut(T::Key)) -> bool {
        T::project((self.read)(row), emit)
    }
}

impl<T: KeyColumn> Projection<Location> for ColumnProjection<T> {
    type Key = T::Key;
    fn project(&self, row: &Location, emit: impl FnMut(T::Key)) -> bool {
        self.project(&RowRef::from_loc(row), emit)
    }
}

macro_rules! column_projections {
    ($({ $idx:literal, $field:ident, $ty:ty }),* $(,)?) => {
        #[allow(dead_code, reason = "typed projections follow every declared column")]
        pub(crate) struct LocationFields {
            $(pub $field: ColumnProjection<$ty>,)*
        }

        impl Location {
            pub(crate) fn fields() -> LocationFields {
                LocationFields {
                    $($field: ColumnProjection { read: |row| row.$field() },)*
                }
            }
        }
    };
}

crate::types::location_columns!(column_projections);

pub(crate) type LocationIdentity =
    Choice<ColumnProjection<Option<CompactString>>, (ColumnProjection<f64>, ColumnProjection<f64>)>;

impl Location {
    /// Recognize an existing location by non-empty pano id, otherwise by exact coordinates.
    /// Index both alternatives; `preferred()` selects the incoming location's lookup key.
    pub(crate) fn identity() -> LocationIdentity {
        let fields = Self::fields();
        Choice(fields.pano_id, (fields.lat, fields.lng))
    }
}

#[cfg(test)]
#[path = "projection.test.rs"]
mod tests;
