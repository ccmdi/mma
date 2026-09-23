//! Near-duplicate detection and pruning over a location view: a neighborhood read as
//! connected components.

use super::*;
use crate::selections::field_expr::{self, Expr};
use crate::selections::neighborhood::{exact_coord_groups, for_pairs_within, Grid};
use crate::types::{AppResult, Location};
use std::collections::HashMap;

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

    for i in 0..view.batch_rows() {
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
                lat: view.cols.unwrap().lat.value(i),
                lng: view.cols.unwrap().lng.value(i),
                global_idx: i,
            });
        }
    }
    for (j, loc) in view.adds.iter().enumerate() {
        points.push(Pt {
            lat: loc.lat,
            lng: loc.lng,
            global_idx: view.batch_rows() + j,
        });
    }

    let n = points.len();
    if n < 2 {
        return;
    }

    let pts: Vec<(f64, f64)> = points.iter().map(|p| (p.lat, p.lng)).collect();
    // Degenerate radius: every member of an exact-coordinate group of >= 2 is a dup.
    let Some(grid) = Grid::build(&pts, distance_m) else {
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

impl Scope<'_, '_> {
    /// Transitive (connected-component) spatial grouping. Two locations are linked when within
    /// `distance_m` metres; each returned group is a connected component of size >= 2. Same
    /// grid broad-phase as `find_duplicates_bitmask`, but union-find preserves the partition
    /// instead of flattening to a membership mask. Chains collapse: A~B, B~C => {A,B,C} even
    /// if A and C are out of range. Output is deterministic: ids ascending within each group,
    /// groups ordered by first id.
    pub fn duplicate_groups(&self, distance_m: f64) -> Vec<Vec<u32>> {
        struct Pt {
            lat: f64,
            lng: f64,
            id: u32,
        }
        let mut points: Vec<Pt> = Vec::new();
        for row in self.rows() {
            points.push(Pt {
                lat: row.lat(),
                lng: row.lng(),
                id: row.id(),
            });
        }

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
        for (pi, point) in points.iter().enumerate() {
            let r = find(&mut parent, pi);
            comps.entry(r).or_default().push(point.id);
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
}

/// The default duplicate score: how finished a location is. Doubles as the placeholder
/// the map settings input shows when a map states no preference of its own.
pub const DEFAULT_DUPLICATE_SCORE: &str = "tagCount + has(panoId) + loadAsPanoId + (heading != 0)";

/// The map's duplicate preference, or the built-in default when it states none. Merge
/// and prune both rank through this, so a map has one answer to "which duplicate is the
/// better one", not two.
pub fn parse_duplicate_score(src: Option<&str>) -> AppResult<Expr> {
    let src = src.map(str::trim).filter(|s| !s.is_empty());
    Ok(field_expr::parse(src.unwrap_or(DEFAULT_DUPLICATE_SCORE))?)
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

/// Prune duplicates. `locs` is the resolved selection. Returns ids to remove.
/// - <= 25 m: relevance prune - each radius cluster keeps its best-scored location
///   (see [`better`]), rest pruned.
/// - > 25 m: greedy max-thinning - repeatedly drop the location with the most in-range
///   > neighbours until no two survivors are within `distance_m`.
pub fn prune_duplicates(locs: &[Location], distance_m: f64, score: &Expr) -> Vec<u32> {
    let locs: Vec<&Location> = locs.iter().collect();
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
