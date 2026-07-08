//! Conversion layer between [`Location`] structs and Arrow [`RecordBatch`]es.
//!
//! Every persistent location passes through this module on read and write.
//! The canonical column order and types are defined by [`location_schema`].

use std::sync::Arc;

use arrow_array::{
    builder::{GenericListBuilder, UInt32Builder},
    Array, ArrayRef, Float64Array, ListArray, RecordBatch,
    StringArray, UInt32Array, UInt8Array,
};
use arrow_schema::{DataType, Field, Schema};

use crate::types::{Location, LocationFlags};

// ---------------------------------------------------------------------------
// Column table
// ---------------------------------------------------------------------------

macro_rules! columns {
    ($( $idx:literal $const:ident $accessor:ident $name:literal $dtype:expr, $arrow_ty:ty, $nullable:literal );+ $(;)?) => {
        $( pub(crate) const $const: usize = $idx; )+

        $(
            pub(crate) fn $accessor(b: &RecordBatch) -> &$arrow_ty {
                b.column($const).as_any().downcast_ref().unwrap()
            }
        )+

        /// The canonical Arrow schema for location data. Column order is generated
        /// from the same table as the positional `COL_*` indices, so the two cannot
        /// desync. Metadata carries the format version stamp (see [`crate::arrow_migrate`]).
        pub fn location_schema() -> Schema {
            Schema::new_with_metadata(
                vec![ $( Field::new($name, $dtype, $nullable) ),+ ],
                crate::arrow_migrate::version_metadata(),
            )
        }
    };
}

// `tags` is a `List<UInt32>`; `pano_id`/`extra`/`modified_at` are nullable.
// TODO: extras-as-columns — promote known_field_keys to real typed columns
// (schema per-map), JSON only at import/export. Big project; kills the per-row
// JSON parse in filters/scans and the re-serialize cost in bake.
columns! {
    0  COL_ID          col_id          "id"          DataType::UInt32,  UInt32Array,  false;
    1  COL_LAT         col_lat         "lat"         DataType::Float64, Float64Array, false;
    2  COL_LNG         col_lng         "lng"         DataType::Float64, Float64Array, false;
    3  COL_HEADING     col_heading     "heading"     DataType::Float64, Float64Array, false;
    4  COL_PITCH       col_pitch       "pitch"       DataType::Float64, Float64Array, false;
    5  COL_ZOOM        col_zoom        "zoom"        DataType::Float64, Float64Array, false;
    6  COL_PANO_ID     col_pano_id     "pano_id"     DataType::Utf8,    StringArray,  true;
    7  COL_FLAGS       col_flags       "flags"       DataType::UInt32,  UInt32Array,  false;
    8  COL_TAGS        col_tags        "tags"        DataType::List(Arc::new(Field::new("item", DataType::UInt32, true))), ListArray, false;
    9  COL_EXTRA       col_extra       "extra"       DataType::Utf8,    StringArray,  true;
    10 COL_CREATED_AT  col_created_at  "created_at"  DataType::UInt32,  UInt32Array,  false;
    11 COL_MODIFIED_AT col_modified_at "modified_at" DataType::UInt32,  UInt32Array,  true;
}

/// Serialize a slice of [`Location`]s into a single Arrow [`RecordBatch`].
///
/// `extra` fields are JSON-stringified. Panics if the resulting columns don't
/// match [`location_schema`] (indicates a code bug, not a data problem).
pub fn locations_to_batch(locs: &[Location]) -> RecordBatch {
    let refs: Vec<&Location> = locs.iter().collect();
    locations_to_batch_refs(&refs)
}

