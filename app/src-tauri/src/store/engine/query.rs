//! Read-only queries over the store: bounds, spatial lookups, spaced picks, aggregates.

use super::*;
use crate::selections::{self, Index, Selector, Thinning};
use crate::store::arrow::Columns;
use crate::store::id_set::IdSet;
use crate::store::maps::{FieldDef, IndexShape, MapMeta};
use crate::types::{AppError, AppResult, Location};
use mma_algebra::Id;
use mma_geo::{fold_lng, HexGrid, SpatialIndex, EARTH_R_M};
use std::collections::{BTreeSet, HashMap};
use std::f64::consts::PI;
use std::time::Instant;

/// ~25m cells: 1-100m queries walk a handful of cells; a 1km query walks ~80x80.
pub(crate) const SPATIAL_CELL_M: f64 = 25.0;

impl Cached for SpatialIndex {
    fn valid(&self, store: &Store) -> bool {
        self.len() == *store.alive_count
    }

    fn build(store: &Store) -> Self {
        let _t = Instant::now();
        let mut ix = SpatialIndex::new(SPATIAL_CELL_M);
        for row in store.all().rows() {
            ix.insert(row.id().get(), row.lat(), row.lng());
        }
        log::debug!(
            "[spatial] built n={} in {}ms",
            ix.len(),
            _t.elapsed().as_millis()
        );
        ix
    }

    fn slot(store: &mut Store) -> &mut Ensured<Self> {
        &mut store.spatial
    }

    fn slot_ref(store: &Store) -> &Ensured<Self> {
        &store.spatial
    }
}

impl Cached for At<Option<BoundsAcc>> {
    fn valid(&self, store: &Store) -> bool {
        self.current(store.version)
    }

    fn build(store: &Store) -> Self {
        At::new(store.version, store.all().bounds())
    }

    fn slot(store: &mut Store) -> &mut Ensured<Self> {
        &mut store.bounds
    }

    fn slot_ref(store: &Store) -> &Ensured<Self> {
        &store.bounds
    }
}

/// Everything derived from a single O(N) pass over all alive locations. Computed
/// once on map open; add new whole-map derivations here rather than scanning again.
pub(crate) struct LocationAggregates {
    pub(crate) alive: usize,
    pub(crate) bounds: Option<BoundsAcc>,
}

/// Incremental bounds using two longitude ranges to choose the shorter span.
/// Antimeridian-crossing boxes use `west > east`.
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

    /// Return `[west, south, east, north]` using the shorter longitude span.
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
pub struct SpacedPickResult {
    pub ids: Vec<Id<Location>>,
    pub distance_m: i32,
}

