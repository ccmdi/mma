//! Near-duplicate detection and pruning over a location view.

use super::*;
use crate::selections::field_expr::{self, Expr};
use crate::types::{AppResult, Location, LocationFlags};
use mma_geo::equirect_m2;
use std::collections::HashMap;

/// Cell-hashed spatial grid in CSR layout (Müller, "Blazing Fast Neighbor Search
/// with Spatial Hashing"). Cells are hashed into a fixed table sized to the point
/// count, so the structure is O(n) regardless of spatial extent - no dense world
/// array. Build is two linear passes (count → prefix-sum → scatter); neighbor
/// iteration walks a contiguous slice. Hash collisions are harmless: distinct cells
/// may share a bucket, and the caller's distance test rejects any foreign points.
pub(super) struct SpatialHash {
    pub(super) table_size: usize,
    pub(super) cell_start: Vec<u32>, // len table_size + 1; CSR offsets
    pub(super) entries: Vec<u32>,    // len n; point indices grouped by bucket
}

#[inline]
pub(super) fn hash_cell(cx: i32, cy: i32, table_size: usize) -> usize {
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

/// Index groups keyed by exact coordinate, the degenerate-radius fallback shared by
/// every duplicate path: "within 0 m" means exact-coordinate equality. The grid would
/// divide by zero, saturate every point to one cell, and collapse to O(n^2). Hashing
/// on exact coords instead is O(n); non-finite coordinates never match anything. (#69)
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

/// The grid broad-phase every duplicate path runs on: cell sizing, coordinate
/// quantization, and the neighborhood walk live here once, so the pair sweep and
/// the parallel per-point scan cannot drift apart. Read-only after build, so callers
/// may probe it from parallel iterators.
pub(super) struct DupGrid {
    /// (lat, lng) per point, the coordinates the cells were quantized from.
    pub(super) pts: Vec<(f64, f64)>,
    pub(super) cells: Vec<(i32, i32)>,
    pub(super) grid: SpatialHash,
    pub(super) thresh_m2: f64,
    pub(super) radius_m: f64,
    pub(super) cell_deg: f64,
}

impl DupGrid {
    /// `None` for a degenerate radius (distance == 0, or a non-finite cell size) -
    /// callers fall back to `exact_coord_groups`.
    fn build(pts: &[(f64, f64)], distance_m: f64) -> Option<DupGrid> {
        let cell_deg = distance_m / mma_geo::M_PER_DEG * 1.5;
        if !(cell_deg > 0.0) {
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
        Some(DupGrid {
            pts,
            cells,
            grid,
            thresh_m2: distance_m * distance_m,
            radius_m: distance_m,
            cell_deg,
        })
    }

    /// Visit every point within the distance threshold of `pi`, skipping indices below
    /// `min_pj` before the distance test (`pi + 1` gives the ordered pair sweep, `0`
    /// gives all neighbours). Stops early when `visit` returns true; returns whether it
    /// stopped.
    fn for_each_neighbor(
        &self,
        pi: usize,
        min_pj: usize,
        mut visit: impl FnMut(usize) -> bool,
    ) -> bool {
        let (lat, lng) = self.pts[pi];
        let cos_lat = lat.to_radians().cos();
        let cover = mma_geo::covering_cells(lat, lng, self.radius_m, self.cell_deg);
        for (nx, ny) in cover.cells() {
            for &pj in self.grid.bucket(nx, ny) {
                let pj = pj as usize;
                if pj == pi || pj < min_pj {
                    continue;
                }
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
}

/// Grid broad-phase pair sweep shared by the duplicate groups/prune paths.
/// Calls `pair(state, pi, pj)` (pi < pj) for every index pair within `distance_m`
/// metres. O(N) average with uniform distribution, O(N^2) worst case if all points
/// fall in one grid cell.
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
    let Some(grid) = DupGrid::build(&pts, distance_m) else {
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

/// Grid-accelerated spatial duplicate detection: `mask[global_idx] = true` for every
/// location with at least one other location within `distance_m`. A per-point
/// predicate rather than a pair sweep: the grid is read-only after build, so points
/// are tested in parallel, and each test early-exits on its first neighbour - a
/// dense cluster costs O(1) per member instead of O(members) pair callbacks.
pub(super) fn find_duplicates_bitmask(view: &LocView, distance_m: f64, mask: &mut [bool]) {
    use rayon::prelude::*;
    struct Pt {
        lat: f64,
        lng: f64,
        global_idx: usize,
    }
    let mut points = Vec::new();

    for i in 0..view.batch_rows {
        if !view.is_alive(i) {
            continue;
        }
        if let Some(p) = view.patch_at(i) {
            points.push(Pt {
                lat: p.lat,
                lng: p.lng,
                global_idx: i,
            });
        } else {
            points.push(Pt {
                lat: view.lats.unwrap().value(i),
                lng: view.lngs.unwrap().value(i),
                global_idx: i,
            });
        }
    }
    for (j, loc) in view.adds.iter().enumerate() {
        points.push(Pt {
            lat: loc.lat,
            lng: loc.lng,
            global_idx: view.batch_rows + j,
        });
    }

    let n = points.len();
    if n < 2 {
        return;
    }

    let pts: Vec<(f64, f64)> = points.iter().map(|p| (p.lat, p.lng)).collect();
    // Degenerate radius: every member of an exact-coordinate group of >= 2 is a dup.
    let Some(grid) = DupGrid::build(&pts, distance_m) else {
        for idxs in exact_coord_groups(&pts).values() {
            if idxs.len() >= 2 {
                for &i in idxs {
                    mask[points[i].global_idx] = true;
                }
            }
        }
        return;
    };

    let marks: Vec<bool> = (0..n)
        .into_par_iter()
        .with_min_len(4096)
        .map(|pi| grid.for_each_neighbor(pi, 0, |_| true))
        .collect();
    for (i, p) in points.iter().enumerate() {
        if marks[i] {
            mask[p.global_idx] = true;
        }
    }
}

/// Transitive (connected-component) spatial grouping. Two locations are linked when within
/// `distance_m` metres; each returned group is a connected component of size >= 2. Same
/// grid broad-phase as `find_duplicates_bitmask`, but union-find preserves the partition
/// instead of flattening to a membership mask. Chains collapse: A~B, B~C => {A,B,C} even
/// if A and C are out of range. Output is deterministic: ids ascending within each group,
/// groups ordered by first id.
pub fn find_duplicate_groups(view: &LocView, distance_m: f64) -> Vec<Vec<u32>> {
    struct Pt {
        lat: f64,
        lng: f64,
        id: u32,
    }
    let mut points: Vec<Pt> = Vec::new();
    view.for_each(|row| {
        points.push(Pt {
            lat: row.lat(),
            lng: row.lng(),
            id: row.id(),
        });
    });

    let n = points.len();
    if n < 2 {
        return Vec::new();
    }

    // Union-find with path halving and union by size.
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut uf: (Vec<usize>, Vec<u32>) = ((0..n).collect(), vec![1; n]);

    for_pairs_within(
        n,
        |i| (points[i].lat, points[i].lng),
        distance_m,
        &mut uf,
        |uf, pi, pj| {
            let ra = find(&mut uf.0, pi);
            let rb = find(&mut uf.0, pj);
            if ra != rb {
                let (small, big) = if uf.1[ra] < uf.1[rb] {
                    (ra, rb)
                } else {
                    (rb, ra)
                };
                uf.0[small] = big;
                uf.1[big] += uf.1[small];
            }
        },
    );
    let mut parent = uf.0;

    let mut comps: HashMap<usize, Vec<u32>> = HashMap::new();
    for pi in 0..n {
        let r = find(&mut parent, pi);
        comps.entry(r).or_default().push(points[pi].id);
    }

    let mut groups: Vec<Vec<u32>> = comps
        .into_values()
        .filter(|g| g.len() >= 2)
        .map(|mut g| {
            g.sort_unstable();
            g
        })
        .collect();
    groups.sort_unstable_by_key(|g| g[0]);
    groups
}

/// The default duplicate score: how finished a location is. Doubles as the placeholder
/// the map settings input shows when a map states no preference of its own.
pub const DEFAULT_DUPLICATE_SCORE: &str = "tagCount + has(panoId) + loadAsPanoId + (heading != 0)";

/// The map's duplicate preference, or the built-in default when it states none. Merge
/// and prune both rank through this, so a map has one answer to "which duplicate is the
/// better one", not two.
pub fn parse_duplicate_score(src: Option<&str>) -> AppResult<Expr> {
    let src = src.map(str::trim).filter(|s| !s.is_empty());
    field_expr::parse(src.unwrap_or(DEFAULT_DUPLICATE_SCORE))
}

/// Which of two duplicates is the better one to keep, greatest first. `created_at` and
/// `id` are reversed so the older and the lower win ties. A location the expression
/// cannot score ranks below every one it can.
pub fn better(a: &Location, b: &Location, score: &Expr) -> Ordering {
    let rank = |l: &Location| {
        let row = RowRef::from_loc(l);
        field_expr::eval(score, &|name| row.resolve_field(name))
    };
    // eval never yields NaN, so partial_cmp is total.
    rank(a)
        .partial_cmp(&rank(b))
        .unwrap_or(Ordering::Equal)
        .then_with(|| b.created_at.cmp(&a.created_at))
        .then_with(|| b.id.cmp(&a.id))
}

/// Prune duplicates. `locs` is the resolved selection; informational locations are
/// never pruned and never count as neighbours. Returns ids to remove.
/// - <= 25 m: relevance prune - each radius cluster keeps its best-scored location
///   (see [`better`]), rest pruned.
/// - > 25 m: greedy max-thinning - repeatedly drop the location with the most in-range
///   > neighbours until no two survivors are within `distance_m`.
pub fn prune_duplicates(locs: &[Location], distance_m: f64, score: &Expr) -> Vec<u32> {
    let locs: Vec<&Location> = locs
        .iter()
        .filter(|l| !l.flags.contains(LocationFlags::INFORMATIONAL))
        .collect();
    if locs.len() < 2 {
        return Vec::new();
    }
    if distance_m > 25.0 {
        prune_thinning(&locs, distance_m)
    } else {
        prune_relevance(&locs, distance_m, score)
    }
}

/// Symmetric within-distance neighbour lists (indices into `locs`).
pub(super) fn neighbor_lists(locs: &[&Location], distance_m: f64) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); locs.len()];
    for_pairs_within(
        locs.len(),
        |i| (locs[i].lat, locs[i].lng),
        distance_m,
        &mut out,
        |out, pi, pj| {
            out[pi].push(pj);
            out[pj].push(pi);
        },
    );
    out
}

pub(super) fn prune_relevance(locs: &[&Location], distance_m: f64, score: &Expr) -> Vec<u32> {
    let neighbors = neighbor_lists(locs, distance_m);
    let mut pruned = vec![false; locs.len()];
    let mut out = Vec::new();
    for i in 0..locs.len() {
        if pruned[i] {
            continue;
        }
        let mut cluster: Vec<usize> = vec![i];
        cluster.extend(neighbors[i].iter().copied().filter(|&j| !pruned[j]));
        if cluster.len() < 2 {
            continue;
        }
        let survivor = *cluster
            .iter()
            .max_by(|&&a, &&b| better(locs[a], locs[b], score))
            .unwrap();
        for &j in &cluster {
            if j != survivor {
                pruned[j] = true;
                out.push(locs[j].id);
            }
        }
    }
    out
}

pub(super) fn prune_thinning(locs: &[&Location], distance_m: f64) -> Vec<u32> {
    let n = locs.len();
    let neighbors = neighbor_lists(locs, distance_m);
    let mut deg: Vec<u32> = neighbors.iter().map(|v| v.len() as u32).collect();
    let mut removed = vec![false; n];
    // Bucket queue by degree: O(n + m) total instead of an O(n) max-scan per round.
    // A degree drop re-files the node; the entry left in the old bucket goes stale
    // and is skipped on pop (deg mismatch), so no in-place removal is needed.
    let max_deg = deg.iter().copied().max().unwrap_or(0) as usize;
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); max_deg + 1];
    for i in 0..n {
        if deg[i] > 0 {
            buckets[deg[i] as usize].push(i);
        }
    }
    let mut cur = max_deg;
    while cur > 0 {
        let Some(i) = buckets[cur].pop() else {
            cur -= 1;
            continue;
        };
        if removed[i] || deg[i] as usize != cur {
            continue;
        }
        removed[i] = true;
        deg[i] = 0;
        for &u in &neighbors[i] {
            if !removed[u] && deg[u] > 0 {
                deg[u] -= 1;
                if deg[u] > 0 {
                    buckets[deg[u] as usize].push(u);
                }
            }
        }
    }
    (0..n).filter(|&i| removed[i]).map(|i| locs[i].id).collect()
}
