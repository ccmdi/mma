//! Radius queries over a point set: the grid broad phase, and nothing about what a
//! caller makes of it.
//!
//! Cell sizing, coordinate quantization and the neighborhood walk live here once, so
//! every sweep built on the grid agrees about what "within N metres" covers. What a
//! neighborhood *means* stays with the caller: duplicate detection reads connected
//! components out of it.

use super::Scope;
#[cfg(test)]
use crate::types::Location;
use mma_geo::equirect_m2;
use serde::Serialize;
use std::collections::HashMap;

/// Cell-hashed spatial grid in CSR layout (Müller, "Blazing Fast Neighbor Search
/// with Spatial Hashing"). Cells are hashed into a fixed table sized to the point
/// count, so the structure is O(n) regardless of spatial extent - no dense world
/// array. Build is two linear passes (count → prefix-sum → scatter); neighbor
/// iteration walks a contiguous slice. Hash collisions are harmless: distinct cells
/// may share a bucket, and the caller's distance test rejects any foreign points.
struct SpatialHash {
    table_size: usize,
    cell_start: Vec<u32>, // len table_size + 1; CSR offsets
    entries: Vec<u32>,    // len n; point indices grouped by bucket
}

#[inline]
fn hash_cell(cx: i32, cy: i32, table_size: usize) -> usize {
    let h = (cx.wrapping_mul(92_837_111)) ^ (cy.wrapping_mul(689_287_499));
    (h.unsigned_abs() as usize) % table_size
}

impl SpatialHash {
    /// Build from per-point integer cell coords. `table_size = max(n, 1)`.
    fn build(cells: &[(i32, i32)]) -> Self {
        let n = cells.len();
        let table_size = n.max(1);
        let mut cell_start = vec![0u32; table_size + 1];
        for &(cx, cy) in cells {
            cell_start[hash_cell(cx, cy, table_size)] += 1;
        }
        // Prefix-sum into start offsets.
        let mut sum = 0u32;
        for slot in &mut cell_start {
            let c = *slot;
            *slot = sum;
            sum += c;
        }
        // Scatter point indices; cell_start[b] temporarily advances as a write cursor.
        let mut entries = vec![0u32; n];
        for (pi, &(cx, cy)) in cells.iter().enumerate() {
            let b = hash_cell(cx, cy, table_size);
            entries[cell_start[b] as usize] = pi as u32;
            cell_start[b] += 1;
        }
        // Restore offsets: shift right by one (the scatter advanced each cursor to its end).
        for b in (1..=table_size).rev() {
            cell_start[b] = cell_start[b - 1];
        }
        cell_start[0] = 0;
        SpatialHash {
            table_size,
            cell_start,
            entries,
        }
    }

    /// Point indices in the bucket that `(cx, cy)` hashes to. May include points from
    /// other cells that collide on the same bucket - caller must distance-filter.
    #[inline]
    fn bucket(&self, cx: i32, cy: i32) -> &[u32] {
        let b = hash_cell(cx, cy, self.table_size);
        &self.entries[self.cell_start[b] as usize..self.cell_start[b + 1] as usize]
    }
}

/// Index groups keyed by exact coordinate, the degenerate-radius fallback every caller
/// shares: "within 0 m" means exact-coordinate equality. The grid would divide by zero,
/// saturate every point to one cell, and collapse to O(n^2). Hashing on exact coords
/// instead is O(n); non-finite coordinates never match anything. (#69)
pub(super) fn exact_coord_groups(pts: &[(f64, f64)]) -> HashMap<(u64, u64), Vec<usize>> {
    let mut groups: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
    for (i, &(lat, lng)) in pts.iter().enumerate() {
        if !lat.is_finite() || !lng.is_finite() {
            continue;
        }
        // `+ 0.0` folds -0.0 into +0.0 so the two compare equal.
        groups
            .entry(((lat + 0.0).to_bits(), (lng + 0.0).to_bits()))
            .or_default()
            .push(i);
    }
    groups
}

/// Points quantized into hashed cells at a radius, answering "what is within that
/// radius of here". Read-only after build, so callers may probe it from parallel
/// iterators.
pub(super) struct Grid {
    /// (lat, lng) per point, the coordinates the cells were quantized from.
    pts: Vec<(f64, f64)>,
    cells: Vec<(i32, i32)>,
    grid: SpatialHash,
    thresh_m2: f64,
    radius_m: f64,
    cell_deg: f64,
}

impl Grid {
    /// `None` for a degenerate radius (distance == 0, or a non-finite cell size) -
    /// callers fall back to `exact_coord_groups`.
    pub(super) fn build(pts: &[(f64, f64)], distance_m: f64) -> Option<Grid> {
        let cell_deg = distance_m / mma_geo::M_PER_DEG * 1.5;
        if cell_deg.is_nan() || cell_deg <= 0.0 {
            return None;
        }
        let pts = pts.to_vec();
        let cells: Vec<(i32, i32)> = pts
            .iter()
            .map(|&(lat, lng)| {
                (
                    (lng / cell_deg).floor() as i32,
                    (lat / cell_deg).floor() as i32,
                )
            })
            .collect();
        let grid = SpatialHash::build(&cells);
        Some(Grid {
            pts,
            cells,
            grid,
            thresh_m2: distance_m * distance_m,
            radius_m: distance_m,
            cell_deg,
        })
    }

