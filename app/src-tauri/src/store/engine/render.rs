//! Cell render buffers: geohash binning, the wire format JS parses into `CellManager`, and the per-mutation deltas.

use super::*;
use crate::store::arrow;
use crate::store::arrow::{col_heading, col_id, col_lat, col_lng};
use roaring::RoaringBitmap;
use std::array;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// Standard base-32 alphabet (Gustavo Niemeyer geohash variant); render cells are
/// keyed by its first character.
pub(super) const BASE32: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";

/// Compute the render cell index (0-31) directly from coordinates. This is the
/// first base-32 character of the point's geohash, computed without allocating.
pub(crate) fn render_cell_idx(lat: f64, lng: f64) -> u8 {
    let (mut min_lat, mut max_lat) = (-90.0, 90.0);
    let (mut min_lng, mut max_lng) = (-180.0, 180.0);
    let mut ch: u8 = 0;
    let mut even = true;
    for _ in 0..5 {
        if even {
            let mid = (min_lng + max_lng) / 2.0;
            if lng >= mid {
                ch = (ch << 1) | 1;
                min_lng = mid;
            } else {
                ch <<= 1;
                max_lng = mid;
            }
        } else {
            let mid = (min_lat + max_lat) / 2.0;
            if lat >= mid {
                ch = (ch << 1) | 1;
                min_lat = mid;
            } else {
                ch <<= 1;
                max_lat = mid;
            }
        }
        even = !even;
    }
    ch
}

/// Convert a cell index (0-31) back to its single-character base-32 key.
pub(super) fn cell_key_from_idx(idx: u8) -> String {
    String::from(BASE32[idx as usize] as char)
}

/// Reverse lookup: parse a single-character cell key to its 0-31 index.
pub(crate) fn cell_idx_from_key(key: &str) -> Option<u8> {
    let b = *key.as_bytes().first()?;
    BASE32.iter().position(|&c| c == b).map(|i| i as u8)
}

/// Assemble the selection-bitmask wire buffer shared by sync/delta/rebuild:
/// `[numSels: u32 le][numSels * RGB][numCells: u8][segments...]`.
/// The count is u32 so thousands of selections (e.g. shift-selecting many tags)
/// don't wrap the header and desync the JS parser.
pub(super) fn assemble_selection_bitmask<'a>(
    colors: impl ExactSizeIterator<Item = &'a [u8; 3]>,
    segments: &[Vec<u8>],
) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(&(colors.len() as u32).to_le_bytes());
    for c in colors {
        buf.extend_from_slice(c);
    }
    buf.push(segments.len() as u8);
    for seg in segments {
        buf.extend_from_slice(seg);
    }
    buf
}

/// Route one selection's id-set to per-cell local render indices. Adaptive so the cost
/// is O(min(set size, render size)) rather than O(render size) per selection: sparse sets
/// walk their members and probe `id_to_cell_idx`/`id_to_index`; dense sets (where
/// member-walking would do the same work anyway) scan the cell arrays directly.
pub(super) fn selection_cell_indices(
    render: &RenderState,
    render_size: usize,
    set: &RoaringBitmap,
) -> [Vec<u32>; 32] {
    let mut out: [Vec<u32>; 32] = array::from_fn(|_| Vec::new());
    if (set.len() as usize) <= render_size {
        for id in set {
            let Some(&ci) = render.id_to_cell_idx.get(id as usize) else {
                continue;
            };
            if ci == 255 {
                continue;
            }
            let Some(cr) = render.cells[ci as usize].as_ref() else {
                continue;
            };
            if let Some(&li) = cr.id_to_index.get(&id) {
                out[ci as usize].push(li as u32);
            }
        }
    } else {
        for (ci, opt) in render.cells.iter().enumerate() {
            let Some(cr) = opt.as_ref() else { continue };
            for (li, &id) in cr.id_order.iter().enumerate() {
                if set.contains(id) {
                    out[ci].push(li as u32);
                }
            }
        }
    }
    out
}