/// One pick per honeycomb cell: the location nearest its center, best-centered cells first,
/// skipping any location within half the spacing of one already kept.
fn even_picks(
    candidates: &[(Id<Location>, f64, f64)],
    grid: &HexGrid,
    spacing_m: f64,
) -> Vec<Id<Location>> {
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
    let mut index = SpatialIndex::new(floor);
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
    pub(super) fn coords_of(&self, id: Id<Location>) -> Option<(f64, f64)> {
        self.rows().get(id).map(|row| (row.lat(), row.lng()))
    }

    /// Read matching rows. Explicit map ids preserve request order and duplicates;
    /// other reads return unique rows sorted by id.
    pub(crate) fn collect(&mut self, target: &Target, selector: &Selector) -> Vec<Location> {
        if let (Target::Map, Selector::Locations { locations, .. }) = (target, selector) {
            return locations
                .iter()
                .filter_map(|&id| self.get_loc_by_id(id))
                .collect();
        }
        self.with_scope(target, selector, None, |scope| {
            scope.rows().map(|row| row.to_location()).collect()
        })
    }

    fn with_scope<R>(
        &mut self,
        target: &Target,
        selector: &Selector,
        ask: Option<&Ask>,
        read: impl FnOnce(selections::Scope<'_, '_>) -> R,
    ) -> R {
        match target {
            Target::Map => {
                let mut indexes = selector.indexes();
                if let Some(ask) = ask {
                    indexes.extend(ask.indexes(self.optional_fields()));
                }
                self.prepare(indexes);
                read(
                    self.rows()
                        .indexed(&self.field_indexes, self.spatial.peek())
                        .select(selector),
                )
            }
            Target::Pending { name } => {
                let pending = self.pending.get(name);
                let keys: Vec<Id<Location>> = match selector {
                    Selector::Locations { locations, .. } => locations.clone(),
                    _ => pending
                        .map(|p| p.layer.keys().collect())
                        .unwrap_or_default(),
                };
                let mut rows: Vec<Location> = keys
                    .into_iter()
                    .filter_map(|id| {
                        let below = self.get_loc_by_id(id);
                        match pending {
                            Some(p) => p
                                .layer
                                .get(id, below, |row, patch| self.applied(row, patch)),
                            None => below,
                        }
                    })
                    .collect();
                rows.sort_unstable_by_key(|row| row.id);
                rows.dedup_by_key(|row| row.id);
                let dead = IdSet::new();
                let patches = HashMap::new();
                let view = selections::LocView::new(
                    None,
                    &dead,
                    &patches,
                    &rows,
                    None,
                    Some(&self.selections.ids),
                    None,
                );
                read(view.select(selector))
            }
        }
    }

    /// Whole-map bounding box, cached. Recomputes O(N) only when stale (after a
    /// removal or bulk change); otherwise O(1). The scoring UI refreshes this on
    /// every edit, so it must not scan the whole map per mutation.
    pub(crate) fn cached_bounds(&mut self) -> Option<[f64; 4]> {
        Ensured::<At<Option<BoundsAcc>>>::with(self, |b, _| b.value().map(BoundsAcc::resolve))
    }

    /// Update cached bounds if the change can only grow them.
    /// Removals or updates at an old edge invalidate the cache for the next read.
    pub(super) fn update_bounds(&mut self, changes: &Change, before: u64) {
        let Some(at) = self.bounds.if_built_mut().filter(|b| b.current(before)) else {
            return;
        };
        if !changes.removed.is_empty() {
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
        for loc in changes.after() {
            acc = Some(BoundsAcc::fold(acc, loc.lat, loc.lng));
        }
        self.bounds.seed(At::new(self.version, acc));
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
        self.rows().all()
    }

    /// The rows `selector` resolves to: the indexes it leans on built, then narrowed once.
    pub(crate) fn scope(&mut self, selector: &Selector) -> selections::Scope<'_, '_> {
        self.prepare(selector.indexes());
        self.rows()
            .indexed(&self.field_indexes, self.spatial.peek())
            .select(selector)
    }

    /// Every selection's rows and every node's count over the whole map, each selector's
    /// indexes built first.
    pub(crate) fn resolve_forest(
        &mut self,
        sels: &[selections::Selection],
    ) -> (Vec<IdSet<Location>>, HashMap<String, u32>) {
        self.prepare(sels.iter().flat_map(|s| s.selector.indexes()));
        self.rows()
            .indexed(&self.field_indexes, self.spatial.peek())
            .resolve_forest(sels)
    }

    pub(super) fn rows(&self) -> selections::LocView<'_> {
        selections::LocView::new(
            self.batch.as_ref(),
            &self.overlay.dead,
            &self.overlay.patches,
            &self.overlay.adds,
            None,
            Some(&self.selections.ids),
            None,
        )
    }

    pub(crate) fn fields<'a>(
        &'a mut self,
        fields: impl IntoIterator<Item = &'a str>,
    ) -> Vec<FieldValues<'a>> {
        let fields: Vec<_> = fields.into_iter().collect();
        self.prepare(
            fields
                .iter()
                .map(|field| Index::Presence((*field).to_string())),
        );
        fields
            .into_iter()
            .map(|field| {
                FieldValues::new(
                    field,
                    &self.field_indexes[field],
                    self.value_meta.get(field).map(|records| &**records),
                )
            })
            .collect()
    }

    pub(super) fn reindex(&mut self, change: &Change) -> HashMap<String, BTreeSet<String>> {
        let builtins: Vec<_> = self
            .registry()
            .iter()
            .filter(|(_, def)| def.builtin.is_some())
            .map(|(key, _)| Index::Values(key.to_string()))
            .collect();
        self.prepare(builtins);
        self.field_indexes
            .iter_mut()
            .filter_map(|(field, index)| {
                let delta = index.project(change, |row| {
                    selections::RowRef::from_loc(row).resolve_field(field)
                });
                let moved = index.apply(&delta);
                (!moved.is_empty()).then_some((field.clone(), moved))
            })
            .collect()
    }

    fn prepare(&mut self, indexes: impl IntoIterator<Item = Index>) {
        let mut fields = HashMap::new();
        let mut spatial = false;
        for index in indexes {
            let (field, presence) = match index {
                Index::Presence(field) => (field, true),
                Index::Values(field) => (field, false),
                Index::Spatial => {
                    spatial = true;
                    continue;
                }
            };
            // An undeclared key is unindexable: it has no type to ask.
            let shape = self
                .registry()
                .get(&field)
                .map_or(IndexShape::None, FieldDef::index_shape);
            if (presence || shape != IndexShape::None) && !self.field_indexes.contains_key(&field) {
                fields.insert(field, shape);
            }
        }
        if spatial {
            Ensured::<SpatialIndex>::with(self, |_, _| ());
        }
        let missing: Vec<_> = fields.into_iter().collect();
        if missing.is_empty() {
            return;
        }
        let mut built: Vec<selections::FieldIndex> = missing
            .iter()
            .map(|(_, shape)| selections::FieldIndex {
                shape: *shape,
                rows: IdSet::new(),
                by_value: HashMap::new(),
            })
            .collect();
        let names: Vec<&str> = missing.iter().map(|(field, _)| field.as_str()).collect();
        for row in self.all().rows() {
            let id = row.id();
            row.resolve_fields(&names, |i, v| {
                let index = &mut built[i];
                index.insert(id, &v);
            });
        }
        for ((field, _), index) in missing.into_iter().zip(built) {
            self.field_indexes.insert(field, index);
        }
    }

    fn optional_fields(&self) -> impl Iterator<Item = String> + '_ {
        self.registry()
            .iter()
            .filter(|(_, def)| def.optional())
            .map(|(key, _)| key.to_string())
    }
}

