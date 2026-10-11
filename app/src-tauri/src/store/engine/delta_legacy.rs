//! One-time conversion of msgpack `.delta` sidecars to the Arrow commit-delta format.
//!
//! Self-contained and disposable: nothing outside this file knows the msgpack shape, and
//! the app reaches in only through [`convert_msgpack_deltas`], called once at startup,
//! [`warn_of_set_aside_deltas`], called once the first window is ready, and
//! [`convert_msgpack_delta`], called as a map opens.
//! When every install has upgraded, delete this file, its test file, its `mod delta_legacy;`
//! line in `engine.rs`, both calls in `lib.rs`, the call in `open_claimed_map`, the
//! `rmp-serde` dependency, and the non-human-readable branches of `RawExtra`'s serde impls
//! -- nothing else refers to any of it.

use super::{set_aside_delta, Overlay, StoreWarning};
use crate::store::arrow;
use crate::store::storage;
use crate::types::{AppError, AppResult, Location};
use mma_algebra::Id;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// A sidecar was set aside at startup, before any window listened for the warning.
static SET_ASIDE: AtomicBool = AtomicBool::new(false);

/// The msgpack sidecar: the overlay with its dead ids and patches as plain lists.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
struct MsgpackDelta {
    adds: Vec<Location>,
    dead_ids: Vec<Id<Location>>,
    patches: Vec<Location>,
}

/// Rewrite every map's msgpack sidecar as an Arrow delta.
pub(crate) fn convert_msgpack_deltas() {
    let map_ids = storage::open_db().and_then(|conn| {
        conn.prepare("SELECT id FROM maps")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)
    });
    let map_ids = match map_ids {
        Ok(ids) => ids,
        Err(e) => {
            log::error!("[delta_legacy] could not list maps: {e}");
            return;
        }
    };
    for id in map_ids {
        match (storage::arrow_delta_path(&id), storage::arrow_path(&id)) {
            (Ok(delta), Ok(base)) => match convert_msgpack_delta(&delta, &base) {
                Ok(set_aside) => {
                    if set_aside {
                        SET_ASIDE.store(true, Ordering::Relaxed);
                    }
                }
                Err(e) => log::error!("[delta_legacy] {e}"),
            },
            (Err(e), _) | (_, Err(e)) => log::error!("[delta_legacy] {id}: {e}"),
        }
    }
}

/// Warn of any sidecar startup set aside, now that a window listens.
pub(crate) fn warn_of_set_aside_deltas() {
    if SET_ASIDE.swap(false, Ordering::Relaxed) {
        crate::emit_event(StoreWarning::DeltaSetAside);
    }
}

/// Rewrite one msgpack sidecar as an Arrow delta against `base_path`. Only a sidecar that
/// does not decode is set aside; returns whether it was. Anything else that fails (reading
/// it, reading its base, writing the result) leaves it as it is and is the error: the delta
/// itself is fine, so the map must not open without it.
pub(crate) fn convert_msgpack_delta(delta_path: &Path, base_path: &Path) -> AppResult<bool> {
    if !delta_path.exists() || is_arrow(delta_path) {
        return Ok(false);
    }
    let left = |e: AppError| AppError(format!("left {delta_path:?} as msgpack: {e}"));
    let bytes = fs::read(delta_path).map_err(|e| left(e.into()))?;
    let old = match rmp_serde::from_slice::<MsgpackDelta>(&bytes) {
        Ok(old) => old,
        Err(e) => {
            set_aside_delta(delta_path, &AppError::from(e.to_string()));
            return Ok(true);
        }
    };
    write_converted(delta_path, base_path, old).map_err(left)?;
    log::info!("[delta_legacy] converted {delta_path:?}");
    Ok(false)
}

fn is_arrow(path: &Path) -> bool {
    let mut magic = [0u8; 6];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok_and(|()| &magic == b"ARROW1")
}

fn write_converted(delta_path: &Path, base_path: &Path, old: MsgpackDelta) -> AppResult<()> {
    let base = if base_path.exists() {
        Some(arrow::read_arrow_ipc(base_path)?)
    } else {
        None
    };
    let overlay = Overlay {
        adds: old.adds,
        dead: old.dead_ids.into_iter().collect(),
        patches: old.patches.into_iter().map(|l| (l.id, l)).collect(),
    };
    arrow::write_arrow_ipc(delta_path, &overlay.to_delta(base.as_ref()))
}

#[cfg(test)]
#[path = "delta_legacy.test.rs"]
mod tests;
