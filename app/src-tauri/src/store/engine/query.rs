//! Read-only queries over the store: bounds, spatial lookups, spaced picks, aggregates.

use super::*;
use crate::selections::{self, FilterOp, Selector};
use crate::store::arrow::Columns;
use crate::store::maps::IndexShape;
use crate::types::Location;
use crate::types::{AppError, AppResult};
use mma_geo::{fold_lng, HexGrid, EARTH_R_M};
use roaring::RoaringBitmap;
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

/// ~25m cells: 1-100m queries walk a handful of cells; a 1km query walks ~80x80.
pub(crate) const SPATIAL_CELL_M: f64 = 25.0;
use std::time::Instant;

/// Everything derived from a single O(N) pass over all alive locations. Computed
/// once on map open; add new whole-map derivations here rather than scanning again.
pub(crate) struct LocationAggregates {
    pub(crate) alive: usize,
    pub(crate) bounds: Option<BoundsAcc>,
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
    pub(crate) fn resolve(self) -> [f64; 4] {
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
        if overlay.dead.contains(id) {
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
            if let Some(idx) = Columns::of(b).row_of(id) {
                return Some((Columns::lat(b).value(idx), Columns::lng(b).value(idx)));
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
        for row in self.all().rows() {
            ix.insert(row.id(), row.lat(), row.lng());
        }
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

    /// Materialize the selected location set (`Everything` = every alive location).
    /// A named id list binary-searches each (marker click, enrich refetch ship a handful)
    /// and keeps the caller's order and duplicates; every other selector is one scan,
    /// sorted and deduped by the bitmap. O(N) time and space.
    pub(crate) fn collect(&mut self, selector: &Selector) -> Vec<Location> {
        if let Selector::Locations { locations, .. } = selector {
            return locations
                .iter()
                .filter_map(|&id| self.get_loc_by_id(id))
                .collect();
        }
        let scope = self.scope(selector);
        scope.rows().map(|row| row.to_location()).collect()
    }

    /// Whole-map bounding box, cached. Recomputes O(N) only when dirty (after a
    /// removal or bulk change); otherwise O(1). The scoring UI refreshes this on
    /// every edit, so it must not scan the whole map per mutation.
    pub(crate) fn cached_bounds(&mut self) -> Option<[f64; 4]> {
        let version = self.version;
        if !self.bounds.is_some_and(|b| b.current(version)) {
            self.bounds = Some(At::new(version, self.all().bounds()));
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

    /// Single O(N) pass over all alive locations deriving every open-time aggregate:
    /// alive count and the bounding box. Seeding the bbox here means the first
    /// `store_bounds` after open is an O(1) cache hit instead of a second full scan.
    /// Per-value counts are not here: they are the field indexes' postings.
    pub(crate) fn scan_locations(&self) -> LocationAggregates {
        let mut alive = 0usize;
        let mut bounds: Option<BoundsAcc> = None;
        for row in self.all().rows() {
            alive += 1;
            bounds = Some(BoundsAcc::fold(bounds, row.lat(), row.lng()));
        }
        LocationAggregates { alive, bounds }
    }

    /// Every alive row: the scope for walks that resolve no selector.
    pub(crate) fn all(&self) -> selections::Scope<'_, '_> {
        self.view().all()
    }

    /// The rows `selector` resolves to: the indexes it leans on built, then narrowed once.
    /// The one doorway to resolving a selector.
    pub(crate) fn scope(&mut self, selector: &Selector) -> selections::Scope<'_, '_> {
        self.ensure_indexes_for(selector);
        self.view().all().narrow(selector)
    }

    /// Every selection's rows and every node's count over the whole map, each selector's
    /// indexes built first.
    pub(crate) fn resolve_forest(
        &mut self,
        sels: &[selections::Selection],
    ) -> (Vec<RoaringBitmap>, HashMap<String, u32>) {
        for s in sels {
            self.ensure_indexes_for(&s.selector);
        }
        self.all().resolve_forest(sels)
    }

    fn view(&self) -> selections::LocView<'_> {
        selections::LocView::new(
            self.batch.as_ref(),
            &self.overlay.dead,
            &self.overlay.patches,
            &self.overlay.adds,
            Some(&self.field_indexes),
        )
    }

    /// The index shape for a field key: builtins from the field table, `extra` keys from
    /// the map's own definitions. An undeclared key is unindexable - it has no type to ask.
    pub(crate) fn index_shape_of(&self, field: &str) -> IndexShape {
        if let Some(f) = selections::BUILTIN_FIELDS.iter().find(|f| f.key == field) {
            return f.field_type.index_shape();
        }
        self.field_defs
            .get(field)
            .map_or(IndexShape::None, |d| d.field_type.index_shape())
    }

    /// Build an index for every field a selector could answer from one: the fields it
    /// tests for existence, and the enumerable fields it filters on. Reached through the
    /// selector entry points (`selector_read`, `apply_field_op`, the sync path), so
    /// resolution never meets such a field without its index; a no-op on every call
    /// after the first for a given field.
    pub(crate) fn ensure_indexes_for(&mut self, selector: &Selector) {
        fn walk(sel: &Selector, out: &mut Vec<(String, bool)>) {
            match sel {
                Selector::Filter { field, test } => out.push((
                    field.clone(),
                    matches!(test, FilterOp::Has | FilterOp::Nothas),
                )),
                Selector::Intersection { selections }
                | Selector::Union { selections }
                | Selector::Invert { selections } => {
                    for s in selections {
                        walk(&s.selector, out);
                    }
                }
                _ => {}
            }
        }
        let mut fields = Vec::new();
        walk(selector, &mut fields);
        let wanted: Vec<(String, IndexShape)> = fields
            .into_iter()
            .map(|(f, existence)| {
                let shape = self.index_shape_of(&f);
                (f, shape, existence)
            })
            .filter(|(_, shape, existence)| *existence || *shape != IndexShape::None)
            .map(|(f, shape, _)| (f, shape))
            .collect();
        self.ensure_field_indexes(&wanted);
    }

    /// Move the changed rows through every index that exists, so a value's count is its
    /// postings' cardinality with no second structure to keep in step. Returns the fields
    /// whose postings moved. Lazily-built extra indexes that were never built stay unbuilt.
    pub(super) fn reindex(
        &mut self,
        removed: &[&Location],
        added: &[&Location],
    ) -> HashSet<String> {
        // An enumerable builtin is always indexed: the engine reports its per-value
        // counts, so the postings have to exist before a row moves, not on first query.
        let enumerable: Vec<(String, IndexShape)> = selections::BUILTIN_FIELDS
            .iter()
            .map(|f| (f.key.to_string(), f.field_type.index_shape()))
            .filter(|(_, shape)| *shape != IndexShape::None)
            .collect();
        self.ensure_field_indexes(&enumerable);
        let mut moved: HashSet<String> = HashSet::new();
        for (field, index) in &mut self.field_indexes {
            let mut values_moved = false;
            for (locs, present) in [(removed, false), (added, true)] {
                for loc in locs {
                    let Some(v) = selections::RowRef::from_loc(loc).resolve_field(field) else {
                        continue;
                    };
                    let mark = |ids: &mut RoaringBitmap| {
                        if present {
                            ids.insert(loc.id);
                        } else {
                            ids.remove(loc.id);
                        }
                    };
                    mark(&mut index.rows);
                    for key in selections::index_keys(index.shape, &v) {
                        mark(index.by_value.entry(key).or_default());
                        values_moved = true;
                    }
                }
            }
            if values_moved {
                moved.insert(field.clone());
            }
        }
        moved
    }

    /// How many rows carry each value of `field`, straight off the postings. Builds the
    /// index if it has none: a count is a query like any other.
    pub(crate) fn value_counts(&mut self, field: &str) -> HashMap<String, usize> {
        let shape = self.index_shape_of(field);
        if shape == IndexShape::None {
            return HashMap::new();
        }
        self.ensure_field_indexes(&[(field.to_string(), shape)]);
        self.field_indexes
            .get(field)
            .map(|ix| {
                ix.by_value
                    .iter()
                    .map(|(k, ids)| (k.clone(), ids.len() as usize))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Rows carrying one value of `field`.
    #[allow(dead_code, reason = "exercised by tests; no production caller")]
    pub(crate) fn value_count(&mut self, field: &str, value: &str) -> usize {
        self.value_counts(field).get(value).copied().unwrap_or(0)
    }

    /// Build the index of every listed field that has none, in one pass over the rows.
    /// Every field gets the rows holding it; an enumerable one also gets its value postings.
    pub(crate) fn ensure_field_indexes(&mut self, fields: &[(String, IndexShape)]) {
        let missing: Vec<&(String, IndexShape)> = fields
            .iter()
            .filter(|(field, _)| !self.field_indexes.contains_key(field))
            .collect();
        if missing.is_empty() {
            return;
        }
        let mut built: Vec<selections::FieldIndex> = missing
            .iter()
            .map(|&&(_, shape)| selections::FieldIndex {
                shape,
                rows: RoaringBitmap::new(),
                by_value: HashMap::new(),
            })
            .collect();
        let names: Vec<&str> = missing.iter().map(|(field, _)| field.as_str()).collect();
        for row in self.all().rows() {
            let id = row.id();
            row.resolve_fields(&names, |i, v| {
                let index = &mut built[i];
                index.rows.insert(id);
                for key in selections::index_keys(index.shape, &v) {
                    index.by_value.entry(key).or_default().insert(id);
                }
            });
        }
        for ((field, _), index) in missing.into_iter().zip(built) {
            self.field_indexes.insert(field.clone(), index);
        }
    }

    /// How many rows `selector` resolves to hold a value for each field the map defines
    /// and each built-in column a row can lack, key-sorted: `has(field)` resolved in that
    /// scope. A field no row there holds is left out.
    pub(crate) fn coverage(&mut self, selector: &Selector) -> Vec<(String, u32)> {
        let fields: Vec<(String, IndexShape)> = selections::optional_builtins()
            .iter()
            .map(|k| (*k).to_string())
            .chain(self.field_defs.keys().cloned())
            .map(|k| {
                let shape = self.index_shape_of(&k);
                (k, shape)
            })
            .collect();
        self.ensure_field_indexes(&fields);
        let scope = self.scope(selector);
        let mut out: Vec<(String, u32)> = fields
            .into_iter()
            .filter_map(|(field, _)| {
                let n = scope.resolve(&Selector::has(&field)).len() as u32;
                (n > 0).then_some((field, n))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}

/// Evenly spaced subset of `candidates`: `target_count` thins to
/// N ids maximizing spacing; `min_distance_m` keeps as many as fit at that
/// spacing.
pub(crate) fn pick_spaced(
    mut candidates: Vec<(u32, f64, f64)>,
    target_count: Option<u32>,
    min_distance_m: Option<f64>,
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
        (_, Some(d)) if !(d > 0.0) => {
            return Err(AppError::from(
                "pick_spaced: min_distance_m must be greater than 0",
            ))
        }
        (_, Some(d)) if d > i32::MAX as f64 => {
            return Err(AppError::from("pick_spaced: min_distance_m too large"))
        }
        _ => {}
    }

    fastrand::shuffle(&mut candidates);

    if let Some(n) = target_count {
        if n as usize >= candidates.len() {
            return Ok(SpacedPickResult {
                ids: candidates.iter().map(|c| c.0).collect(),
                distance_m: 0,
            });
        }
        let coords: Vec<(f64, f64)> = candidates.iter().map(|c| (c.1, c.2)).collect();
        let (idxs, distance_m) = vali_geo::with_max_min_distance(&coords, n as usize, None, &[]);
        let ids = idxs.into_iter().map(|i| candidates[i as usize].0).collect();
        return Ok(SpacedPickResult { ids, distance_m });
    }

    let d = min_distance_m.unwrap().round().max(1.0) as i32;
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

/// Evenly spaced subset of `candidates` on a honeycomb: `spacing_m` keeps
/// picks about that far apart and never closer than half of it; `target_count` searches
/// for the spacing that keeps at most N.
pub(crate) fn pick_even(
    candidates: &[(u32, f64, f64)],
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
    let pick = |spacing: f64| even_picks(candidates, &HexGrid::new(lat, lng, spacing), spacing);

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

impl selections::Scope<'_, '_> {
    /// The rows in scope with finite coordinates, as `(id, lat, lng)`.
    pub(crate) fn points(&self) -> Vec<(u32, f64, f64)> {
        self.rows()
            .map(|row| (row.id(), row.lat(), row.lng()))
            .filter(|&(_, lat, lng)| lat.is_finite() && lng.is_finite())
            .collect()
    }

    /// The box around every row in scope, before it is resolved to `[w,s,e,n]`.
    pub(crate) fn bounds(&self) -> Option<BoundsAcc> {
        self.rows().fold(None, |acc, row| {
            Some(BoundsAcc::fold(acc, row.lat(), row.lng()))
        })
    }
}