/// Matched rows: returned inline, or as a file path to read them from.
#[derive(serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Rows {
    Inline { locations: Vec<Location> },
    File { path: String },
}

/// Above this many rows, a rows read stages a file instead of answering over IPC.
pub(crate) const ROWS_INLINE_MAX: usize = 1024;

fn rows_answer(map_id: &Id<MapMeta, String>, locations: Vec<Location>) -> AppResult<Rows> {
    if locations.len() <= ROWS_INLINE_MAX {
        return Ok(Rows::Inline { locations });
    }
    let path = rows_file_path(&crate::store::storage::temp_dir()?, map_id);
    std::fs::write(&path, serde_json::to_vec(&locations)?)?;
    Ok(Rows::File {
        path: path.to_string_lossy().into_owned(),
    })
}

/// Rotate temp-file slots to avoid collisions between concurrent row reads
/// and limit leftover files.
pub(crate) fn rows_file_path(
    temp: &std::path::Path,
    map_id: &Id<MapMeta, String>,
) -> std::path::PathBuf {
    static SLOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let slot = SLOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 8;
    temp.join(format!("mma_rows_{map_id}_{slot}.json"))
}

/// A query over selected rows.
#[derive(serde::Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Ask {
    /// Their ids: ascending, or a ranked selector's order.
    Ids,
    /// The ids a spaced pick at the root kept, with the spacing it settled on.
    Spacing,
    /// How many there are.
    Count,
    /// Every row in full.
    Rows,
    /// One column per field, `null` where a row lacks it; `tags` is a column of tag-id
    /// arrays.
    Columns { fields: Vec<String> },
    /// Distinct values of `field`, sorted.
    Values { field: String },
    /// Groups by a derived key of `field`: `{ key, ids, bin }` per group.
    GroupBy {
        field: String,
        key: selections::KeySpec,
    },
    /// Counts by a derived key of each field, with how many distinct rows the groups
    /// cover, one result per field.
    CountBy {
        fields: Vec<String>,
        key: selections::KeySpec,
    },
    /// How many rows hold a value for each field, key-sorted.
    Coverage,
    /// Bounding box `[west, south, east, north]`, or `null` when nothing matches.
    Bounds,
    /// Groups of rows within `distance` metres of each other, two or more per group.
    DuplicateGroups { distance: f64 },
    /// Per input coordinate, whether any selected row lies within `radiusM` metres.
    NearAny {
        lats: Vec<f64>,
        lngs: Vec<f64>,
        radius_m: f64,
    },
}

