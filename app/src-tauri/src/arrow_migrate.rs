//! Versioned forward-migration for Arrow location batches read from disk.
//!
//! Every persisted Arrow file (base snapshots, the working delta, and per-commit
//! VCS deltas) carries a schema-metadata version stamp under [`VERSION_KEY`].
//! Files written before versioning existed have no stamp and are treated as v1.
//!
//! [`migrate`] runs the registered `vN -> vN+1` steps in order until the batch
//! reaches [`CURRENT_VERSION`]. It is applied in the read chokepoints
//! (`storage::read_arrow_ipc` / `read_arrow_ipc_mmap`) so every loaded batch is
//! normalized to the current schema before any `concat_batches` or column access.
//!
//! Steps operate by column *name*, so the same step handles both the base schema
//! and the delta schema (which appends a trailing `op` column).

use crate::types::{AppError, AppResult};
use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{Array, ArrayRef, RecordBatch, StringArray, UInt32Array};
use arrow_schema::{DataType, Field, Schema};

/// Schema-metadata key holding the on-disk format version (decimal string).
pub const VERSION_KEY: &str = "mma_version";

/// The version every freshly written batch is stamped with. Bump this and add a
/// `(old, step)` entry to [`MIGRATIONS`] whenever the persisted schema changes.
pub const CURRENT_VERSION: u32 = 2;

/// Schema metadata stamping a batch as [`CURRENT_VERSION`]. Used by
/// `location_schema`/`delta_schema` so all new writes are versioned.
pub fn version_metadata() -> HashMap<String, String> {
    HashMap::from([(VERSION_KEY.to_string(), CURRENT_VERSION.to_string())])
}

/// Read the format version from a schema's metadata. Absent/unparseable = v1.
pub fn batch_version(metadata: &HashMap<String, String>) -> u32 {
    metadata
        .get(VERSION_KEY)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
}

type MigrationStep = fn(RecordBatch) -> AppResult<RecordBatch>;

/// Ordered `(from_version, step)` registry. Each step migrates `from_version` ->
/// `from_version + 1`. Steps must be contiguous and end at `CURRENT_VERSION - 1`.
const MIGRATIONS: &[(u32, MigrationStep)] = &[(1, v1_to_v2_timestamps)];

/// Bring a batch up to [`CURRENT_VERSION`], applying each registered step in order.
/// A no-op for batches already at (or beyond) the current version.
pub fn migrate(batch: RecordBatch) -> AppResult<RecordBatch> {
    let mut version = batch_version(batch.schema().metadata());
    if version >= CURRENT_VERSION {
        return Ok(batch);
    }
    let mut batch = batch;
    while version < CURRENT_VERSION {
        let step = MIGRATIONS
            .iter()
            .find(|(from, _)| *from == version)
            .map(|(_, step)| step)
            .ok_or_else(|| format!("no migration registered from v{version}"))?;
        log::info!("[arrow_migrate] v{version} -> v{}", version + 1);
        batch = step(batch)?;
        version += 1;
    }
    Ok(batch)
}

/// v1 -> v2: `created_at`/`modified_at` columns change from ISO-string `Utf8`
/// to `UInt32` epoch seconds. Non-nullable columns fall back to 0 on parse
/// failure (the schema forbids nulls there).
fn v1_to_v2_timestamps(batch: RecordBatch) -> AppResult<RecordBatch> {
    let schema = batch.schema();
    let mut fields: Vec<Arc<Field>> = Vec::with_capacity(schema.fields().len());
    let mut columns: Vec<ArrayRef> = Vec::with_capacity(batch.num_columns());

    for (i, field) in schema.fields().iter().enumerate() {
        let col = batch.column(i);
        if field.name() == "created_at" || field.name() == "modified_at" {
            let strs = col
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| format!("v1->v2: column `{}` is not Utf8", field.name()))?;
            let nullable = field.is_nullable();
            let converted: UInt32Array = strs
                .iter()
                .map(|opt| {
                    let secs = opt.and_then(crate::util::iso_to_unix).map(|s| s as u32);
                    if nullable {
                        secs
                    } else {
                        Some(secs.unwrap_or(0))
                    }
                })
                .collect();
            fields.push(Arc::new(Field::new(
                field.name(),
                DataType::UInt32,
                nullable,
            )));
            columns.push(Arc::new(converted) as ArrayRef);
        } else {
            fields.push(field.clone());
            columns.push(col.clone());
        }
    }

    let schema = Arc::new(Schema::new_with_metadata(fields, version_metadata()));
    RecordBatch::try_new(schema, columns).map_err(AppError::from)
}

#[cfg(test)]
#[path = "arrow_migrate.test.rs"]
mod tests;
