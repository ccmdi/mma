//! Conversion layer between [`Location`] structs and Arrow [`RecordBatch`]es.
//!
//! Every persistent location passes through this module on read and write.
//! The canonical column order and types follow `Location`'s fields; see [`Column`].

use std::sync::Arc;

pub(crate) mod io;
pub(crate) mod migrate;
pub(crate) use io::*;

use crate::types::RawExtra;
use arrow_array::{
    builder::{GenericListBuilder, UInt32Builder},
    Array, ArrayRef, Float64Array, ListArray, RecordBatch, StringArray, UInt32Array, UInt8Array,
};
use arrow_schema::SchemaRef;
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;

use crate::types::{Location, LocationFlags};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/// How one `Location` field is stored as an Arrow column. `Cell` is a value as it can be
/// read in place, from the field or from a row of the column, so building, reading back
/// and comparing never copy more than the column needs.
pub(crate) trait Column {
    type Array: Array + 'static;
    type Cell<'c>: PartialEq
    where
        Self: 'c;
    const NULLABLE: bool;
    fn data_type() -> DataType;
    fn cell(&self) -> Self::Cell<'_>;
    fn cell_at(col: &Self::Array, i: usize) -> Self::Cell<'_>;
    fn own(cell: Self::Cell<'_>) -> Self;
    fn build<'c>(cells: impl Iterator<Item = Self::Cell<'c>>, n: usize) -> ArrayRef
    where
        Self: 'c;
}

macro_rules! primitive_column {
    ($ty:ty, $array:ty, $data_type:expr) => {
        impl Column for $ty {
            type Array = $array;
            type Cell<'c> = $ty;
            const NULLABLE: bool = false;
            fn data_type() -> DataType {
                $data_type
            }
            fn cell(&self) -> $ty {
                *self
            }
            fn cell_at(col: &$array, i: usize) -> $ty {
                col.value(i)
            }
            fn own(cell: $ty) -> $ty {
                cell
            }
            fn build<'c>(cells: impl Iterator<Item = $ty>, _: usize) -> ArrayRef
            where
                Self: 'c,
            {
                Arc::new(<$array>::from_iter_values(cells))
            }
        }
    };
}

primitive_column!(f64, Float64Array, DataType::Float64);
primitive_column!(u32, UInt32Array, DataType::UInt32);

impl Column for Option<u32> {
    type Array = UInt32Array;
    type Cell<'c> = Option<u32>;
    const NULLABLE: bool = true;
    fn data_type() -> DataType {
        DataType::UInt32
    }
    fn cell(&self) -> Option<u32> {
        *self
    }
    fn cell_at(col: &UInt32Array, i: usize) -> Option<u32> {
        (!col.is_null(i)).then(|| col.value(i))
    }
    fn own(cell: Option<u32>) -> Option<u32> {
        cell
    }
    fn build<'c>(cells: impl Iterator<Item = Option<u32>>, _: usize) -> ArrayRef
    where
        Self: 'c,
    {
        Arc::new(cells.collect::<UInt32Array>())
    }
}

impl Column for LocationFlags {
    type Array = UInt32Array;
    type Cell<'c> = LocationFlags;
    const NULLABLE: bool = false;
    fn data_type() -> DataType {
        DataType::UInt32
    }
    fn cell(&self) -> LocationFlags {
        *self
    }
    fn cell_at(col: &UInt32Array, i: usize) -> LocationFlags {
        LocationFlags::from_bits_retain(col.value(i))
    }
    fn own(cell: LocationFlags) -> Self {
        cell
    }
    fn build<'c>(cells: impl Iterator<Item = LocationFlags>, _: usize) -> ArrayRef
    where
        Self: 'c,
    {
        Arc::new(UInt32Array::from_iter_values(cells.map(|f| f.bits())))
    }
}

impl Column for Option<compact_str::CompactString> {
    type Array = StringArray;
    type Cell<'c> = Option<&'c str>;
    const NULLABLE: bool = true;
    fn data_type() -> DataType {
        DataType::Utf8
    }
    fn cell(&self) -> Option<&str> {
        self.as_deref()
    }
    fn cell_at(col: &StringArray, i: usize) -> Option<&str> {
        (!col.is_null(i)).then(|| col.value(i))
    }
    fn own(cell: Option<&str>) -> Self {
        cell.map(Into::into)
    }
    fn build<'c>(cells: impl Iterator<Item = Option<&'c str>>, _: usize) -> ArrayRef
    where
        Self: 'c,
    {
        Arc::new(cells.collect::<StringArray>())
    }
}