/// Reference-based core: builds the batch from `&Location` pointers so callers can
/// stitch together rows from multiple sources (e.g. a delta's removed+created) without
/// deep-cloning every `Location` into one contiguous Vec.
fn locations_to_batch_refs(locs: &[&Location]) -> RecordBatch {
    let n = locs.len();

    let ids = UInt32Array::from_iter_values(locs.iter().map(|l| l.id));
    let lats = Float64Array::from_iter_values(locs.iter().map(|l| l.lat));
    let lngs = Float64Array::from_iter_values(locs.iter().map(|l| l.lng));
    let headings = Float64Array::from_iter_values(locs.iter().map(|l| l.heading));
    let pitches = Float64Array::from_iter_values(locs.iter().map(|l| l.pitch));
    let zooms = Float64Array::from_iter_values(locs.iter().map(|l| l.zoom));
    let pano_ids: StringArray = locs
        .iter()
        .map(|l| l.pano_id.as_deref())
        .collect();
    let flags = UInt32Array::from_iter_values(locs.iter().map(|l| l.flags.bits()));

    let mut tags_builder =
        GenericListBuilder::<i32, UInt32Builder>::with_capacity(UInt32Builder::new(), n);
    for loc in locs {
        let values = tags_builder.values();
        for &tag in &loc.tags {
            values.append_value(tag);
        }
        tags_builder.append(true);
    }
    let tags = tags_builder.finish();

    let extras: StringArray = locs
        .iter()
        .map(|l| l.extra.as_ref().map(|e| e.as_str().to_string()))
        .collect();

    let created_ats = UInt32Array::from_iter_values(locs.iter().map(|l| l.created_at));
    let modified_ats: UInt32Array = locs.iter().map(|l| l.modified_at).collect();

    let schema = Arc::new(location_schema());
    let columns: Vec<ArrayRef> = vec![
        Arc::new(ids),
        Arc::new(lats),
        Arc::new(lngs),
        Arc::new(headings),
        Arc::new(pitches),
        Arc::new(zooms),
        Arc::new(pano_ids),
        Arc::new(flags),
        Arc::new(tags),
        Arc::new(extras),
        Arc::new(created_ats),
        Arc::new(modified_ats),
    ];

    RecordBatch::try_new(schema, columns).expect("schema matches columns")
}

/// Apply `patches` (id -> new Location) to a batch column-wise: only columns a
/// patch actually changed are rebuilt; untouched columns are reused via Arc clone.
/// Row order is preserved (sorted id invariant). Patch ids absent from the batch
/// are ignored.
pub fn patch_batch(batch: &RecordBatch, patches: &std::collections::HashMap<u32, Location>) -> RecordBatch {
    let n = batch.num_rows();
    let ids = col_id(batch);
    let hits: std::collections::HashMap<usize, &Location> = (0..n)
        .filter_map(|i| patches.get(&ids.value(i)).map(|p| (i, p)))
        .collect();
    if hits.is_empty() {
        return batch.clone();
    }

    let mut touched = [false; 12];
    for (&i, p) in &hits {
        let old = row_to_location(batch, i);
        touched[COL_LAT] |= old.lat != p.lat;
        touched[COL_LNG] |= old.lng != p.lng;
        touched[COL_HEADING] |= old.heading != p.heading;
        touched[COL_PITCH] |= old.pitch != p.pitch;
        touched[COL_ZOOM] |= old.zoom != p.zoom;
        touched[COL_PANO_ID] |= old.pano_id != p.pano_id;
        touched[COL_FLAGS] |= old.flags != p.flags;
        touched[COL_TAGS] |= old.tags != p.tags;
        touched[COL_EXTRA] |= old.extra != p.extra;
        touched[COL_CREATED_AT] |= old.created_at != p.created_at;
        touched[COL_MODIFIED_AT] |= old.modified_at != p.modified_at;
    }

    let f64_col = |getter: fn(&RecordBatch) -> &Float64Array, pick: fn(&Location) -> f64| -> ArrayRef {
        let old = getter(batch);
        Arc::new(Float64Array::from_iter_values(
            (0..n).map(|i| hits.get(&i).map_or_else(|| old.value(i), |p| pick(p))),
        ))
    };

    let columns: Vec<ArrayRef> = batch
        .columns()
        .iter()
        .enumerate()
        .map(|(ci, col)| {
            if !touched[ci] {
                return col.clone();
            }
            match ci {
                COL_LAT => f64_col(col_lat, |p| p.lat),
                COL_LNG => f64_col(col_lng, |p| p.lng),
                COL_HEADING => f64_col(col_heading, |p| p.heading),
                COL_PITCH => f64_col(col_pitch, |p| p.pitch),
                COL_ZOOM => f64_col(col_zoom, |p| p.zoom),
                COL_PANO_ID => {
                    let old = col_pano_id(batch);
                    Arc::new((0..n).map(|i| match hits.get(&i) {
                        Some(p) => p.pano_id.clone(),
                        None => (!old.is_null(i)).then(|| old.value(i).to_string()),
                    }).collect::<StringArray>())
                }
                COL_FLAGS => {
                    let old = col_flags(batch);
                    Arc::new(UInt32Array::from_iter_values(
                        (0..n).map(|i| hits.get(&i).map_or_else(|| old.value(i), |p| p.flags.bits())),
                    ))
                }
                COL_TAGS => {
                    let old = col_tags(batch);
                    let mut b = GenericListBuilder::<i32, UInt32Builder>::with_capacity(UInt32Builder::new(), n);
                    for i in 0..n {
                        match hits.get(&i) {
                            Some(p) => {
                                for &t in &p.tags {
                                    b.values().append_value(t);
                                }
                            }
                            None => {
                                let v = old.value(i);
                                let u = v.as_any().downcast_ref::<UInt32Array>().unwrap();
                                for j in 0..u.len() {
                                    b.values().append_value(u.value(j));
                                }
                            }
                        }
                        b.append(true);
                    }
                    Arc::new(b.finish())
                }
                COL_EXTRA => {
                    let old = col_extra(batch);
                    Arc::new((0..n).map(|i| match hits.get(&i) {
                        Some(p) => p.extra.as_ref().map(|e| e.as_str().to_string()),
                        None => (!old.is_null(i)).then(|| old.value(i).to_string()),
                    }).collect::<StringArray>())
                }
                COL_CREATED_AT => {
                    let old = col_created_at(batch);
                    Arc::new(UInt32Array::from_iter_values(
                        (0..n).map(|i| hits.get(&i).map_or_else(|| old.value(i), |p| p.created_at)),
                    ))
                }
                COL_MODIFIED_AT => {
                    let old = col_modified_at(batch);
                    Arc::new((0..n).map(|i| match hits.get(&i) {
                        Some(p) => p.modified_at,
                        None => (!old.is_null(i)).then(|| old.value(i)),
                    }).collect::<UInt32Array>())
                }
                _ => col.clone(),
            }
        })
        .collect();

    RecordBatch::try_new(batch.schema(), columns).expect("schema matches columns")
}

