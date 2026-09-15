//! Read-only queries over the store: bounds, spatial lookups, spaced picks, aggregates.

use super::*;
use crate::selections::{self, Selector};
use crate::store::arrow::{col_lat, col_lng};
use crate::types::Location;
use crate::types::{AppError, AppResult};
use mma_geo::{fold_lng, HexGrid, EARTH_R_M};
use roaring::RoaringBitmap;
use std::collections::HashMap;
use std::f64::consts::PI;

/// ~25m cells: 1-100m queries walk a handful of cells; a 1km query walks ~80x80.
pub(crate) const SPATIAL_CELL_M: f64 = 25.0;
use std::time::Instant;

/// Everything derived from a single O(N) pass over all alive locations. Computed
/// once on map open; add new whole-map derivations here rather than scanning again.
pub(crate) struct LocationAggregates {
    pub(crate) alive: usize,
    pub(crate) tag_counts: HashMap<u32, usize>,
    pub(crate) tag_sets: HashMap<u32, RoaringBitmap>,
    pub(crate) bounds: Option<BoundsAcc>,
}

struct TagAggregate {
    count: usize,
    ids: RoaringBitmap,
}

/// Incremental bounding-box accumulator. Tracks latitude min/max plus longitude
/// min/max in *two* framings - raw `[-180,180]` and shifted `[0,360)` - so
/// `resolve` can pick the tighter longitude span and emit an antimeridian-crossing
/// box (`west > east`) when the data straddles 180°. Every field is a plain
/// min/max, so it grows in O(1) per point with no sort - the cache stays cheap.
#[derive(Clone, Copy)]
pub(crate) struct BoundsAcc {
    s: f64,
    n: f64, // latitude min / max
    w: f64,
    e: f64, // longitude min / max, raw [-180,180]
    ws: f64,
    es: f64, // longitude min / max, shifted to [0,360)
}

impl BoundsAcc {
    pub(super) fn shift(lng: f64) -> f64 {
        if lng < 0.0 {
            lng + 360.0
        } else {
            lng
        }
    }

    pub(super) fn seed(lat: f64, lng: f64) -> Self {
        let sh = Self::shift(lng);
        BoundsAcc {
            s: lat,
            n: lat,
            w: lng,
            e: lng,
            ws: sh,
            es: sh,
        }
    }

    pub(super) fn expand(self, lat: f64, lng: f64) -> Self {
        let sh = Self::shift(lng);
        BoundsAcc {
            s: self.s.min(lat),
            n: self.n.max(lat),
            w: self.w.min(lng),
            e: self.e.max(lng),
            ws: self.ws.min(sh),
            es: self.es.max(sh),
        }
    }

    /// Fold a point into an optional accumulator (seed if empty).
    pub(super) fn fold(acc: Option<Self>, lat: f64, lng: f64) -> Self {
        match acc {
            Some(a) => a.expand(lat, lng),
            None => Self::seed(lat, lng),
        }
    }

    /// `[west, south, east, north]`, choosing whichever longitude framing is
    /// tighter. The shifted framing winning means the box crosses 180°, which
    /// maps back to `west > east` - the form Google/deck `fitBounds` zooms to the
    /// short way (matching the original's `east += 360` handling).
    pub(super) fn resolve(self) -> [f64; 4] {
        if self.es - self.ws < self.e - self.w {
            let unshift = |v: f64| if v >= 180.0 { v - 360.0 } else { v };
            [unshift(self.ws), self.s, unshift(self.es), self.n]
        } else {
            [self.w, self.s, self.e, self.n]
        }
    }

    /// Whether a point sits on any extreme - removing it might shrink the box,
    /// forcing a recompute.
    pub(super) fn on_edge(self, lat: f64, lng: f64) -> bool {
        let sh = Self::shift(lng);
        lat == self.s
            || lat == self.n
            || lng == self.w
            || lng == self.e
            || sh == self.ws
            || sh == self.es
    }
}

