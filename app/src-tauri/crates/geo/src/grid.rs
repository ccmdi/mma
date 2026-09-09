//! Incremental spatial index: a fixed-cell hash grid over id-keyed points for
//! meter-scale radius queries. Built once, maintained by insert/remove - O(delta) per
//! mutation, O(min(cells in radius, occupied cells)) per query.
//!
//! Cells are keyed by floored lat/lng degree coordinates. Removal derives the cell
//! from the coordinates the caller supplies (the point's current state), so no
//! id->cell reverse map is needed; a full-scan fallback guards against drift.

use crate::{covering_cells, M_PER_DEG};
use std::collections::HashMap;

#[inline]
fn cell_for(cell_deg: f64, lat: f64, lng: f64) -> (i32, i32) {
    (
        (lng / cell_deg).floor() as i32,
        (lat / cell_deg).floor() as i32,
    )
}

pub struct SpatialIndex {
    cells: HashMap<(i32, i32), Vec<u32>>,
    len: usize,
    cell_deg: f64,
}

impl SpatialIndex {
    /// Longitude cells narrow toward the poles, which only means more (empty) cells
    /// walked there - correctness always comes from the caller's distance test.
    pub fn new(cell_m: f64) -> Self {
        SpatialIndex {
            cells: HashMap::new(),
            len: 0,
            cell_deg: cell_m / M_PER_DEG,
        }
    }

    /// Number of indexed points, for drift checks against the caller's own count.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn insert(&mut self, id: u32, lat: f64, lng: f64) {
        if !lat.is_finite() || !lng.is_finite() {
            return;
        }
        self.cells
            .entry(cell_for(self.cell_deg, lat, lng))
            .or_default()
            .push(id);
        self.len += 1;
    }

    /// Remove `id`, deriving its cell from the coordinates it was indexed under.
    /// If the coords don't locate it (a caller passed stale state), fall back to a
    /// full scan so the index never silently keeps a dead entry; returns false when
    /// that fallback was needed.
    pub fn remove(&mut self, id: u32, lat: f64, lng: f64) -> bool {
        let key = cell_for(self.cell_deg, lat, lng);
        if let Some(v) = self.cells.get_mut(&key) {
            if let Some(pos) = v.iter().position(|&x| x == id) {
                v.swap_remove(pos);
                if v.is_empty() {
                    self.cells.remove(&key);
                }
                self.len -= 1;
                return true;
            }
        }
        for (k, v) in &mut self.cells {
            if let Some(pos) = v.iter().position(|&x| x == id) {
                v.swap_remove(pos);
                if v.is_empty() {
                    let k = *k;
                    self.cells.remove(&k);
                }
                self.len -= 1;
                break;
            }
        }
        false
    }

    /// Ids in every cell touching the `radius_m` disc around the point (antimeridian
    /// wrap included). A superset: the caller must distance-test each candidate
    /// against current coordinates. When the window holds more cells than are
    /// occupied (huge radius, polar latitude), the occupied cells are scanned
    /// instead - complete at any radius, O(occupied) worst case.
    pub fn candidates(&self, lat: f64, lng: f64, radius_m: f64, out: &mut Vec<u32>) {
        let cover = covering_cells(lat, lng, radius_m, self.cell_deg);
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

    /// `candidates` with an early exit: true as soon as `predicate` accepts one. The
    /// center cell goes first because that is where a hit almost always is. Kept apart
    /// from `candidates` so the exhaustive walk stays branch-free.
    pub fn any_candidate(
        &self,
        lat: f64,
        lng: f64,
        radius_m: f64,
        mut predicate: impl FnMut(u32) -> bool,
    ) -> bool {
        let cover = covering_cells(lat, lng, radius_m, self.cell_deg);
        if cover.len() > self.cells.len() as u64 {
            for (&(cx, cy), v) in &self.cells {
                if cover.contains(cx, cy) && v.iter().copied().any(&mut predicate) {
                    return true;
                }
            }
        } else {
            let center = cell_for(self.cell_deg, lat, lng);
            if cover.contains(center.0, center.1)
                && self
                    .cells
                    .get(&center)
                    .is_some_and(|ids| ids.iter().copied().any(&mut predicate))
            {
                return true;
            }
            for (cx, cy) in cover.cells() {
                if (cx, cy) == center {
                    continue;
                }
                if let Some(v) = self.cells.get(&(cx, cy)) {
                    if v.iter().copied().any(&mut predicate) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
#[path = "grid.test.rs"]
mod tests;
