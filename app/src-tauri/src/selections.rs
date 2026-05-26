use std::collections::{HashMap, HashSet};
use arrow::array::{RecordBatch, StringArray, Float64Array, UInt32Array, ListArray, Array};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use crate::types::Location;

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum SelectionProps {
    Locations { locations: Vec<u32>, name: Option<String> },
    Everything,
    #[serde(rename_all = "camelCase")]
    Polygon { polygon: PolygonGeometry, #[serde(rename = "includeInformational")] include_informational: bool },
    Tag { #[serde(rename = "tagId")] tag_id: u32 },
    Untagged,
    Unpanned,
    PanoIds,
    NotPanoIds,
    Manual { locations: Vec<u32> },
    Duplicates { distance: f64 },
    ValidationState { locations: Vec<u32>, state: u8 },
    Intersection { selections: Vec<Selection> },
    Union { selections: Vec<Selection> },
    Invert { selections: Vec<Selection> },
    Filter { field: String, op: String, #[specta(type = specta_typescript::Any)] value: serde_json::Value, #[specta(type = Option<specta_typescript::Any>)] value2: Option<serde_json::Value> },
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PolygonGeometry {
    pub coordinates: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub extra_polygons: Option<Vec<Vec<Vec<[f64; 2]>>>>,
    #[serde(default)]
    #[specta(type = Option<specta_typescript::Any>)]
    pub properties: Option<serde_json::Value>,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub key: String,
    pub color: [u8; 3],
    pub props: SelectionProps,
    /// JS-only: cached resolved count for sidebar display. Rust never sets this.
    #[serde(default)]
    pub count: Option<u32>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSummary {
    pub key: String,
    pub color: [u8; 3],
    #[serde(rename = "type")]
    pub sel_type: String,
    pub count: usize,
}

// ---------------------------------------------------------------------------
// LocView: unified view over Arrow batch + overlay
// ---------------------------------------------------------------------------

/// Unified read-only view over Arrow batch + overlay (dead, patches, adds).
/// Caches column downcast refs on construction to avoid repeated downcasts.
pub struct LocView<'a> {
    batch: Option<&'a RecordBatch>,
    dead: &'a HashSet<u32>,
    patches: &'a HashMap<u32, Location>,
    adds: &'a [Location],
    // Cached column refs (from batch)
    ids: Option<&'a UInt32Array>,
    lats: Option<&'a Float64Array>,
    lngs: Option<&'a Float64Array>,
    headings: Option<&'a Float64Array>,
    pitches: Option<&'a Float64Array>,
    zooms: Option<&'a Float64Array>,
    flags: Option<&'a UInt32Array>,
    tags: Option<&'a ListArray>,
    extras: Option<&'a StringArray>,
    created_ats: Option<&'a StringArray>,
    modified_ats: Option<&'a StringArray>,
    batch_rows: usize,
    has_dead: bool,
    has_patches: bool,
}

impl<'a> LocView<'a> {
    pub fn new(
        batch: Option<&'a RecordBatch>,
        dead: &'a HashSet<u32>,
        patches: &'a HashMap<u32, Location>,
        adds: &'a [Location],
    ) -> Self {
        let batch_rows = batch.map_or(0, |b| b.num_rows());
        let ids = batch.map(|b| b.column(0).as_any().downcast_ref::<UInt32Array>().unwrap());
        let lats = batch.map(|b| b.column(1).as_any().downcast_ref::<Float64Array>().unwrap());
        let lngs = batch.map(|b| b.column(2).as_any().downcast_ref::<Float64Array>().unwrap());
        let headings = batch.map(|b| b.column(3).as_any().downcast_ref::<Float64Array>().unwrap());
        let pitches = batch.map(|b| b.column(4).as_any().downcast_ref::<Float64Array>().unwrap());
        let zooms = batch.map(|b| b.column(5).as_any().downcast_ref::<Float64Array>().unwrap());
        let flags = batch.map(|b| b.column(7).as_any().downcast_ref::<UInt32Array>().unwrap());
        let tags = batch.map(|b| b.column(8).as_any().downcast_ref::<ListArray>().unwrap());
        let extras = batch.map(|b| b.column(9).as_any().downcast_ref::<StringArray>().unwrap());
        let created_ats = batch.map(|b| b.column(10).as_any().downcast_ref::<StringArray>().unwrap());
        let modified_ats = batch.map(|b| b.column(11).as_any().downcast_ref::<StringArray>().unwrap());
        let has_dead = !dead.is_empty();
        let has_patches = !patches.is_empty();
        Self { batch, dead, patches, adds, ids, lats, lngs, headings, pitches, zooms, flags, tags, extras, created_ats, modified_ats, batch_rows, has_dead, has_patches }
    }

    pub fn len(&self) -> usize {
        self.batch_rows + self.adds.len()
    }

    pub fn batch_rows(&self) -> usize { self.batch_rows }
    pub fn adds(&self) -> &[Location] { self.adds }

    pub fn batch_id(&self, i: usize) -> u32 { self.ids.unwrap().value(i) }

    #[inline]
    pub fn is_alive(&self, i: usize) -> bool {
        !self.has_dead || !self.dead.contains(&self.batch_id(i))
    }

    #[inline]
    pub fn patch_at(&self, i: usize) -> Option<&Location> {
        if !self.has_patches { return None; }
        self.patches.get(&self.batch_id(i))
    }

    pub fn id_at(&self, i: usize) -> u32 {
        if self.has_patches {
            if let Some(p) = self.patches.get(&self.batch_id(i)) { return p.id; }
        }
        self.batch_id(i)
    }

    /// Map each selected location ID to its selection index (last writer wins). O(S * N).
    pub fn collect_id_to_selection(&self, masks: &[Vec<bool>]) -> HashMap<u32, usize> {
        let mut id_to_sel: HashMap<u32, usize> = HashMap::new();
        for (si, mask) in masks.iter().enumerate() {
            for i in 0..self.batch_rows {
                if mask[i] && self.is_alive(i) {
                    id_to_sel.insert(self.id_at(i), si);
                }
            }
            for (j, loc) in self.adds.iter().enumerate() {
                if mask[self.batch_rows + j] {
                    id_to_sel.insert(loc.id, si);
                }
            }
        }
        id_to_sel
    }

    /// Collect all selected IDs and their colors (last selection wins). O(S * N).
    pub fn collect_selected_ids(&self, masks: &[Vec<bool>], colors: &[[u8; 3]]) -> (HashSet<u32>, HashMap<u32, [u8; 3]>) {
        let mut all_selected = HashSet::new();
        let mut color_map = HashMap::new();
        for (si, mask) in masks.iter().enumerate() {
            let color = colors[si];
            for i in 0..self.batch_rows {
                if mask[i] {
                    let id = self.id_at(i);
                    color_map.insert(id, color);
                    all_selected.insert(id);
                }
            }
            for (j, loc) in self.adds.iter().enumerate() {
                if mask[self.batch_rows + j] {
                    color_map.insert(loc.id, color);
                    all_selected.insert(loc.id);
                }
            }
        }
        (all_selected, color_map)
    }

    /// Build a bool mask over all locations (batch + adds) using per-row predicates.
    /// Batch rows are scanned in parallel with rayon. O(N) with parallel speedup.
    pub fn resolve_mask(
        &self,
        batch_test: impl Fn(usize) -> bool + Sync + Send,
        add_test: impl Fn(usize, &Location) -> bool,
    ) -> Vec<bool> {
        let mut mask: Vec<bool> = (0..self.batch_rows)
            .into_par_iter()
            .with_min_len(CHUNK_SIZE)
            .map(|i| self.is_alive(i) && batch_test(i))
            .collect();
        mask.extend(self.adds.iter().enumerate().map(|(j, loc)| add_test(j, loc)));
        mask
    }

    /// Map each LocView index to its render index (or -1 if not rendered). O(N).
    pub fn build_render_lookup(&self, render_id_to_index: &HashMap<u32, usize>) -> Vec<i32> {
        let n = self.batch_rows + self.adds.len();
        let mut lookup = vec![-1i32; n];
        for i in 0..self.batch_rows {
            if !self.is_alive(i) { continue; }
            let id = self.id_at(i);
            if let Some(&ri) = render_id_to_index.get(&id) {
                lookup[i] = ri as i32;
            }
        }
        for (j, loc) in self.adds.iter().enumerate() {
            if let Some(&ri) = render_id_to_index.get(&loc.id) {
                lookup[self.batch_rows + j] = ri as i32;
            }
        }
        lookup
    }
}

// ---------------------------------------------------------------------------
// Bitmask resolve
// ---------------------------------------------------------------------------

const LOAD_AS_PANO_ID: u32 = 1;
const INFORMATIONAL: u32 = 2;

// Per-row test function for batch rows -- returns true if the row matches the selection.
// Must be safe to call from multiple threads (reads only shared Arrow columns + overlay refs).
fn test_batch_row(view: &LocView, i: usize, props: &SelectionProps) -> bool {
    match props {
        SelectionProps::Everything => true,
        SelectionProps::Locations { locations, .. }
        | SelectionProps::Manual { locations }
        | SelectionProps::ValidationState { locations, .. } => {
            let id = view.id_at(i);
            locations.contains(&id)
        }
        SelectionProps::Tag { tag_id } => {
            if let Some(p) = view.patch_at(i) {
                p.tags.contains(tag_id)
            } else {
                let list = view.tags.unwrap().value(i);
                let ids = list.as_any().downcast_ref::<UInt32Array>().unwrap();
                (0..ids.len()).any(|k| ids.value(k) == *tag_id)
            }
        }
        SelectionProps::Untagged => {
            if let Some(p) = view.patch_at(i) { p.tags.is_empty() }
            else { view.tags.unwrap().value(i).is_empty() }
        }
        SelectionProps::Unpanned => {
            if let Some(p) = view.patch_at(i) { p.heading == 0.0 }
            else { view.headings.unwrap().value(i) == 0.0 }
        }
        SelectionProps::PanoIds => {
            if let Some(p) = view.patch_at(i) { p.flags & LOAD_AS_PANO_ID != 0 }
            else { view.flags.unwrap().value(i) & LOAD_AS_PANO_ID != 0 }
        }
        SelectionProps::NotPanoIds => {
            if let Some(p) = view.patch_at(i) { p.flags & LOAD_AS_PANO_ID == 0 }
            else { view.flags.unwrap().value(i) & LOAD_AS_PANO_ID == 0 }
        }
        SelectionProps::Polygon { polygon, include_informational } => {
            if let Some(p) = view.patch_at(i) {
                if !include_informational && (p.flags & INFORMATIONAL != 0) { return false; }
                point_in_geometry(p.lng, p.lat, polygon)
            } else {
                if !include_informational && (view.flags.unwrap().value(i) & INFORMATIONAL != 0) { return false; }
                point_in_geometry(view.lngs.unwrap().value(i), view.lats.unwrap().value(i), polygon)
            }
        }
        SelectionProps::Filter { field, op, value, value2 } => {
            if let Some(p) = view.patch_at(i) {
                matches_filter_loc(p, field, op, value, value2.as_ref())
            } else {
                matches_filter_arrow(view, i, field, op, value, value2.as_ref())
            }
        }
        _ => false, // composites handled separately
    }
}

pub(crate) fn test_add_row(loc: &Location, props: &SelectionProps) -> bool {
    match props {
        SelectionProps::Everything => true,
        SelectionProps::Locations { locations, .. }
        | SelectionProps::Manual { locations }
        | SelectionProps::ValidationState { locations, .. } => {
            locations.contains(&loc.id)
        }
        SelectionProps::Tag { tag_id } => loc.tags.contains(tag_id),
        SelectionProps::Untagged => loc.tags.is_empty(),
        SelectionProps::Unpanned => loc.heading == 0.0,
        SelectionProps::PanoIds => loc.flags & LOAD_AS_PANO_ID != 0,
        SelectionProps::NotPanoIds => loc.flags & LOAD_AS_PANO_ID == 0,
        SelectionProps::Polygon { polygon, include_informational } => {
            if !include_informational && (loc.flags & INFORMATIONAL != 0) { return false; }
            point_in_geometry(loc.lng, loc.lat, polygon)
        }
        SelectionProps::Filter { field, op, value, value2 } => {
            matches_filter_loc(loc, field, op, value, value2.as_ref())
        }
        _ => false,
    }
}

const CHUNK_SIZE: usize = 64 * 1024;

/// Resolve a selection into a bool mask. O(N) for simple selections (parallel),
/// O(N^2) for Duplicates (grid-accelerated), O(S*N) for composites (S children).
pub fn resolve_bitmask(view: &LocView, props: &SelectionProps) -> Vec<bool> {
    let n = view.batch_rows + view.adds.len();

    match props {
        SelectionProps::Locations { locations, .. }
        | SelectionProps::Manual { locations }
        | SelectionProps::ValidationState { locations, .. } => {
            let set: HashSet<u32> = locations.iter().copied().collect();
            return view.resolve_mask(|i| set.contains(&view.id_at(i)), |_, loc| set.contains(&loc.id));
        }
        SelectionProps::Duplicates { distance } => {
            let mut mask = vec![false; n];
            find_duplicates_bitmask(view, *distance, &mut mask);
            return mask;
        }
        SelectionProps::Intersection { selections } => {
            if selections.is_empty() { return vec![false; n]; }
            let mut mask = resolve_bitmask(view, &selections[0].props);
            for s in &selections[1..] {
                let other = resolve_bitmask(view, &s.props);
                mask.par_iter_mut().zip(other.par_iter()).for_each(|(m, o)| *m = *m && *o);
            }
            return mask;
        }
        SelectionProps::Union { selections } => {
            let mut mask = vec![false; n];
            for s in selections {
                let other = resolve_bitmask(view, &s.props);
                mask.par_iter_mut().zip(other.par_iter()).for_each(|(m, o)| *m = *m || *o);
            }
            return mask;
        }
        SelectionProps::Invert { selections } => {
            if selections.is_empty() {
                let mut mask = vec![true; n];
                if view.has_dead {
                    for i in 0..view.batch_rows { if !view.is_alive(i) { mask[i] = false; } }
                }
                return mask;
            }
            let inner = resolve_bitmask(view, &selections[0].props);
            return view.resolve_mask(|i| !inner[i], |j, _| !inner[view.batch_rows + j]);
        }
        _ => {}
    }

    view.resolve_mask(|i| test_batch_row(view, i, props), |_, loc| test_add_row(loc, props))
}

pub fn mask_to_ids(view: &LocView, mask: &[bool]) -> Vec<u32> {
    let mut ids = Vec::new();
    for i in 0..view.batch_rows {
        if mask[i] {
            ids.push(view.id_at(i));
        }
    }
    for (j, loc) in view.adds.iter().enumerate() {
        if mask[view.batch_rows + j] {
            ids.push(loc.id);
        }
    }
    ids
}

/// Resolve a selection to a Vec of matching location IDs. O(N) + allocation.
pub fn resolve(view: &LocView, props: &SelectionProps) -> Vec<u32> {
    let mask = resolve_bitmask(view, props);
    mask_to_ids(view, &mask)
}

// --- Geometry ---

fn point_in_ring(lng: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (xi, yi) = (ring[i][0], ring[i][1]);
        let (xj, yj) = (ring[j][0], ring[j][1]);
        if ((yi > lat) != (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn point_in_polygon(lng: f64, lat: f64, coords: &[Vec<[f64; 2]>]) -> bool {
    if coords.is_empty() { return false; }
    if !point_in_ring(lng, lat, &coords[0]) { return false; }
    for hole in coords.iter().skip(1) {
        if point_in_ring(lng, lat, hole) { return false; }
    }
    true
}

fn point_in_geometry(lng: f64, lat: f64, geom: &PolygonGeometry) -> bool {
    if point_in_polygon(lng, lat, &geom.coordinates) { return true; }
    if let Some(extras) = &geom.extra_polygons {
        for poly in extras {
            if point_in_polygon(lng, lat, poly) { return true; }
        }
    }
    false
}

// --- Duplicates (bitmask version) ---

/// Grid-accelerated spatial duplicate detection. O(N) average with uniform distribution,
/// O(N^2) worst case if all points fall in one grid cell.
fn find_duplicates_bitmask(view: &LocView, distance_m: f64, mask: &mut [bool]) {
    let cell_deg = distance_m / 111_000.0 * 1.5;

    struct Pt { lat: f64, lng: f64, global_idx: usize }
    let mut points = Vec::new();

    for i in 0..view.batch_rows {
        if !view.is_alive(i) { continue; }
        if let Some(p) = view.patch_at(i) {
            points.push(Pt { lat: p.lat, lng: p.lng, global_idx: i });
        } else {
            points.push(Pt { lat: view.lats.unwrap().value(i), lng: view.lngs.unwrap().value(i), global_idx: i });
        }
    }
    for (j, loc) in view.adds.iter().enumerate() {
        points.push(Pt { lat: loc.lat, lng: loc.lng, global_idx: view.batch_rows + j });
    }

    let n = points.len();
    if n < 2 { return; }

    let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (pi, pt) in points.iter().enumerate() {
        let cx = (pt.lng / cell_deg).floor() as i32;
        let cy = (pt.lat / cell_deg).floor() as i32;
        grid.entry((cx, cy)).or_default().push(pi);
    }

    let mut in_group = vec![false; n];
    for pi in 0..n {
        if in_group[pi] { continue; }
        let pt = &points[pi];
        let cx = (pt.lng / cell_deg).floor() as i32;
        let cy = (pt.lat / cell_deg).floor() as i32;
        let mut found_dup = false;
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(cell) = grid.get(&(cx + dx, cy + dy)) {
                    for &pj in cell {
                        if pj <= pi || in_group[pj] { continue; }
                        if haversine_m(pt.lat, pt.lng, points[pj].lat, points[pj].lng) <= distance_m {
                            in_group[pj] = true;
                            mask[points[pj].global_idx] = true;
                            found_dup = true;
                        }
                    }
                }
            }
        }
        if found_dup { mask[pt.global_idx] = true; }
    }
}

pub(crate) fn haversine_m(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlng = (lng2 - lng1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlng / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

// --- Filter ---

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

fn unix_to_month_day(ts: f64) -> (u32, u32) {
    let days = (ts / 86400.0).floor() as i64;
    let (_, m, d) = civil_from_days(days);
    (m, d)
}

fn iso_to_unix(s: &str) -> Option<f64> {
    let s = s.trim_end_matches('Z');
    let (date_part, time_part) = s.split_once('T')?;
    let mut dp = date_part.splitn(3, '-');
    let y: i64 = dp.next()?.parse().ok()?;
    let m: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    let mut tp = time_part.split(':');
    let h: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec_str = tp.next().unwrap_or("0");
    let sec: i64 = sec_str.split('.').next()?.parse().ok()?;
    fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y.rem_euclid(400);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }
    Some((days_from_civil(y, m, d) * 86400 + h * 3600 + min * 60 + sec) as f64)
}

fn resolve_field_loc(loc: &Location, field: &str) -> Option<serde_json::Value> {
    match field {
        "lat" => Some(serde_json::json!(loc.lat)),
        "lng" => Some(serde_json::json!(loc.lng)),
        "heading" => Some(serde_json::json!(loc.heading)),
        "pitch" => Some(serde_json::json!(loc.pitch)),
        "zoom" => Some(serde_json::json!(loc.zoom)),
        "id" => Some(serde_json::json!(loc.id)),
        "createdAt" => iso_to_unix(&loc.created_at).map(|ts| serde_json::json!(ts)),
        "modifiedAt" => loc.modified_at.as_deref().and_then(iso_to_unix).map(|ts| serde_json::json!(ts)),
        _ => loc.extra.as_ref().and_then(|e| e.get(field).cloned()),
    }
}

fn matches_filter_loc(
    loc: &Location,
    field: &str, op: &str, value: &serde_json::Value, value2: Option<&serde_json::Value>,
) -> bool {
    match resolve_field_loc(loc, field) {
        Some(ref v) => compare_filter(v, op, value, value2),
        None => op == "neq" || op == "nothas",
    }
}

fn resolve_field_arrow(view: &LocView, idx: usize, field: &str) -> Option<serde_json::Value> {
    match field {
        "lat" => view.lats.map(|c| serde_json::json!(c.value(idx))),
        "lng" => view.lngs.map(|c| serde_json::json!(c.value(idx))),
        "heading" => view.headings.map(|c| serde_json::json!(c.value(idx))),
        "pitch" => view.pitches.map(|c| serde_json::json!(c.value(idx))),
        "zoom" => view.zooms.map(|c| serde_json::json!(c.value(idx))),
        "id" => view.ids.map(|c| serde_json::json!(c.value(idx))),
        "createdAt" => view.created_ats.and_then(|c| iso_to_unix(c.value(idx))).map(|ts| serde_json::json!(ts)),
        "modifiedAt" => view.modified_ats.and_then(|c| {
            if c.is_null(idx) { return None; }
            iso_to_unix(c.value(idx))
        }).map(|ts| serde_json::json!(ts)),
        _ => {
            let extras = view.extras?;
            if extras.is_null(idx) { return None; }
            let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(extras.value(idx)).ok()?;
            map.get(field).cloned()
        }
    }
}

fn matches_filter_arrow(
    view: &LocView, idx: usize,
    field: &str, op: &str, value: &serde_json::Value, value2: Option<&serde_json::Value>,
) -> bool {
    match resolve_field_arrow(view, idx, field) {
        Some(ref v) => compare_filter(v, op, value, value2),
        None => op == "neq" || op == "nothas",
    }
}

fn compare_filter(field_val: &serde_json::Value, op: &str, value: &serde_json::Value, value2: Option<&serde_json::Value>) -> bool {
    match op {
        "eq" => val_eq(field_val, value),
        "neq" => !val_eq(field_val, value),
        "has" => true,
        "nothas" => false,
        "gt" | "lt" | "gte" | "lte" | "between" => {
            let fv = as_f64(field_val);
            let cv = as_f64(value);
            match (fv, cv) {
                (Some(a), Some(b)) => match op {
                    "gt" => a > b,
                    "lt" => a < b,
                    "gte" => a >= b,
                    "lte" => a <= b,
                    "between" => {
                        let upper = value2.and_then(as_f64).unwrap_or(f64::MAX);
                        a >= b && a <= upper
                    }
                    _ => false,
                },
                _ => {
                    let fs = field_val.as_str().unwrap_or("");
                    let vs = value.as_str().unwrap_or("");
                    match op {
                        "gt" => fs > vs,
                        "lt" => fs < vs,
                        "gte" => fs >= vs,
                        "lte" => fs <= vs,
                        "between" => {
                            let upper = value2.and_then(|v| v.as_str()).unwrap_or("");
                            fs >= vs && fs <= upper
                        }
                        _ => false,
                    }
                }
            }
        }
        "between_anyyear" => {
            let lo = value.as_str().unwrap_or("");
            let hi = value2.and_then(|v| v.as_str()).unwrap_or("12-31");
            let fv_md = if let Some(ts) = as_f64(field_val) {
                let (m, d) = unix_to_month_day(ts);
                format!("{:02}-{:02}", m, d)
            } else if let Some(s) = field_val.as_str() {
                if s.len() >= 7 && s.as_bytes()[4] == b'-' {
                    if s.len() >= 10 { s[5..10].to_string() } else { format!("{}-01", &s[5..7]) }
                } else {
                    return false;
                }
            } else {
                return false;
            };
            if lo <= hi {
                fv_md.as_str() >= lo && fv_md.as_str() <= hi
            } else {
                fv_md.as_str() >= lo || fv_md.as_str() <= hi
            }
        }
        _ => false,
    }
}

fn val_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    if a == b { return true; }
    // Cross-type: compare string representations (e.g. Number(2) vs String("2"))
    let sa = match a { serde_json::Value::String(s) => s.as_str().into(), _ => None };
    let sb = match b { serde_json::Value::String(s) => s.as_str().into(), _ => None };
    match (sa, sb) {
        (Some(s), None) => s == *b,
        (None, Some(s)) => *a == s,
        _ => false,
    }
}

fn as_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

#[cfg(test)]
#[path = "selections.test.rs"]
mod tests;
