//! In-memory spatial index over the alive location set: a fixed-cell hash grid for
//! meter-scale radius queries (find-nearby, dedupe, "anything already here?").
//! Owned by `Store`, built lazily on the first spatial query, and maintained
//! incrementally by the overlay mutation functions — O(delta) per mutation,
//! O(min(cells in radius, occupied cells)) per query, instead of the O(N) scan per
//! query it replaces.
//!
//! Cells are keyed by floored lat/lng degree coordinates. Removal derives the cell
//! from the coordinates the caller supplies (the location's current state), so no
//! id→cell reverse map is needed; a full-scan fallback guards against drift.

use std::collections::HashMap;

/// ~25m cells: 1-100m queries walk a handful of cells; a 1km query walks ~80x80.
/// Longitude cells narrow toward the poles, which only means more (empty) cells
/// walked there — correctness always comes from the caller's distance test.
const CELL_DEG: f64 = 25.0 / mma_geo::M_PER_DEG;

#[inline]
fn cell_for(lat: f64, lng: f64) -> (i32, i32) {
    (
        (lng / CELL_DEG).floor() as i32,
        (lat / CELL_DEG).floor() as i32,
    )
}

pub(crate) struct SpatialIndex {
    cells: HashMap<(i32, i32), Vec<u32>>,
    len: usize,
}

impl SpatialIndex {
    pub(crate) fn new() -> Self {
        SpatialIndex {
            cells: HashMap::new(),
            len: 0,
        }
    }

    /// Number of indexed points. Compared against `alive_count` as a drift check.
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn insert(&mut self, id: u32, lat: f64, lng: f64) {
        if !lat.is_finite() || !lng.is_finite() {
            return;
        }
        self.cells.entry(cell_for(lat, lng)).or_default().push(id);
        self.len += 1;
    }

    /// Remove `id`, deriving its cell from the coordinates it was indexed under.
    /// If the coords don't locate it (a caller passed stale state), fall back to a
    /// full scan so the index never silently keeps a dead entry.
    pub(crate) fn remove(&mut self, id: u32, lat: f64, lng: f64) {
        let key = cell_for(lat, lng);
        if let Some(v) = self.cells.get_mut(&key) {
            if let Some(pos) = v.iter().position(|&x| x == id) {
                v.swap_remove(pos);
                if v.is_empty() {
                    self.cells.remove(&key);
                }
                self.len -= 1;
                return;
            }
        }
        log::warn!("[spatial] remove miss for id {id} — falling back to full scan");
        for (k, v) in &mut self.cells {
            if let Some(pos) = v.iter().position(|&x| x == id) {
                v.swap_remove(pos);
                if v.is_empty() {
                    let k = *k;
                    self.cells.remove(&k);
                }
                self.len -= 1;
                return;
            }
        }
    }

    /// Ids in every cell touching the `radius_m` disc around the point (antimeridian
    /// wrap included). A superset: the caller must distance-test each candidate
    /// against current coordinates. When the window holds more cells than are
    /// occupied (huge radius, polar latitude), the occupied cells are scanned
    /// instead — complete at any radius, O(occupied) worst case.
    pub(crate) fn candidates(&self, lat: f64, lng: f64, radius_m: f64, out: &mut Vec<u32>) {
        let cover = mma_geo::covering_cells(lat, lng, radius_m, CELL_DEG);
        if cover.len() > self.cells.len() as u64 {
            for (&(cx, cy), v) in &self.cells {
                if cover.contains(cx, cy) {
                    out.extend_from_slice(v);
                }
            }
        } else {
            for (cx, cy) in cover.cells() {
                if let Some(v) = self.cells.get(&(cx, cy)) {
                    out.extend_from_slice(v);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "spatial.test.rs"]
mod tests;