impl Ask {
    fn indexes(&self, fields: impl Iterator<Item = String>) -> Vec<Index> {
        match self {
            Self::Coverage => fields.map(Index::Presence).collect(),
            Self::NearAny { .. } => vec![Index::Spatial],
            Self::Ids
            | Self::Spacing
            | Self::Count
            | Self::Rows
            | Self::Columns { .. }
            | Self::Values { .. }
            | Self::GroupBy { .. }
            | Self::CountBy { .. }
            | Self::Bounds
            | Self::DuplicateGroups { .. } => Vec::new(),
        }
    }
}

/// The result of a row query.
#[derive(serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Answer {
    Ids {
        ids: Vec<Id<Location>>,
    },
    Spacing {
        ids: Vec<Id<Location>>,
        spacing_m: i32,
    },
    Count {
        count: u32,
    },
    Rows {
        rows: Rows,
    },
    Columns {
        #[specta(type = Vec<Vec<specta_typescript::Unknown>>)]
        columns: Vec<Vec<serde_json::Value>>,
    },
    Values {
        values: Vec<String>,
    },
    GroupBy {
        groups: Vec<selections::PartitionBucket>,
    },
    CountBy {
        counts: Vec<selections::CountBy>,
    },
    Coverage {
        coverage: Vec<(String, u32)>,
    },
    Bounds {
        bounds: Option<[f64; 4]>,
    },
    DuplicateGroups {
        groups: Vec<Vec<Id<Location>>>,
    },
    NearAny {
        values: Vec<bool>,
    },
}