    /// Visit every point within the grid's radius of a coordinate. The coordinate need
    /// not be one of the grid's own points. Stops early when `visit` returns true;
    /// returns whether it stopped.
    pub(super) fn for_each_near(
        &self,
        lat: f64,
        lng: f64,
        mut visit: impl FnMut(usize) -> bool,
    ) -> bool {
        let cos_lat = lat.to_radians().cos();
        let cover = mma_geo::covering_cells(lat, lng, self.radius_m, self.cell_deg);
        for (nx, ny) in cover.cells() {
            for &pj in self.grid.bucket(nx, ny) {
                let pj = pj as usize;
                // Bucket may hold points from collided cells; the cell-coord check
                // keeps us to the true neighborhood. Then the distance test.
                if self.cells[pj] != (nx, ny) {
                    continue;
                }
                let (plat, plng) = self.pts[pj];
                if equirect_m2(lat, lng, plat, plng, cos_lat) <= self.thresh_m2 && visit(pj) {
                    return true;
                }
            }
        }
        false
    }

    /// [`Grid::for_each_near`] from a point the grid holds, skipping indices below
    /// `min_pj` (`pi + 1` gives the ordered pair sweep, `0` gives all neighbours).
    pub(super) fn for_each_neighbor(
        &self,
        pi: usize,
        min_pj: usize,
        mut visit: impl FnMut(usize) -> bool,
    ) -> bool {
        let (lat, lng) = self.pts[pi];
        self.for_each_near(lat, lng, |pj| pj != pi && pj >= min_pj && visit(pj))
    }
}

/// Grid broad-phase pair sweep: calls `pair(state, pi, pj)` (pi < pj) for every index
/// pair within `distance_m` metres. O(N) average with uniform distribution, O(N^2)
/// worst case if all points fall in one grid cell.
pub(super) fn for_pairs_within<S>(
    n: usize,
    pos: impl Fn(usize) -> (f64, f64),
    distance_m: f64,
    state: &mut S,
    mut pair: impl FnMut(&mut S, usize, usize),
) {
    if n < 2 {
        return;
    }
    let pts: Vec<(f64, f64)> = (0..n).map(pos).collect();
    let Some(grid) = Grid::build(&pts, distance_m) else {
        for idxs in exact_coord_groups(&pts).values() {
            for (a, &pi) in idxs.iter().enumerate() {
                for &pj in &idxs[a + 1..] {
                    pair(state, pi, pj);
                }
            }
        }
        return;
    };
    for pi in 0..n {
        grid.for_each_neighbor(pi, pi + 1, |pj| {
            pair(state, pi, pj);
            false
        });
    }
}

/// One neighbor: where it is, how far, and the fields that were asked for.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighbor {
    pub id: u32,
    pub lat: f64,
    pub lng: f64,
    pub dist_m: f64,
    #[serde(flatten)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

/// How an [`Index`] finds a coordinate's points: the grid at a positive radius, exact
/// coordinates at a degenerate one.
enum Lookup {
    Grid(Grid),
    Exact(HashMap<(u64, u64), Vec<usize>>),
}

/// A radius query answered without the store: coordinates and whichever fields the
/// caller named, resolved once at build. A caller that asks per row would otherwise
/// re-lock the store and re-resolve `extra` on every call.
///
/// The radius is fixed at build because it sizes the cells: [`Index::within`] answers
/// at that radius and no other, so a query can never outrun the grid backing it.
pub struct Index {
    lookup: Lookup,
    ids: Vec<u32>,
    pts: Vec<(f64, f64)>,
    /// Per point, the named fields that had a value.
    fields: Vec<serde_json::Map<String, serde_json::Value>>,
}

impl Index {
    pub fn build(scope: &Scope, radius_m: f64, want: &[String]) -> Index {
        let mut ids = Vec::new();
        let mut pts = Vec::new();
        let mut fields = Vec::new();
        for row in scope.rows() {
            ids.push(row.id());
            pts.push((row.lat(), row.lng()));
            let mut got = serde_json::Map::new();
            for name in want {
                if let Some(v) = row.resolve_field(name) {
                    got.insert(name.clone(), v);
                }
            }
            fields.push(got);
        }
        let lookup = match Grid::build(&pts, radius_m) {
            Some(grid) => Lookup::Grid(grid),
            None => Lookup::Exact(exact_coord_groups(&pts)),
        };
        Index {
            lookup,
            ids,
            pts,
            fields,
        }
    }

    /// Points within the built radius of a coordinate, nearest first. A point at that
    /// exact coordinate is included: the caller knows its own id and can drop itself,
    /// and a caller probing a coordinate it does not own would otherwise lose a real hit.
    pub fn within(&self, lat: f64, lng: f64) -> Vec<Neighbor> {
        let cos_lat = lat.to_radians().cos();
        let mut out: Vec<Neighbor> = Vec::new();
        let mut hit = |pi: usize| {
            let (plat, plng) = self.pts[pi];
            out.push(Neighbor {
                id: self.ids[pi],
                lat: plat,
                lng: plng,
                dist_m: equirect_m2(lat, lng, plat, plng, cos_lat).sqrt(),
                fields: self.fields[pi].clone(),
            });
        };
        match &self.lookup {
            Lookup::Grid(grid) => {
                grid.for_each_near(lat, lng, |pi| {
                    hit(pi);
                    false
                });
            }
            Lookup::Exact(groups) => {
                let key = ((lat + 0.0).to_bits(), (lng + 0.0).to_bits());
                groups
                    .get(&key)
                    .into_iter()
                    .flatten()
                    .for_each(|&pi| hit(pi));
            }
        }
        out.sort_unstable_by(|a, b| a.dist_m.total_cmp(&b.dist_m).then_with(|| a.id.cmp(&b.id)));
        out
    }
}

#[cfg(test)]
#[path = "neighborhood.test.rs"]
mod tests;