/// A spaced pick's answer: the picked ids plus the spacing they were picked at.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpacedPickResult {
    pub ids: Vec<u32>,
    pub distance_m: i32,
}

/// One pick per honeycomb cell: the location nearest its center, best-centered cells first,
/// skipping any location within half the spacing of one already kept.
fn even_picks(candidates: &[(u32, f64, f64)], grid: &HexGrid, spacing_m: f64) -> Vec<u32> {
    let mut nearest: HashMap<(i64, i64), (f64, usize)> = HashMap::new();
    for (i, &(id, lat, lng)) in candidates.iter().enumerate() {
        let node = grid.nearest(lat, lng);
        let d = selections::haversine_m(lat, lng, node.lat, node.lng);
        nearest
            .entry((node.row, node.col))
            .and_modify(|best| {
                if (d, id) < (best.0, candidates[best.1].0) {
                    *best = (d, i);
                }
            })
            .or_insert((d, i));
    }
    let mut winners: Vec<(f64, usize)> = nearest.into_values().collect();
    winners.sort_by(|a, b| {
        a.0.total_cmp(&b.0)
            .then(candidates[a.1].0.cmp(&candidates[b.1].0))
    });

    let floor = spacing_m / 2.0;
    let mut kept: Vec<usize> = Vec::new();
    let mut index = mma_geo::SpatialIndex::new(floor);
    for (_, i) in winners {
        let (_, lat, lng) = candidates[i];
        let crowded = index.any_candidate(lat, lng, floor, |k| {
            let (_, klat, klng) = candidates[kept[k as usize]];
            selections::haversine_m(lat, lng, klat, klng) < floor
        });
        if !crowded {
            index.insert(kept.len() as u32, lat, lng);
            kept.push(i);
        }
    }
    kept.into_iter().map(|i| candidates[i].0).collect()
}

impl Store {
    /// Current coordinates of an alive location, without cloning the full Location.
    #[inline]
    pub(super) fn coords_of(&self, id: u32) -> Option<(f64, f64)> {
        Self::coords_from(&self.overlay, self.batch.as_ref(), id)
    }

    #[inline]
    fn coords_from(overlay: &Overlay, batch: Option<&RecordBatch>, id: u32) -> Option<(f64, f64)> {
        if overlay.dead.contains(&id) {
            return None;
        }
        if let Some(p) = overlay.patches.get(&id) {
            return Some((p.lat, p.lng));
        }
        if let Ok(i) = overlay.adds.binary_search_by_key(&id, |l| l.id) {
            let l = &overlay.adds[i];
            return Some((l.lat, l.lng));
        }
        if let Some(b) = batch {
            if let Some(idx) = batch_row_for_id(b, id) {
                return Some((col_lat(b).value(idx), col_lng(b).value(idx)));
            }
        }
        None
    }

    /// Build the spatial index if absent or drifted (length mismatch vs alive_count
    /// catches any bulk path that bypassed the overlay fns - rebuild, never wrong).
    pub(super) fn ensure_spatial(&mut self) {
        if let Some(ix) = self.spatial.as_ref() {
            if ix.len() == *self.alive_count {
                return;
            }
            log::warn!(
                "[spatial] index len {} != alive {} - rebuilding",
                ix.len(),
                *self.alive_count
            );
        }
        let _t = Instant::now();
        let mut ix = mma_geo::SpatialIndex::new(SPATIAL_CELL_M);
        self.loc_view()
            .for_each(|row| ix.insert(row.id(), row.lat(), row.lng()));
        log::debug!(
            "[spatial] built n={} in {}ms",
            ix.len(),
            _t.elapsed().as_millis()
        );
        self.spatial = Some(ix);
    }