/// Serialize one render cell's segment from pre-routed per-selection indices:
/// `[cellChar:1][locCount:u32 le][ per selection: fmt byte + payload ]`.
/// Pure/read-only, so the 32 cells can be serialized in parallel.
pub(super) fn serialize_cell_segment(
    ci: usize,
    cr: &CellRender,
    per_sel: &[[Vec<u32>; 32]],
) -> Vec<u8> {
    let n = cr.id_order.len();
    let mask_bytes = n.div_ceil(8);
    let mut seg = Vec::new();
    seg.push(BASE32[ci]);
    seg.extend_from_slice(&(n as u32).to_le_bytes());
    // Per selection, emit one of two self-describing formats (format byte first):
    //   1 = index-list: u32 count + count*u32 selected local indices, unordered (sparse → O(selected))
    //   0 = bitmask:    mask_bytes raw bits (dense → smaller than an index list)
    // The index-list lets JS rebuild the overlay in O(selected) instead of scanning N bits.
    for sel_cells in per_sel {
        let indices = &sel_cells[ci];
        if indices.len() * 4 + 4 < mask_bytes {
            seg.push(1u8);
            seg.extend_from_slice(&(indices.len() as u32).to_le_bytes());
            for idx in indices {
                seg.extend_from_slice(&idx.to_le_bytes());
            }
        } else {
            seg.push(0u8);
            let mut bitmask = vec![0u8; mask_bytes];
            for &li in indices {
                bitmask[li as usize / 8] |= 1 << (li % 8);
            }
            seg.extend_from_slice(&bitmask);
        }
    }
    seg
}

/// Build the selection-bitmask wire buffer for `sels` against the current render cells:
/// route each selection to per-cell local indices, serialize the cells, assemble. Returns
/// the buffer and the number of cells it covers. The only place those steps are sequenced.
/// Cells and selections are independent, so both passes go parallel.
pub(crate) fn build_selection_buf(
    render: &RenderState,
    sels: &[ResolvedSelection],
) -> (Vec<u8>, usize) {
    let render_total = render.total_len();
    let routed: Vec<[Vec<u32>; 32]> = sels
        .par_iter()
        .map(|r| selection_cell_indices(render, render_total, &r.set))
        .collect();
    let segments: Vec<Vec<u8>> = render
        .cells
        .par_iter()
        .enumerate()
        .filter_map(|(ci, opt)| {
            let cr = opt.as_ref()?;
            Some(serialize_cell_segment(ci, cr, &routed))
        })
        .collect();
    let num_cells = segments.len();
    let buf = assemble_selection_bitmask(sels.iter().map(|r| &r.sel.color), &segments);
    (buf, num_cells)
}

/// Per-cell render index: maps location IDs to their position within a cell's typed arrays.
/// `id_order` is the authoritative ordering; `id_to_index` provides O(1) reverse lookup.
/// Swap-remove semantics keep removals O(1) at the cost of reordering the last element.
pub(crate) struct CellRender {
    pub id_order: Vec<u32>,
    pub id_to_index: HashMap<u32, usize>,
}

pub(crate) struct RenderState {
    pub cells: [Option<CellRender>; 32],
    pub id_to_cell_idx: Vec<u8>,
    pub arrow_style: bool,
    pub marker_color: [u8; 3],
}

impl RenderState {
    /// Total rendered marker count across all cells.
    pub(crate) fn total_len(&self) -> usize {
        self.cells
            .iter()
            .filter_map(|o| o.as_ref())
            .map(|cr| cr.id_order.len())
            .sum()
    }
}

/// Incremental render update sent to JS after a mutation: adds, patches, and removals.
/// Every entry states the row's resulting selection state, so applying a delta is
/// idempotent and the base cells and the selection overlay cannot drift apart.
/// `full_reset` signals JS to discard all cell data and re-fetch via `store_fill_render_file`.
#[derive(serde::Serialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderDelta {
    pub added: Vec<RenderEntry>,
    pub updated: Vec<RenderPatchEntry>,
    pub removed: Vec<CellRemoval>,
    pub full_reset: bool,
}

/// The selection drawing a row: its colour, and its index in `SelectionState::resolved`.
/// The index is the draw order — a later selection overdraws an earlier one — so the
/// overlay can be ordered by it instead of by whatever order rows happen to arrive in.
/// Every marker sits at z=0 in one deck.gl layer, so buffer order is the only z there is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelPaint {
    pub idx: u32,
    pub color: [u8; 3],
}

/// A marker appended to a render cell: position, heading, and selection state.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderEntry {
    pub cell: String,
    pub id: u32,
    pub lng: f32,
    pub lat: f32,
    pub heading: f32,
    /// `None` = drawn by the base layer, `Some(paint)` = drawn by the selection overlay.
    pub sel: Option<SelPaint>,
    /// The slot this row vacated when it crossed cells. Present only for a move, so JS
    /// mirrors the swap-remove and carries the overlay entry across instead of inferring
    /// a move from an unrelated removed/added pair.
    pub moved_from: Option<CellRemoval>,
}