impl Store {
    pub(crate) fn read(
        &mut self,
        target: &Target,
        selector: &Selector,
        ask: &Ask,
    ) -> AppResult<Answer> {
        if let Ask::NearAny { lats, lngs, .. } = ask {
            if lats.len() != lngs.len() {
                return Err(AppError::from("read: lats/lngs length mismatch"));
            }
        }
        if matches!(
            (target, selector, ask),
            (Target::Map, Selector::Everything, Ask::Bounds)
        ) {
            return Ok(Answer::Bounds {
                bounds: self.cached_bounds(),
            });
        }
        let map_id = self.meta.id.clone();
        let fields: Vec<String> = if matches!(ask, Ask::Coverage) {
            self.optional_fields().collect()
        } else {
            Vec::new()
        };
        let (pool, spaced) = match (selector, ask) {
            (Selector::Spaced { selection, thin }, Ask::Spacing) => (
                selection
                    .as_ref()
                    .map_or(&Selector::Everything, |s| &s.selector),
                Some((*thin, false)),
            ),
            (Selector::EvenlySpaced { selection, thin }, Ask::Spacing) => (
                selection
                    .as_ref()
                    .map_or(&Selector::Everything, |s| &s.selector),
                Some((*thin, true)),
            ),
            (_, Ask::Spacing) => {
                return Err(AppError::from("read: spacing is asked of a spaced pick"))
            }
            _ => (selector, None),
        };
        self.with_scope(target, pool, Some(ask), |scope| {
            Ok(match ask {
                Ask::Spacing => {
                    let (thin, even) = spaced.expect("spacing validated before resolve");
                    let points = scope.points();
                    let picked = if even {
                        pick_even(&points, thin)?
                    } else {
                        pick_spaced(points, thin)?
                    };
                    Answer::Spacing {
                        ids: picked.ids,
                        spacing_m: picked.distance_m,
                    }
                }
                Ask::Coverage => Answer::Coverage {
                    coverage: scope.coverage(&fields),
                },
                Ask::Bounds => Answer::Bounds {
                    bounds: scope.bounds().map(BoundsAcc::resolve),
                },
                Ask::NearAny {
                    lats,
                    lngs,
                    radius_m,
                } => Answer::NearAny {
                    values: lats
                        .iter()
                        .zip(lngs)
                        .map(|(&lat, &lng)| scope.any_within(lat, lng, *radius_m))
                        .collect(),
                },
                Ask::Ids => Answer::Ids {
                    ids: match selector {
                        Selector::Ranked {
                            expr, ascending, ..
                        } => scope.ranked(expr, None, *ascending),
                        _ => scope.rows().map(|row| row.id()).collect(),
                    },
                },
                Ask::Count => Answer::Count {
                    count: scope.rows().count() as u32,
                },
                Ask::Rows => Answer::Rows {
                    rows: rows_answer(
                        &map_id,
                        scope.rows().map(|row| row.to_location()).collect(),
                    )?,
                },
                Ask::Columns { fields } => Answer::Columns {
                    columns: scope.columns(fields),
                },
                Ask::Values { field } => Answer::Values {
                    values: scope.distinct_values(field),
                },
                Ask::GroupBy { field, key } => Answer::GroupBy {
                    groups: scope.partition(field, key),
                },
                Ask::CountBy { fields, key } => Answer::CountBy {
                    counts: scope.count_by(fields, key),
                },
                Ask::DuplicateGroups { distance } => Answer::DuplicateGroups {
                    groups: scope.duplicate_groups(*distance),
                },
            })
        })
    }

    pub(crate) fn summary(&self) -> Summary {
        Summary {
            location_count: *self.alive_count,
            version: self.version,
            dirty_count: usize::from(self.overlay.is_unsaved()),
        }
    }
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub location_count: usize,
    pub version: u64,
    pub dirty_count: usize,
}

/// Evenly spaced subset of `candidates`: a count thins to that many ids maximizing
/// spacing; a distance keeps as many as fit at that spacing.
pub(crate) fn pick_spaced(
    mut candidates: Vec<(Id<Location>, f64, f64)>,
    thin: Thinning,
) -> AppResult<SpacedPickResult> {
    match thin {
        Thinning::Metres { m } if !(m > 0.0) => {
            return Err(AppError::from(
                "pick_spaced: the distance must be greater than 0",
            ))
        }
        Thinning::Metres { m } if m > i32::MAX as f64 => {
            return Err(AppError::from("pick_spaced: the distance is too large"))
        }
        _ => {}
    }

    fastrand::shuffle(&mut candidates);

    let d = match thin {
        Thinning::Count { n } => {
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
        Thinning::Metres { m } => m.round().max(1.0) as i32,
    };
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

/// Evenly spaced subset of `candidates` on a honeycomb: a distance keeps picks about that
/// far apart and never closer than half of it; a count searches for the spacing that
/// keeps at most that many.
pub(crate) fn pick_even(
    candidates: &[(Id<Location>, f64, f64)],
    thin: Thinning,
) -> AppResult<SpacedPickResult> {
    if let Thinning::Metres { m } = thin {
        if !(m.is_finite() && m > 0.0) {
            return Err(AppError::from(
                "pick_even: the spacing must be greater than 0",
            ));
        }
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

    let goal = match thin {
        Thinning::Metres { m } => {
            return Ok(SpacedPickResult {
                ids: pick(m),
                distance_m: m.round() as i32,
            })
        }
        Thinning::Count { n } => n as usize,
    };
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
    pub(crate) fn points(&self) -> Vec<(Id<Location>, f64, f64)> {
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