    /// Ids of alive locations within `radius_m` metres of the point. Index-backed:
    /// O(cells in radius) instead of an O(N) scan.
    pub(crate) fn find_nearby_ids(&mut self, lat: f64, lng: f64, radius_m: f64) -> Vec<u32> {
        self.ensure_spatial();
        let mut cand = Vec::new();
        self.spatial
            .as_ref()
            .unwrap()
            .candidates(lat, lng, radius_m, &mut cand);
        cand.retain(|&id| {
            self.coords_of(id)
                .is_some_and(|(la, ln)| selections::haversine_m(lat, lng, la, ln) <= radius_m)
        });
        cand
    }

    /// Whether any alive location lies within `radius_m` metres of the point.
    pub(crate) fn any_within(&mut self, lat: f64, lng: f64, radius_m: f64) -> bool {
        self.ensure_spatial();
        let overlay = &self.overlay;
        let batch = self.batch.as_ref();
        self.spatial
            .as_ref()
            .unwrap()
            .any_candidate(lat, lng, radius_m, |id| {
                Self::coords_from(overlay, batch, id)
                    .is_some_and(|(la, ln)| selections::haversine_m(lat, lng, la, ln) <= radius_m)
            })
    }

    /// Evenly spaced subset of `set` (`None` = whole map): `target_count` thins to
    /// N ids maximizing spacing; `min_distance_m` keeps as many as fit at that
    /// spacing.
    pub(crate) fn pick_spaced(
        &self,
        set: Option<&RoaringBitmap>,
        target_count: Option<u32>,
        min_distance_m: Option<u32>,
    ) -> AppResult<SpacedPickResult> {
        match (target_count, min_distance_m) {
            (Some(_), Some(_)) => {
                return Err(AppError::from(
                    "pick_spaced: pass exactly one of target_count or min_distance_m, not both",
                ))
            }
            (None, None) => {
                return Err(AppError::from(
                    "pick_spaced: pass exactly one of target_count or min_distance_m",
                ))
            }
            (_, Some(0)) => {
                return Err(AppError::from(
                    "pick_spaced: min_distance_m must be greater than 0",
                ))
            }
            (_, Some(d)) if d > i32::MAX as u32 => {
                return Err(AppError::from("pick_spaced: min_distance_m too large"))
            }
            _ => {}
        }

        let mut candidates = self.located(set);
        fastrand::shuffle(&mut candidates);

        if let Some(n) = target_count {
            if n as usize >= candidates.len() {
                return Ok(SpacedPickResult {
                    ids: candidates.iter().map(|c| c.0).collect(),
                    distance_m: 0,
                });
            }
            let coords: Vec<(f64, f64)> = candidates.iter().map(|c| (c.1, c.2)).collect();
            let (idxs, distance_m) =
                vali_geo::with_max_min_distance(&coords, n as usize, None, &[]);
            let ids = idxs.into_iter().map(|i| candidates[i as usize].0).collect();
            return Ok(SpacedPickResult { ids, distance_m });
        }

        let d = min_distance_m.unwrap() as i32;
        if candidates.is_empty() {
            return Ok(SpacedPickResult {
                ids: Vec::new(),
                distance_m: 0,
            });
        }
        let coords: Vec<(f64, f64)> = candidates.iter().map(|c| (c.1, c.2)).collect();
        let idxs = vali_geo::place_spaced(&coords, candidates.len(), d, &[]);
        let ids = idxs.into_iter().map(|i| candidates[i as usize].0).collect();
        Ok(SpacedPickResult { ids, distance_m: d })
    }