/// Update to an existing marker within its cell. Position and heading are `None` when
/// unchanged; `sel` always states the row's current selection state, so a membership
/// change with no movement is just a patch with no coordinates.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPatchEntry {
    pub cell: String,
    pub cell_index: usize,
    pub lng: Option<f32>,
    pub lat: Option<f32>,
    pub heading: Option<f32>,
    pub sel: Option<SelPaint>,
}

/// A swap-removal from a render cell. JS must move the last element into `cell_index`
/// and pop the array to mirror the Rust-side swap-remove.
#[derive(serde::Serialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CellRemoval {
    pub cell: String,
    pub cell_index: usize,
    pub id: u32,
}

/// Parameters for a full render rebuild. `marker_style` ("arrow" or "pin") determines
/// whether heading angles are written. The bounding box fields are currently unused
/// (no viewport culling -- all locations are rendered).
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RenderRequest {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub selected_ids: Option<Vec<u32>>,
    pub marker_style: String,
    pub marker_color: Option<[u8; 3]>,
}

/// Build the full render binary: single linear pass over all alive locations, partitioned into
/// 32 geohash cells. Also rebuilds render_cells index and selection overlay. O(N).
pub(crate) fn build_cell_render_buffers(store: &mut Store, req: &RenderRequest) -> Vec<u8> {
    let _t = Instant::now();
    let b = match &store.batch {
        Some(b) => b,
        None if store.overlay.adds.is_empty() => return Vec::new(),
        None => {
            let empty = arrow::locations_to_batch(&[]);
            store.batch = Some(empty);
            store.batch.as_ref().unwrap()
        }
    };
    let batch_n = b.num_rows();
    let lats = col_lat(b);
    let lngs = col_lng(b);
    let ids_col = col_id(b);
    let headings = col_heading(b);
    let has_dead = !store.overlay.dead.is_empty();
    let has_patches = !store.overlay.patches.is_empty();

    let selected_set: &RoaringBitmap = &store.selections.ids;
    let paint_map = store.selections.paint_map();
    let active_id = store.selections.active_id;
    let arrow_style = req.marker_style == "arrow";

    // 32 cells indexed by render_cell_idx (0-31). Base markers all draw in the one marker
    // colour, which JS hands the layer as a constant, so the only per-marker colour fact
    // here is visibility. The selection overlay below genuinely varies and ships RGBA.
    struct CellOut {
        ids: Vec<u32>,
        positions: Vec<f32>,
        visible: Vec<u8>,
        angles: Vec<f32>,
    }
    const NONE: Option<CellOut> = None;
    let mut cells: [Option<CellOut>; 32] = [NONE; 32];

    // Selection overlay: selected entries rendered as a separate colored layer. `sel_idx`
    // is the drawing selection's index, which JS orders the entries by on load and keeps
    // them ordered by as later edits add and drop entries.
    struct SelOverlay {
        ids: Vec<u32>,
        positions: Vec<f32>,
        colors: Vec<u8>,
        angles: Vec<f32>,
        sel_idx: Vec<u32>,
    }
    let mut sel_ov = SelOverlay {
        ids: Vec::new(),
        positions: Vec::new(),
        colors: Vec::new(),
        angles: Vec::new(),
        sel_idx: Vec::new(),
    };

    {
        let mut emit = |id: u32, lat: f64, lng: f64, heading: f64| {
            let ci = render_cell_idx(lat, lng) as usize;
            let out = cells[ci].get_or_insert_with(|| CellOut {
                ids: Vec::new(),
                positions: Vec::new(),
                visible: Vec::new(),
                angles: Vec::new(),
            });
            out.positions.push(lng as f32);
            out.positions.push(lat as f32);
            let angle = if arrow_style { -(heading as f32) } else { 0.0 };
            // Hidden when the selection overlay or the active highlight is drawing it instead.
            let hidden = selected_set.contains(id) || active_id == Some(id);
            out.visible.push(if hidden { 0 } else { 255 });
            out.angles.push(angle);
            out.ids.push(id);
            if let Some(&SelPaint {
                idx,
                color: [r, g, b],
            }) = paint_map.get(&id)
            {
                sel_ov.positions.push(lng as f32);
                sel_ov.positions.push(lat as f32);
                sel_ov.colors.extend_from_slice(&[r, g, b, 255]);
                sel_ov.angles.push(angle);
                sel_ov.ids.push(id);
                sel_ov.sel_idx.push(idx);
            }
        };

        for i in 0..batch_n {
            let id = ids_col.value(i);
            if has_dead && store.overlay.dead.contains(&id) {
                continue;
            }
            let (lat, lng, heading) = if has_patches {
                if let Some(p) = store.overlay.patches.get(&id) {
                    (p.lat, p.lng, p.heading)
                } else {
                    (lats.value(i), lngs.value(i), headings.value(i))
                }
            } else {
                (lats.value(i), lngs.value(i), headings.value(i))
            };
            emit(id, lat, lng, heading);
        }
        for loc in &store.overlay.adds {
            emit(loc.id, loc.lat, loc.lng, loc.heading);
        }
    }

    // Rebuild per-cell render tracking
    store.render.cells = [const { None }; 32];
    store.render.id_to_cell_idx.clear();
    let mut total_count = 0usize;
    let mut non_empty = 0u32;
    for ci in 0..32 {
        let out = match &cells[ci] {
            Some(o) => o,
            None => continue,
        };
        let mut cr = CellRender {
            id_order: Vec::with_capacity(out.ids.len()),
            id_to_index: HashMap::new(),
        };
        for (i, &id) in out.ids.iter().enumerate() {
            cr.id_to_index.insert(id, i);
            cr.id_order.push(id);
            store.ensure_id_to_cell_capacity(id);
            store.render.id_to_cell_idx[id as usize] = ci as u8;
        }
        total_count += out.ids.len();
        non_empty += 1;
        store.render.cells[ci] = Some(cr);
    }

    // Serialize: u32 cell_count, per cell:
    //   [1 byte geohash char][u32 count][3 pad][u32[] ids][f32[] positions][u8[] visible][pad to 4][f32[] angles]
    // Arrays sit 4-byte aligned within the buffer so JS wraps them as views without copying.
    let body_cap: usize = (0..32)
        .filter_map(|ci| cells[ci].as_ref())
        .map(|o| {
            8 + o.ids.len() * 4 + o.positions.len() * 4 + o.visible.len() + 3 + o.angles.len() * 4
        })
        .sum();
    let sel_cap = if sel_ov.ids.is_empty() {
        0
    } else {
        sel_ov.positions.len() * 4
            + sel_ov.colors.len()
            + sel_ov.angles.len() * 4
            + sel_ov.ids.len() * 4
            + sel_ov.sel_idx.len() * 4
    };
    let mut buf = Vec::with_capacity(4 + body_cap + 4 + sel_cap);
    buf.extend_from_slice(&non_empty.to_le_bytes());
    for ci in 0..32 {
        let out = match &cells[ci] {
            Some(o) => o,
            None => continue,
        };
        let count = out.ids.len() as u32;
        buf.push(BASE32[ci]);
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&[0u8; 3]);
        // cast_slice = native-endian; all supported targets are little-endian like the JS side.
        buf.extend_from_slice(bytemuck::cast_slice(&out.ids));
        buf.extend_from_slice(bytemuck::cast_slice(&out.positions));
        buf.extend_from_slice(&out.visible);
        buf.extend_from_slice(&[0u8; 3][..(4 - out.visible.len() % 4) % 4]);
        buf.extend_from_slice(bytemuck::cast_slice(&out.angles));
    }

    // Selection overlay, in emission order. `selIdx` is the z key: JS sorts by it on load,
    // the same way it does after every delta, so the ordering lives in one implementation.
    // [u32 count][f32[] positions][u8[] colors][f32[] angles][u32[] ids][u32[] selIdx]
    let sel_count = sel_ov.ids.len() as u32;
    buf.extend_from_slice(&sel_count.to_le_bytes());
    if sel_count > 0 {
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.positions));
        buf.extend_from_slice(&sel_ov.colors);
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.angles));
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.ids));
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.sel_idx));
    }

    log::debug!(
        "[cmd] build_cell_render_buffers total={}ms cells={} points={} sel_overlay={} bytes={}",
        _t.elapsed().as_millis(),
        non_empty,
        total_count,
        sel_count,
        buf.len()
    );
    buf
}