impl Column for Vec<u32> {
    type Array = ListArray;
    type Cell<'c> = &'c [u32];
    const NULLABLE: bool = false;
    fn data_type() -> DataType {
        DataType::List(Arc::new(Field::new("item", DataType::UInt32, true)))
    }
    fn cell(&self) -> &[u32] {
        self
    }
    fn cell_at(col: &ListArray, i: usize) -> &[u32] {
        let values = col
            .values()
            .as_any()
            .downcast_ref::<UInt32Array>()
            .unwrap()
            .values();
        let offsets = col.value_offsets();
        &values[offsets[i] as usize..offsets[i + 1] as usize]
    }
    fn own(cell: &[u32]) -> Self {
        cell.to_vec()
    }
    fn build<'c>(cells: impl Iterator<Item = &'c [u32]>, n: usize) -> ArrayRef
    where
        Self: 'c,
    {
        let mut b =
            GenericListBuilder::<i32, UInt32Builder>::with_capacity(UInt32Builder::new(), n);
        for cell in cells {
            b.values().append_slice(cell);
            b.append(true);
        }
        Arc::new(b.finish())
    }
}

/// A stored `extra` document, raw. Two are equal when their text is, or when they parse to
/// the same document: a stored row whose keys were escaped, or whose text does not parse,
/// is unchanged by a patch that reads it back.
#[derive(Clone, Copy)]
pub(crate) struct ExtraCell<'c>(pub(crate) Option<&'c str>);

impl PartialEq for ExtraCell<'_> {
    fn eq(&self, other: &Self) -> bool {
        let parse = |s: Option<&str>| s.and_then(|s| RawExtra::from_string(s.to_owned()));
        self.0 == other.0 || parse(self.0) == parse(other.0)
    }
}

impl Column for Option<RawExtra> {
    type Array = StringArray;
    type Cell<'c> = ExtraCell<'c>;
    const NULLABLE: bool = true;
    fn data_type() -> DataType {
        DataType::Utf8
    }
    fn cell(&self) -> ExtraCell<'_> {
        ExtraCell(self.as_ref().map(RawExtra::as_str))
    }
    fn cell_at(col: &StringArray, i: usize) -> ExtraCell<'_> {
        ExtraCell((!col.is_null(i)).then(|| col.value(i)))
    }
    fn own(cell: ExtraCell<'_>) -> Self {
        cell.0.and_then(|s| RawExtra::from_string(s.to_owned()))
    }
    fn build<'c>(cells: impl Iterator<Item = ExtraCell<'c>>, _: usize) -> ArrayRef
    where
        Self: 'c,
    {
        Arc::new(cells.map(|c| c.0).collect::<StringArray>())
    }
}