    /// Evenly spaced subset of `set` (`None` = whole map) on a honeycomb: `spacing_m` keeps
    /// picks about that far apart and never closer than half of it; `target_count` searches
    /// for the spacing that keeps at most N.
    pub(crate) fn pick_even(
        &self,
        set: Option<&RoaringBitmap>,
        target_count: Option<u32>,
        spacing_m: Option<f64>,
    ) -> AppResult<SpacedPickResult> {
        match (target_count, spacing_m) {
            (Some(_), Some(_)) => {
                return Err(AppError::from(
                    "pick_even: pass exactly one of target_count or spacing_m, not both",
                ))
            }
            (None, None) => {
                return Err(AppError::from(
                    "pick_even: pass exactly one of target_count or spacing_m",
                ))
            }
            (_, Some(d)) if !(d.is_finite() && d > 0.0) => {
                return Err(AppError::from(
                    "pick_even: spacing_m must be greater than 0",
                ))
            }
            _ => {}
        }

        let candidates = self.located(set);
        let Some(bounds) = candidates.iter().fold(None, |acc, &(_, lat, lng)| {
            Some(BoundsAcc::fold(acc, lat, lng))
        }) else {
            return Ok(SpacedPickResult {
                ids: Vec::new(),
                distance_m: 0,
            });
        };
        let [west, south, east, north] = bounds.resolve();
        let east = if east < west { east + 360.0 } else { east };
        let (lat, lng) = ((south + north) / 2.0, fold_lng((west + east) / 2.0, -180.0));
        let pick =
            |spacing: f64| even_picks(&candidates, &HexGrid::new(lat, lng, spacing), spacing);

        if let Some(spacing) = spacing_m {
            return Ok(SpacedPickResult {
                ids: pick(spacing),
                distance_m: spacing.round() as i32,
            });
        }
        let goal = target_count.unwrap() as usize;
        if goal >= candidates.len() {
            return Ok(SpacedPickResult {
                ids: candidates.iter().map(|c| c.0).collect(),
                distance_m: 0,
            });
        }
        if goal == 0 {
            return Ok(SpacedPickResult {
                ids: Vec::new(),
                distance_m: 0,
            });
        }
        let (mut fits, mut crowded) = (4.0 * PI * EARTH_R_M, 1.0);
        let mut best = pick(fits);
        let finest = pick(crowded);
        if finest.len() <= goal {
            return Ok(SpacedPickResult {
                ids: finest,
                distance_m: 1,
            });
        }
        while fits / crowded > 1.001 {
            let spacing = (fits * crowded).sqrt();
            let ids = pick(spacing);
            if ids.len() <= goal {
                best = ids;
                fits = spacing;
            } else {
                crowded = spacing;
            }
        }
        Ok(SpacedPickResult {
            ids: best,
            distance_m: fits.round() as i32,
        })
    }

    /// The alive locations in `set` (`None` = whole map) that have finite coordinates.
    fn located(&self, set: Option<&RoaringBitmap>) -> Vec<(u32, f64, f64)> {
        let ids: Vec<u32> = match set {
            Some(s) => s.iter().collect(),
            None => selections::ids_within(&self.loc_view(), None),
        };
        ids.into_iter()
            .filter_map(|id| {
                let (lat, lng) = self.coords_of(id)?;
                (lat.is_finite() && lng.is_finite()).then_some((id, lat, lng))
            })
            .collect()
    }

    /// Materialize the selected location set (`Everything` = every alive location).
    /// A named id list binary-searches each (marker click, enrich refetch ship a handful)
    /// and keeps the caller's order and duplicates; every other selector is one scan,
    /// sorted and deduped by the bitmap. O(N) time and space.
    pub(crate) fn collect(&self, selector: &Selector) -> Vec<Location> {
        if let Selector::Locations { locations, .. } = selector {
            return locations
                .iter()
                .filter_map(|&id| self.get_loc_by_id(id))
                .collect();
        }
        let view = self.loc_view();
        let resolved = selections::narrow(&view, selector);
        let mut locs = Vec::with_capacity(*self.alive_count);
        view.for_each_within(resolved.as_ref(), |row| locs.push(row.to_location()));
        locs
    }