impl Store {
    /// Render angle for a heading. Only arrow markers point anywhere.
    pub(super) fn render_angle(&self, heading: f64) -> f32 {
        if self.render.arrow_style {
            -(heading as f32)
        } else {
            0.0
        }
    }

    /// Project the changeset onto render cells, returning the render delta and keeping
    /// `render_cells` / `id_to_cell_idx` in sync. This is the single place cell
    /// membership is mutated for adds / removes / moves.
    ///
    /// `membership_changed` carries the ids whose selection membership moved, so a row that
    /// changed selection without moving still gets a patch stating its new state.
    pub(super) fn derive_render_delta(
        &mut self,
        changes: &ChangeSet,
        membership_changed: &HashSet<u32>,
    ) -> RenderDelta {
        let mut delta = RenderDelta {
            full_reset: changes.full_reset,
            ..Default::default()
        };

        for &id in &changes.removed {
            if let Some(removal) = self.cell_remove_render(id) {
                delta.removed.push(removal);
            }
        }

        for loc in &changes.added {
            let ci = render_cell_idx(loc.lat, loc.lng);
            self.cell_add_render(ci, loc.id);
            delta.added.push(RenderEntry {
                cell: cell_key_from_idx(ci),
                id: loc.id,
                lng: loc.lng as f32,
                lat: loc.lat as f32,
                heading: self.render_angle(loc.heading),
                sel: self.selections.paint_for(loc.id),
                moved_from: None,
            });
        }

        for (old, new) in &changes.updated {
            let pos_changed = old.lat != new.lat || old.lng != new.lng;
            let heading_changed = old.heading != new.heading;
            let new_ci = render_cell_idx(new.lat, new.lng);
            let old_ci = self
                .render
                .id_to_cell_idx
                .get(new.id as usize)
                .copied()
                .unwrap_or(255);

            // Crossing cells is a move, not a delete plus an unrelated create: the vacated
            // slot rides along on the entry so the overlay entry can follow the row.
            if pos_changed && old_ci != new_ci {
                let moved_from = self.cell_remove_render(new.id);
                self.cell_add_render(new_ci, new.id);
                delta.added.push(RenderEntry {
                    cell: cell_key_from_idx(new_ci),
                    id: new.id,
                    lng: new.lng as f32,
                    lat: new.lat as f32,
                    heading: self.render_angle(new.heading),
                    sel: self.selections.paint_for(new.id),
                    moved_from,
                });
                continue;
            }

            if pos_changed || heading_changed || membership_changed.contains(&new.id) {
                if let Some((cell, cell_index)) = self.cell_lookup(new.id) {
                    delta.updated.push(RenderPatchEntry {
                        cell,
                        cell_index,
                        lng: pos_changed.then_some(new.lng as f32),
                        lat: pos_changed.then_some(new.lat as f32),
                        heading: heading_changed.then(|| self.render_angle(new.heading)),
                        sel: self.selections.paint_for(new.id),
                    });
                }
            }
        }

        delta
    }