// One column per `Location` field, in declaration order (`#[derive(Fields)]`).
macro_rules! columns {
    ($({ $idx:literal, $f:ident, $ty:ty }),* $(,)?) => {
        /// Every `Location` column of a batch, each downcast to its array type once.
        /// `Columns::<field>(batch)` reads one column alone.
        #[derive(Clone, Copy)]
        pub(crate) struct Columns<'a> {
            $(pub(crate) $f: &'a <$ty as Column>::Array,)*
        }

        #[allow(dead_code, reason = "one reader per column, generated whether or not it is called")]
        impl<'a> Columns<'a> {
            pub(crate) fn of(batch: &'a RecordBatch) -> Self {
                Self { $($f: Self::$f(batch),)* }
            }

            /// Row `i` as a [`Location`].
            pub(crate) fn location(&self, i: usize) -> Location {
                Location {
                    $($f: <$ty as Column>::own(<$ty as Column>::cell_at(self.$f, i)),)*
                }
            }

            /// The row holding `id`: ids are strictly ascending, so this is a binary search.
            pub(crate) fn row_of(&self, id: u32) -> Option<usize> {
                self.id.values().binary_search(&id).ok()
            }

            $(
                pub(crate) fn $f(batch: &'a RecordBatch) -> &'a <$ty as Column>::Array {
                    batch
                        .column($idx)
                        .as_any()
                        .downcast_ref()
                        .expect(concat!("the ", stringify!($f), " column"))
                }
            )*
        }

        /// How many columns a location batch has.
        pub(crate) const COLUMN_COUNT: usize = [$($idx),*].len();

        /// The canonical Arrow schema for location data. Metadata carries the format
        /// version stamp (see [`crate::store::arrow::migrate`]).
        pub fn location_schema() -> Schema {
            Schema::new_with_metadata(
                vec![$(Field::new(stringify!($f), <$ty as Column>::data_type(), <$ty as Column>::NULLABLE)),*],
                crate::store::arrow::migrate::version_metadata(),
            )
        }

        /// Reference-based core: builds the batch from `&Location` pointers so callers can
        /// stitch together rows from multiple sources (e.g. a delta's removed+created)
        /// without deep-cloning every `Location` into one contiguous Vec.
        fn locations_to_batch_refs(locs: &[&Location]) -> RecordBatch {
            let n = locs.len();
            let columns: Vec<ArrayRef> = vec![
                $(<$ty as Column>::build(locs.iter().map(|l| l.$f.cell()), n)),*
            ];
            RecordBatch::try_new(Arc::new(location_schema()), columns).expect("schema matches columns")
        }

        /// Apply `patches` (id -> new Location) to a batch column-wise: only columns a
        /// patch actually changed are rebuilt; untouched columns are reused via Arc clone.
        /// Row order is preserved (sorted id invariant). Patch ids absent from the batch
        /// are ignored.
        pub fn patch_batch(batch: &RecordBatch, patches: &HashMap<u32, Location>) -> RecordBatch {
            let n = batch.num_rows();
            let cols = Columns::of(batch);
            let hits: HashMap<usize, &Location> = (0..n)
                .filter_map(|i| patches.get(&cols.id.value(i)).map(|p| (i, p)))
                .collect();
            if hits.is_empty() {
                return batch.clone();
            }
            let columns: Vec<ArrayRef> = vec![$({
                let col = cols.$f;
                let touched = hits
                    .iter()
                    .any(|(&i, p)| <$ty as Column>::cell_at(col, i) != p.$f.cell());
                if touched {
                    <$ty as Column>::build(
                        (0..n).map(|i| match hits.get(&i) {
                            Some(p) => p.$f.cell(),
                            None => <$ty as Column>::cell_at(col, i),
                        }),
                        n,
                    )
                } else {
                    batch.column($idx).clone()
                }
            }),*];
            RecordBatch::try_new(batch.schema(), columns).expect("schema matches columns")
        }

    };
}

crate::types::location_columns!(columns);

/// Serialize a slice of [`Location`]s into a single Arrow [`RecordBatch`].
///
/// `extra` fields are JSON-stringified. Panics if the resulting columns don't
/// match [`location_schema`] (indicates a code bug, not a data problem).
pub fn locations_to_batch(locs: &[Location]) -> RecordBatch {
    let refs: Vec<&Location> = locs.iter().collect();
    locations_to_batch_refs(&refs)
}

/// Materialize every row of a batch into a `Vec<Location>`.
pub fn batch_to_locations(batch: &RecordBatch) -> Vec<Location> {
    let cols = Columns::of(batch);
    (0..batch.num_rows()).map(|i| cols.location(i)).collect()
}

// ---------------------------------------------------------------------------
// VCS delta batches
// ---------------------------------------------------------------------------

/// `op` column code for a location removed by a commit.
pub const OP_REMOVED: u8 = 0;
/// `op` column code for a location created (or updated) by a commit.
pub const OP_CREATED: u8 = 1;

/// Schema for a VCS delta file: the location columns plus a trailing `op` column
/// (`OP_REMOVED`/`OP_CREATED`) distinguishing the two sides of the delta.
pub fn delta_schema() -> Schema {
    let mut fields: Vec<arrow_schema::FieldRef> =
        location_schema().fields().iter().cloned().collect();
    fields.push(Arc::new(Field::new("op", DataType::UInt8, false)));
    Schema::new_with_metadata(fields, migrate::version_metadata())
}

/// Serialize a commit delta (`created` + `removed` locations) into one delta batch.
/// Removed rows come first, then created; the `op` column tags each.
pub fn delta_to_batch(created: &[Location], removed: &[Location]) -> RecordBatch {
    // Stitch removed++created by reference — no deep clone of the location set.
    let refs: Vec<&Location> = removed.iter().chain(created.iter()).collect();

    let base = locations_to_batch_refs(&refs);
    let mut ops: Vec<u8> = Vec::with_capacity(refs.len());
    ops.resize(removed.len(), OP_REMOVED);
    ops.resize(removed.len() + created.len(), OP_CREATED);

    let mut columns: Vec<ArrayRef> = base.columns().to_vec();
    columns.push(Arc::new(UInt8Array::from(ops)));
    RecordBatch::try_new(Arc::new(delta_schema()), columns).expect("delta schema matches columns")
}

/// Split a delta batch back into `(created, removed)` location vectors.
///
/// Two on-disk forms are accepted: a true delta carries a 13th `op` column
/// (`OP_CREATED`/`OP_REMOVED`); a genesis **snapshot** is stored in the plain
/// 12-column base format (no `op`) and every row is treated as created. The latter
/// lets a genesis commit reuse the base file instead of re-serializing it.
pub fn batch_to_delta(batch: &RecordBatch) -> (Vec<Location>, Vec<Location>) {
    let ops = if batch.num_columns() > COLUMN_COUNT {
        batch
            .column(COLUMN_COUNT)
            .as_any()
            .downcast_ref::<UInt8Array>()
    } else {
        None
    };
    let cols = Columns::of(batch);
    let mut created = Vec::new();
    let mut removed = Vec::new();
    for i in 0..batch.num_rows() {
        let loc = cols.location(i);
        match ops.map(|a| a.value(i)).unwrap_or(OP_CREATED) {
            OP_REMOVED => removed.push(loc),
            _ => created.push(loc),
        }
    }
    (created, removed)
}

#[cfg(test)]
#[path = "arrow.test.rs"]
mod tests;

pub(crate) fn schema() -> SchemaRef {
    Arc::new(location_schema())
}

#[allow(dead_code, reason = "exercised by tests; no production caller")]
pub(crate) fn empty_batch() -> RecordBatch {
    RecordBatch::new_empty(schema())
}