    /// Full O(N) bounds scan, optionally narrowed to an id set. Returns the raw
    /// accumulator; callers `.resolve()` it to `[w,s,e,n]`.
    pub(super) fn scan_bounds(&self, set: Option<&RoaringBitmap>) -> Option<BoundsAcc> {
        let mut bounds = None;
        self.loc_view().for_each_within(set, |row| {
            bounds = Some(BoundsAcc::fold(bounds, row.lat(), row.lng()));
        });
        bounds
    }

    pub(crate) fn compute_bounds(&self, set: Option<&RoaringBitmap>) -> Option<[f64; 4]> {
        self.scan_bounds(set).map(BoundsAcc::resolve)
    }

    /// Whole-map bounding box, cached. Recomputes O(N) only when dirty (after a
    /// removal or bulk change); otherwise O(1). The scoring UI refreshes this on
    /// every edit, so it must not scan the whole map per mutation.
    pub(crate) fn cached_bounds(&mut self) -> Option<[f64; 4]> {
        let version = self.version;
        if !self.bounds.is_some_and(|b| b.current(version)) {
            self.bounds = Some(At::new(version, self.scan_bounds(None)));
        }
        self.bounds.and_then(|b| b.value().map(BoundsAcc::resolve))
    }

    /// Carry the bounds from `before` to the current version when this mutation can only
    /// have grown the box (added / updated-new positions, O(changed)). A removal, or an
    /// update whose OLD position sat on an edge, can shrink it, which needs the next
    /// extreme point: the bounds are left at `before` and the next read rescans.
    /// `removed` carries ids only (no coords), so any removal is conservative.
    pub(super) fn update_bounds(&mut self, changes: &ChangeSet, before: u64) {
        let Some(at) = self.bounds.filter(|b| b.current(before)) else {
            return;
        };
        if changes.full_reset || !changes.removed.is_empty() {
            return;
        }
        let mut acc = *at.value();
        if let Some(a) = acc {
            if changes
                .updated
                .iter()
                .any(|(old, _)| a.on_edge(old.lat, old.lng))
            {
                return;
            }
        }
        for (lat, lng) in changes
            .added
            .iter()
            .map(|l| (l.lat, l.lng))
            .chain(changes.updated.iter().map(|(_, nw)| (nw.lat, nw.lng)))
        {
            acc = Some(BoundsAcc::fold(acc, lat, lng));
        }
        self.bounds = Some(At::new(self.version, acc));
    }

    /// Single O(N) pass over all alive locations deriving every open-time
    /// aggregate: alive count, tag counts and sets, and the bounding box. Seeding the
    /// bbox here means the first `store_bounds` after open is an O(1) cache hit
    /// instead of a second full scan.
    pub(crate) fn scan_locations(&self) -> LocationAggregates {
        let view = self.loc_view();
        let mut tags: HashMap<u32, TagAggregate> = HashMap::new();
        let mut alive = 0usize;
        let mut bounds: Option<BoundsAcc> = None;
        view.for_each(|row| {
            alive += 1;
            bounds = Some(BoundsAcc::fold(bounds, row.lat(), row.lng()));
            let id = row.id();
            row.for_each_tag(|tid| {
                let tag = tags.entry(tid).or_insert_with(|| TagAggregate {
                    count: 0,
                    ids: RoaringBitmap::new(),
                });
                tag.count += 1;
                tag.ids.insert(id);
            });
        });
        let mut tag_counts = HashMap::with_capacity(tags.len());
        let mut tag_sets = HashMap::with_capacity(tags.len());
        for (id, tag) in tags {
            tag_counts.insert(id, tag.count);
            tag_sets.insert(id, tag.ids);
        }
        LocationAggregates {
            alive,
            tag_counts,
            tag_sets,
            bounds,
        }
    }

    /// Construct a read-only view over all alive locations for selection resolution.
    pub(crate) fn loc_view(&self) -> selections::LocView<'_> {
        selections::LocView::new(
            self.batch.as_ref(),
            &self.overlay.dead,
            &self.overlay.patches,
            &self.overlay.adds,
            Some(&self.tags.sets),
        )
    }
}