    /// Grow `id_to_cell_idx` so it can index `id`. Fills new slots with 255 (sentinel = unmapped).
    pub(super) fn ensure_id_to_cell_capacity(&mut self, id: u32) {
        let needed = id as usize + 1;
        if self.render.id_to_cell_idx.len() < needed {
            self.render.id_to_cell_idx.resize(needed, 255u8);
        }
    }

    /// Register a location in a render cell, appending it to the end. Returns the new index.
    pub(crate) fn cell_add_render(&mut self, cell_idx: u8, id: u32) -> usize {
        let cr = self.render.cells[cell_idx as usize].get_or_insert_with(|| CellRender {
            id_order: Vec::new(),
            id_to_index: HashMap::new(),
        });
        let idx = cr.id_order.len();
        cr.id_to_index.insert(id, idx);
        cr.id_order.push(id);
        self.ensure_id_to_cell_capacity(id);
        self.render.id_to_cell_idx[id as usize] = cell_idx;
        idx
    }

    /// Remove a location from its render cell via swap-remove. Returns the removal
    /// descriptor (needed by JS to patch its typed arrays) or `None` if not found.
    pub(super) fn cell_remove_render(&mut self, id: u32) -> Option<CellRemoval> {
        let ci = *self.render.id_to_cell_idx.get(id as usize)?;
        if ci == 255 {
            return None;
        }
        self.render.id_to_cell_idx[id as usize] = 255;
        let cr = self.render.cells[ci as usize].as_mut()?;
        let idx = cr.id_to_index.remove(&id)?;
        let last = cr.id_order.len() - 1;
        if idx != last {
            let moved_id = cr.id_order[last];
            cr.id_order[idx] = moved_id;
            cr.id_to_index.insert(moved_id, idx);
        }
        cr.id_order.pop();
        Some(CellRemoval {
            cell: cell_key_from_idx(ci),
            cell_index: idx,
            id,
        })
    }

    /// Look up a location's render cell key and index within that cell.
    pub(super) fn cell_lookup(&self, id: u32) -> Option<(String, usize)> {
        let ci = *self.render.id_to_cell_idx.get(id as usize)?;
        if ci == 255 {
            return None;
        }
        let cr = self.render.cells[ci as usize].as_ref()?;
        let idx = *cr.id_to_index.get(&id)?;
        Some((cell_key_from_idx(ci), idx))
    }
}
