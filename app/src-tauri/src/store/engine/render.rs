//! Render cells: geohash binning, the selection membership wire format, and the frames each mutation projects onto the cells.

use super::*;
use crate::store::arrow::Columns;
use crate::store::id_set::IdSet;
use crate::util::Rgb;
use mma_algebra::Id;
use std::array;
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use tauri::ipc::Channel;

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

/// Assemble the selection-bitmask wire buffer shared by sync/delta/rebuild:
/// `[numSels: u32 le][numSels * RGB][numCells: u8][segments...]`.
/// The count is u32 so thousands of selections (e.g. shift-selecting many tags)
/// don't wrap the header and desync the JS parser.
pub(super) fn assemble_selection_bitmask<'a>(
    colors: impl ExactSizeIterator<Item = &'a Rgb>,
    segments: &[Vec<u8>],
) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(&(colors.len() as u32).to_le_bytes());
    for c in colors {
        buf.extend_from_slice(&c.0);
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
    set: &IdSet<Location>,
) -> [Vec<u32>; 32] {
    let mut out: [Vec<u32>; 32] = array::from_fn(|_| Vec::new());
    if (set.len() as usize) <= render_size {
        for id in set {
            let Some(&ci) = render.id_to_cell_idx.get(id.get() as usize) else {
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
    sels: &[&ResolvedSelection],
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
    pub id_order: Vec<Id<Location>>,
    pub id_to_index: HashMap<Id<Location>, usize>,
}

/// The colour a location's marker takes when no selection paints it.
pub const DEFAULT_MARKER_COLOR: Rgb = Rgb([42, 42, 42]);

pub(crate) struct RenderState {
    pub cells: [Option<CellRender>; 32],
    pub id_to_cell_idx: Vec<u8>,
    pub arrow_style: bool,
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

/// Parameters for a full marker rebuild. `markerStyle` ("arrow" or "pin") decides whether
/// headings are drawn.
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RenderRequest {
    pub marker_style: String,
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

    /// Start sending `label` every render frame, beginning with the whole scene. The scene
    /// rebuild reorders every cell, so every watching window gets the replace frame.
    pub(crate) fn subscribe_frames(
        &mut self,
        label: WindowLabel,
        sink: Channel<FrameBytes>,
        req: &RenderRequest,
    ) {
        self.render.arrow_style = req.marker_style == "arrow";
        self.frames.insert(label, sink);
        let frame = self.scene_frame();
        self.frames.send(FrameBytes(frame.encode()));
    }

    /// Take over the windows `replaced` was drawing for, sending them this store's scene.
    pub(crate) fn adopt_watchers(&mut self, replaced: Store) {
        self.render.arrow_style = replaced.render.arrow_style;
        self.frames = replaced.frames;
        self.changes = replaced.changes;
        let frame = self.scene_frame();
        self.frames.send(FrameBytes(frame.encode()));
    }

    /// Rebuild the render cells from every alive location in one pass and return the frame
    /// that draws them from scratch: every row an add, stating the selection painting it. O(N).
    pub(crate) fn scene_frame(&mut self) -> Frame {
        let t = Instant::now();
        let mut cells: [CellFrame; 32] = array::from_fn(|ci| CellFrame {
            cell: ci as u8,
            ..CellFrame::default()
        });
        let paint = self.selections.paint_map();
        let arrow_style = self.render.arrow_style;
        let mut emit = |id: Id<Location>, lat: f64, lng: f64, heading: f64| {
            let angle = if arrow_style { -(heading as f32) } else { 0.0 };
            let sel = paint.get(&id).copied().unwrap_or(PaletteIdx::NONE);
            cells[render_cell_idx(lat, lng) as usize]
                .add
                .push(id, lng, lat, angle, sel);
        };
        if let Some(b) = &self.batch {
            let (ids, lats, lngs, headings) = (
                Columns::id(b),
                Columns::lat(b),
                Columns::lng(b),
                Columns::heading(b),
            );
            for i in 0..b.num_rows() {
                let id = Id::new(ids.value(i));
                if self.overlay.removed.contains(id) {
                    continue;
                }
                match self.overlay.updated.get(&id) {
                    Some(p) => emit(id, p.lat, p.lng, p.heading),
                    None => emit(id, lats.value(i), lngs.value(i), headings.value(i)),
                }
            }
        }
        for loc in &self.overlay.added {
            emit(loc.id, loc.lat, loc.lng, loc.heading);
        }

        self.render.cells = [const { None }; 32];
        self.render.id_to_cell_idx.clear();
        for c in &cells {
            let ids = &c.add.key;
            let Some(&max) = ids.iter().max() else {
                continue;
            };
            self.ensure_id_to_cell_capacity(max);
            for &id in ids {
                self.render.id_to_cell_idx[id.get() as usize] = c.cell;
            }
            self.render.cells[c.cell as usize] = Some(CellRender {
                id_to_index: ids.iter().enumerate().map(|(i, &id)| (id, i)).collect(),
                id_order: ids.clone(),
            });
        }

        let frame = Frame {
            kind: FrameKind::REPLACE,
            version: self.version,
            palette: self.selections.palette(),
            cells: Frame::cells_of(cells),
            selection: None,
        };
        log::debug!(
            "[render] scene_frame total={}ms cells={} points={}",
            t.elapsed().as_millis(),
            frame.cells.len(),
            self.render.total_len(),
        );
        frame
    }

    /// Project the changeset onto the render cells, keeping `render.cells` and
    /// `id_to_cell_idx` in step: the single place cell membership changes. Three passes,
    /// in the order the page applies them, so every index is the one the page will see:
    /// every removal (removed rows, then rows moving out), every append (added rows, then
    /// rows moving in), then the patches, looked up after both.
    ///
    /// `membership_changed` carries the ids whose selection paint moved, so a row that
    /// changed selection without moving still gets a patch stating its new state.
    pub(super) fn derive_cell_frames(
        &mut self,
        changes: &Change<Location>,
        membership_changed: &HashSet<Id<Location>>,
    ) -> [CellFrame; 32] {
        let mut cells: [CellFrame; 32] = array::from_fn(|ci| CellFrame {
            cell: ci as u8,
            ..CellFrame::default()
        });

        for loc in &changes.removed {
            if let Some((ci, idx)) = self.cell_remove_render(loc.id) {
                cells[ci as usize].remove.push(idx);
            }
        }
        let moves: Vec<bool> = changes
            .updated
            .iter()
            .map(|(old, new)| {
                let old_ci = self
                    .render
                    .id_to_cell_idx
                    .get(new.id.get() as usize)
                    .copied()
                    .unwrap_or(255);
                let moved = (old.lat, old.lng) != (new.lat, new.lng)
                    && old_ci != render_cell_idx(new.lat, new.lng);
                if moved {
                    if let Some((ci, idx)) = self.cell_remove_render(new.id) {
                        cells[ci as usize].remove.push(idx);
                    }
                }
                moved
            })
            .collect();

        let arrivals = changes.added.iter().chain(
            changes
                .updated
                .iter()
                .zip(&moves)
                .filter(|(_, &moved)| moved)
                .map(|((_, new), _)| new),
        );
        for loc in arrivals {
            let ci = render_cell_idx(loc.lat, loc.lng);
            self.cell_add_render(ci, loc.id);
            let sel = self
                .selections
                .paint_for(loc.id)
                .unwrap_or(PaletteIdx::NONE);
            cells[ci as usize].add.push(
                loc.id,
                loc.lng,
                loc.lat,
                self.render_angle(loc.heading),
                sel,
            );
        }

        for ((old, new), &moved) in changes.updated.iter().zip(&moves) {
            let restated = (old.lat, old.lng, old.heading) != (new.lat, new.lng, new.heading)
                || membership_changed.contains(&new.id);
            if moved || !restated {
                continue;
            }
            if let Some((ci, idx)) = self.cell_lookup(new.id) {
                let sel = self
                    .selections
                    .paint_for(new.id)
                    .unwrap_or(PaletteIdx::NONE);
                cells[ci as usize].patch.push(
                    idx as u32,
                    new.lng,
                    new.lat,
                    self.render_angle(new.heading),
                    sel,
                );
            }
        }

        cells
    }

    /// Grow `id_to_cell_idx` so it can index `id`. Fills new slots with 255 (sentinel = unmapped).
    pub(super) fn ensure_id_to_cell_capacity(&mut self, id: Id<Location>) {
        let needed = id.get() as usize + 1;
        if self.render.id_to_cell_idx.len() < needed {
            self.render.id_to_cell_idx.resize(needed, 255u8);
        }
    }

    /// Register a location in a render cell, appending it to the end. Returns the new index.
    pub(crate) fn cell_add_render(&mut self, cell_idx: u8, id: Id<Location>) -> usize {
        let cr = self.render.cells[cell_idx as usize].get_or_insert_with(|| CellRender {
            id_order: Vec::new(),
            id_to_index: HashMap::new(),
        });
        let idx = cr.id_order.len();
        cr.id_to_index.insert(id, idx);
        cr.id_order.push(id);
        self.ensure_id_to_cell_capacity(id);
        self.render.id_to_cell_idx[id.get() as usize] = cell_idx;
        idx
    }

    /// Remove a location from its render cell via swap-remove: the cell's last row takes
    /// the vacated slot. Returns the cell and the slot, or `None` if it was not rendered.
    pub(super) fn cell_remove_render(&mut self, id: Id<Location>) -> Option<(u8, u32)> {
        let ci = *self.render.id_to_cell_idx.get(id.get() as usize)?;
        if ci == 255 {
            return None;
        }
        self.render.id_to_cell_idx[id.get() as usize] = 255;
        let cr = self.render.cells[ci as usize].as_mut()?;
        let idx = cr.id_to_index.remove(&id)?;
        let last = cr.id_order.len() - 1;
        if idx != last {
            let moved_id = cr.id_order[last];
            cr.id_order[idx] = moved_id;
            cr.id_to_index.insert(moved_id, idx);
        }
        cr.id_order.pop();
        Some((ci, idx as u32))
    }

    /// A location's render cell and its index within that cell.
    pub(super) fn cell_lookup(&self, id: Id<Location>) -> Option<(u8, usize)> {
        let ci = *self.render.id_to_cell_idx.get(id.get() as usize)?;
        if ci == 255 {
            return None;
        }
        let cr = self.render.cells[ci as usize].as_ref()?;
        let idx = *cr.id_to_index.get(&id)?;
        Some((ci, idx))
    }
}
