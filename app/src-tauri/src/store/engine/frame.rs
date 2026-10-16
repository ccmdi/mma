//! Render frames: the one binary message that carries every marker change to a window.

use super::WindowLabel;
use crate::selections::PolygonGeometry;
use crate::types::{wire_enum, wire_names, Location, TsConst};
use crate::util::Rgb;
use mma_algebra::Id;
use specta::datatype::DataType;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};

wire_enum! {
    /// What a render frame does to the scene.
    FrameKind: u32 {
        /// Clears the scene, then adds every row the frame carries.
        REPLACE = 0,
        /// Changes the scene in place.
        PATCH = 1,
    }
}

/// A row's index into its frame's palette: the selection that paints it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct PaletteIdx(pub u32);

impl PaletteIdx {
    /// A row no selection paints.
    pub const NONE: Self = PaletteIdx(u32::MAX);
}

// SAFETY: a transparent wrapper over `u32`, which is `Pod`.
unsafe impl bytemuck::Zeroable for PaletteIdx {}
// SAFETY: as above.
unsafe impl bytemuck::Pod for PaletteIdx {}

/// Rows of one cell, column by column.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct CellRows<K = Id<Location>> {
    pub key: Vec<K>,
    /// `lng, lat` pairs.
    pub pos: Vec<f32>,
    pub angle: Vec<f32>,
    pub sel: Vec<PaletteIdx>,
}

impl<K> CellRows<K> {
    pub(crate) fn push(&mut self, key: K, lng: f64, lat: f64, angle: f32, sel: PaletteIdx) {
        self.key.push(key);
        self.pos.push(lng as f32);
        self.pos.push(lat as f32);
        self.angle.push(angle);
        self.sel.push(sel);
    }

    pub(crate) fn len(&self) -> usize {
        self.key.len()
    }

    fn encode_into(&self, buf: &mut Vec<u8>, keys: &[u32]) {
        buf.extend_from_slice(bytemuck::cast_slice(keys));
        buf.extend_from_slice(bytemuck::cast_slice(&self.pos));
        buf.extend_from_slice(bytemuck::cast_slice(&self.angle));
        buf.extend_from_slice(bytemuck::cast_slice(&self.sel));
    }
}

/// One cell's changes, applied in field order: each removal is a swap-remove at that
/// index, then the adds are appended, then the patches restate rows by their index after both.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct CellFrame {
    pub cell: u8,
    pub remove: Vec<u32>,
    pub add: CellRows,
    pub patch: CellRows<u32>,
}

impl CellFrame {
    fn is_empty(&self) -> bool {
        self.remove.is_empty() && self.add.len() == 0 && self.patch.len() == 0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Frame {
    pub kind: u32,
    /// The store version the scene is at once this frame is applied.
    pub version: u64,
    /// The colour of every live selection, in `SelectionState::live` order.
    pub palette: Vec<Rgb>,
    /// Ascending by cell, empty cells left out.
    pub cells: Vec<CellFrame>,
    /// Every cell's selection membership restated, in `build_selection_buf`'s layout.
    pub selection: Option<Vec<u8>>,
    pub polygons: PolygonFrame,
}

/// The polygons the map draws, as they changed: each new one's key and mesh, then the keys
/// of the ones gone. A replace frame carries every polygon.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct PolygonFrame {
    pub added: Vec<(String, Arc<Vec<u8>>)>,
    pub removed: Vec<String>,
}

/// How the map draws a polygon: the area it selects as triangles over its vertices, then
/// its rings as drawn. Little-endian: four `u32` counts (fill vertices, triangle indices,
/// rings, ring vertices), the fill then ring vertices as `f64` pairs, the triangle indices,
/// and each ring's first vertex plus the end as `u32`.
pub(crate) fn polygon_mesh(polygon: &PolygonGeometry) -> Vec<u8> {
    let mut positions = Vec::new();
    let mut triangles = Vec::new();
    for part in polygon.parts() {
        let mesh = mma_geo::fill_mesh(part);
        let base = positions.len() as u32;
        triangles.extend(mesh.triangles.iter().map(|i| i + base));
        positions.extend(mesh.positions);
    }
    let rings: Vec<_> = polygon
        .parts()
        .flatten()
        .map(|r| mma_geo::unwrap_ring(r))
        .collect();
    let ring_vertices: usize = rings.iter().map(|r| r.len()).sum();
    let mut buf = Vec::with_capacity(
        16 + 16 * (positions.len() + ring_vertices) + 4 * (triangles.len() + rings.len() + 1),
    );
    for count in [positions.len(), triangles.len(), rings.len(), ring_vertices] {
        buf.extend((count as u32).to_le_bytes());
    }
    for [lng, lat] in positions.iter().chain(rings.iter().flat_map(|r| r.iter())) {
        buf.extend(lng.to_le_bytes());
        buf.extend(lat.to_le_bytes());
    }
    for index in &triangles {
        buf.extend(index.to_le_bytes());
    }
    let mut start = 0u32;
    buf.extend(start.to_le_bytes());
    for ring in &rings {
        start += ring.len() as u32;
        buf.extend(start.to_le_bytes());
    }
    buf
}

impl Frame {
    /// Keep the cells that carry a change, in cell order.
    pub(crate) fn cells_of(cells: impl IntoIterator<Item = CellFrame>) -> Vec<CellFrame> {
        cells.into_iter().filter(|c| !c.is_empty()).collect()
    }

