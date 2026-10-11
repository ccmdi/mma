//! Render frames: the one binary message that carries every marker change to a window.

use super::WindowLabel;
use crate::types::{wire_enum, wire_names, Location, TsConst};
use crate::util::Rgb;
use mma_algebra::Id;
use specta::datatype::DataType;
use std::collections::HashMap;
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
pub(crate) struct Rows<K = Id<Location>> {
    pub key: Vec<K>,
    /// `lng, lat` pairs.
    pub pos: Vec<f32>,
    pub angle: Vec<f32>,
    pub sel: Vec<PaletteIdx>,
}

impl<K> Rows<K> {
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
    pub add: Rows,
    pub patch: Rows<u32>,
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
            + self.selection.as_ref().map_or(0, |s| s.len() + 3);
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