/// Extract a single [`Location`] from row `idx` of a batch.
///
/// Accesses columns by positional index (must match [`location_schema`] order).
/// Nullable `extra` is deserialized from its JSON string; malformed JSON yields `None`.
pub fn row_to_location(batch: &RecordBatch, idx: usize) -> Location {
    let pano_id_col = col_pano_id(batch);
    let pano_id = if pano_id_col.is_null(idx) {
        None
    } else {
        Some(pano_id_col.value(idx).to_string())
    };

    let tags_arr = col_tags(batch).value(idx);
    let tags_u32 = tags_arr.as_any().downcast_ref::<UInt32Array>().unwrap();
    let tags: Vec<u32> = (0..tags_u32.len()).map(|i| tags_u32.value(i)).collect();

    let extra_col = col_extra(batch);
    let extra = if extra_col.is_null(idx) {
        None
    } else {
        crate::types::RawExtra::from_string(extra_col.value(idx).to_owned())
    };

    let modified_at = {
        let col = col_modified_at(batch);
        if col.is_null(idx) { None } else { Some(col.value(idx)) }
    };

    Location {
        id: col_id(batch).value(idx),
        lat: col_lat(batch).value(idx),
        lng: col_lng(batch).value(idx),
        heading: col_heading(batch).value(idx),
        pitch: col_pitch(batch).value(idx),
        zoom: col_zoom(batch).value(idx),
        pano_id,
        flags: LocationFlags::from_bits_retain(col_flags(batch).value(idx)),
        tags,
        extra,
        created_at: col_created_at(batch).value(idx),
        modified_at,
    }
}

/// Materialize every row of a batch into a `Vec<Location>`.
pub fn batch_to_locations(batch: &RecordBatch) -> Vec<Location> {
    (0..batch.num_rows()).map(|i| row_to_location(batch, i)).collect()
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
    let mut fields: Vec<arrow_schema::FieldRef> = location_schema().fields().iter().cloned().collect();
    fields.push(Arc::new(Field::new("op", DataType::UInt8, false)));
    Schema::new_with_metadata(fields, crate::arrow_migrate::version_metadata())
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
    let ops = if batch.num_columns() > COL_MODIFIED_AT + 1 {
        batch.column(COL_MODIFIED_AT + 1).as_any().downcast_ref::<UInt8Array>()
    } else {
        None
    };
    let mut created = Vec::new();
    let mut removed = Vec::new();
    for i in 0..batch.num_rows() {
        let loc = row_to_location(batch, i);
        match ops.map(|a| a.value(i)).unwrap_or(OP_CREATED) {
            OP_REMOVED => removed.push(loc),
            _ => created.push(loc),
        }
    }
    (created, removed)
}

#[cfg(test)]
#[path = "arrow_bridge.test.rs"]
mod tests;
