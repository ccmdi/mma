use super::*;
use crate::util::Rgb;
use std::sync::{Arc, Mutex};

/// Read a frame back off the wire, asserting every array starts 4-byte aligned. The page
/// reads the same layout; this lets tests assert on exactly what a window receives.
pub(crate) fn decode(bytes: &[u8]) -> Frame {
    let mut read = Reader { bytes, off: 0 };
    let head = read.u32s(4);
    let palette_len = head[3] as usize;
    let palette = bytes[read.off..read.off + palette_len * 3]
        .chunks_exact(3)
        .map(|c| Rgb([c[0], c[1], c[2]]))
        .collect();
    read.off = (read.off + palette_len * 3).next_multiple_of(4);
    let cell_count = read.u32s(1)[0] as usize;
    let cells = (0..cell_count)
        .map(|_| {
            let h = read.u32s(4);
            CellFrame {
                cell: h[0] as u8,
                remove: read.u32s(h[1] as usize),
                add: read.rows(h[2] as usize),
                patch: read.rows(h[3] as usize),
            }
        })
        .collect();
    let len = read.u32s(1)[0] as usize;
    let selection = (len > 0).then(|| bytes[read.off..read.off + len].to_vec());
    assert_eq!(
        (read.off + len).next_multiple_of(4),
        bytes.len(),
        "the frame ends where its last section does"
    );
    Frame {
        kind: head[0],
        version: u64::from(head[1]) | (u64::from(head[2]) << 32),
        palette,
        cells,
        selection,
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    off: usize,
}

impl Reader<'_> {
    fn u32s(&mut self, n: usize) -> Vec<u32> {
        assert_eq!(
            self.off % 4,
            0,
            "array at {} is not 4-byte aligned",
            self.off
        );
        let out = self.bytes[self.off..self.off + n * 4]
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
            .collect();
        self.off += n * 4;
        out
    }

    fn f32s(&mut self, n: usize) -> Vec<f32> {
        self.u32s(n).into_iter().map(f32::from_bits).collect()
    }

    fn rows(&mut self, n: usize) -> Rows {
        Rows {
            key: self.u32s(n),
            pos: self.f32s(n * 2),
            angle: self.f32s(n),
            sel: self.u32s(n).into_iter().map(PaletteIdx).collect(),
        }
    }
}

/// The frames one window received, from a sink that records them instead of sending.
#[derive(Clone, Default)]
pub(crate) struct Captured(Arc<Mutex<Vec<Vec<u8>>>>);

impl Captured {
    pub(crate) fn sink(&self) -> Channel<FrameBytes> {
        let got = self.0.clone();
        Channel::new(move |body| {
            let InvokeResponseBody::Raw(bytes) = body else {
                panic!("frames travel as raw bytes");
            };
            got.lock().unwrap().push(bytes);
            Ok(())
        })
    }

    pub(crate) fn bytes(&self) -> Vec<Vec<u8>> {
        self.0.lock().unwrap().clone()
    }

    pub(crate) fn frames(&self) -> Vec<Frame> {
        self.bytes().iter().map(|b| decode(b)).collect()
    }

    pub(crate) fn last(&self) -> Frame {
        self.frames().pop().expect("a frame was sent")
    }
}

fn rows(entries: &[(u32, f32, f32, f32, PaletteIdx)]) -> Rows {
    let mut r = Rows::default();
    for &(key, lng, lat, angle, sel) in entries {
        r.key.push(key);
        r.pos.extend([lng, lat]);
        r.angle.push(angle);
        r.sel.push(sel);
    }
    r
}

fn sample_frame() -> Frame {
    Frame {
        kind: FrameKind::PATCH,
        version: (7 << 32) | 9,
        palette: vec![Rgb([255, 0, 0])],
        cells: vec![
            CellFrame {
                cell: 3,
                remove: vec![2, 0],
                add: rows(&[
                    (11, 1.5, -2.5, 90.0, PaletteIdx(0)),
                    (12, 3.0, 4.0, 0.0, PaletteIdx::NONE),
                ]),
                patch: rows(&[(1, 5.0, 6.0, -45.0, PaletteIdx::NONE)]),
            },
            CellFrame {
                cell: 31,
                remove: vec![],
                add: rows(&[(13, 7.0, 8.0, 0.0, PaletteIdx(0))]),
                patch: Rows::default(),
            },
        ],
        selection: Some(vec![1, 2, 3, 4, 5]),
    }
}

#[test]
fn a_frame_reads_back_as_it_was_written() {
    let frame = sample_frame();
    assert_eq!(decode(&frame.encode()), frame);
}

#[test]
fn every_array_in_a_frame_starts_4_byte_aligned() {
    // `decode` asserts the alignment of each array it reads; a 1-colour palette and a
    // 5-byte selection section are the two places padding has to be inserted.
    let bytes = sample_frame().encode();
    assert_eq!(bytes.len() % 4, 0);
    decode(&bytes);
}

#[test]
fn a_frame_without_a_selection_section_says_so() {
    let frame = Frame {
        selection: None,
        ..sample_frame()
    };
    let bytes = frame.encode();
    assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    assert_eq!(decode(&bytes).selection, None);
}

#[test]
fn every_sink_gets_the_same_bytes() {
    let (a, b) = (Captured::default(), Captured::default());
    let mut sinks = Sinks::default();
    sinks.insert("a".into(), a.sink());
    sinks.insert("b".into(), b.sink());

    sinks.send(FrameBytes(sample_frame().encode()));

    assert_eq!(a.bytes(), vec![sample_frame().encode()]);
    assert_eq!(b.bytes(), a.bytes());
}

#[test]
fn a_sink_that_cannot_take_a_frame_is_dropped() {
    let live = Captured::default();
    let mut sinks = Sinks::default();
    sinks.insert("live".into(), live.sink());
    sinks.insert(
        "gone".into(),
        Channel::new(|_| Err(tauri::Error::WebviewNotFound)),
    );

    sinks.send(FrameBytes(sample_frame().encode()));
    sinks.send(FrameBytes(sample_frame().encode()));

    assert_eq!(live.bytes().len(), 2, "the live window keeps receiving");
    assert!(!sinks.0.contains_key("gone"));
}