    /// The wire form. Little-endian, and every `u32`/`f32` array starts 4-byte aligned so
    /// the page can view it in place.
    pub(crate) fn encode(&self) -> Vec<u8> {
        let cap = 20
            + (self.palette.len() * 3).next_multiple_of(4)
            + self
                .cells
                .iter()
                .map(|c| 16 + c.remove.len() * 4 + c.add.len() * 20 + c.patch.len() * 20)
                .sum::<usize>()
            + self.selection.as_ref().map_or(0, |s| s.len() + 3)
            + 8
            + self
                .polygons
                .added
                .iter()
                .map(|(key, mesh)| 16 + key.len() + mesh.len())
                .sum::<usize>()
            + self
                .polygons
                .removed
                .iter()
                .map(|key| 8 + key.len())
                .sum::<usize>();
        let mut buf = Vec::with_capacity(cap);
        let put = |buf: &mut Vec<u8>, v: u32| buf.extend_from_slice(&v.to_le_bytes());
        put(&mut buf, self.kind);
        put(&mut buf, self.version as u32);
        put(&mut buf, (self.version >> 32) as u32);
        put(&mut buf, self.palette.len() as u32);
        for rgb in &self.palette {
            buf.extend_from_slice(&rgb.0);
        }
        pad4(&mut buf);
        put(&mut buf, self.cells.len() as u32);
        for c in &self.cells {
            put(&mut buf, u32::from(c.cell));
            put(&mut buf, c.remove.len() as u32);
            put(&mut buf, c.add.len() as u32);
            put(&mut buf, c.patch.len() as u32);
            buf.extend_from_slice(bytemuck::cast_slice(&c.remove));
            c.add.encode_into(&mut buf, Id::raw_slice(&c.add.key));
            c.patch.encode_into(&mut buf, &c.patch.key);
        }
        match &self.selection {
            Some(s) => {
                put(&mut buf, s.len() as u32);
                buf.extend_from_slice(s);
                pad4(&mut buf);
            }
            None => put(&mut buf, 0),
        }
        put(&mut buf, self.polygons.added.len() as u32);
        put(&mut buf, self.polygons.removed.len() as u32);
        let key = |buf: &mut Vec<u8>, key: &str| {
            put(buf, key.len() as u32);
            buf.extend_from_slice(key.as_bytes());
            pad4(buf);
        };
        for gone in &self.polygons.removed {
            key(&mut buf, gone);
        }
        for (name, mesh) in &self.polygons.added {
            key(&mut buf, name);
            put(&mut buf, mesh.len() as u32);
            // A mesh holds f64 arrays, which the page can only view 8-byte aligned.
            buf.resize(buf.len().next_multiple_of(8), 0);
            buf.extend_from_slice(mesh);
        }
        buf
    }
}

fn pad4(buf: &mut Vec<u8>) {
    buf.resize(buf.len().next_multiple_of(4), 0);
}

/// An encoded render frame.
#[derive(Clone)]
pub struct FrameBytes(pub Vec<u8>);

impl IpcResponse for FrameBytes {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Raw(self.0))
    }
}

impl specta::Type for FrameBytes {
    fn definition(_: &mut specta::Types) -> DataType {
        DataType::Reference(specta_typescript::define("ArrayBuffer"))
    }
}

/// The windows watching one store, keyed by window label.
pub(crate) struct Sinks<T>(HashMap<WindowLabel, Channel<T>>);

impl<T> Default for Sinks<T> {
    fn default() -> Self {
        Self(HashMap::new())
    }
}

impl<T: Clone + IpcResponse> Sinks<T> {
    pub(crate) fn insert(&mut self, label: WindowLabel, sink: Channel<T>) {
        self.0.insert(label, sink);
    }

    pub(crate) fn remove(&mut self, label: &WindowLabel) {
        self.0.remove(label);
    }

    pub(crate) fn has(&self, label: &WindowLabel) -> bool {
        self.0.contains_key(label)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Hand `msg` to every window. A window that cannot take it is gone.
    pub(crate) fn send(&mut self, msg: T) {
        self.0.retain(|label, sink| match sink.send(msg.clone()) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("[sinks] dropping sink for '{label}': {e}");
                false
            }
        });
    }
}

#[cfg(test)]
#[path = "frame.test.rs"]
pub(crate) mod tests;
