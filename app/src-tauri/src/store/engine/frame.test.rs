use super::*;
use crate::selections::PolygonGeometry;
use crate::store::engine::WindowLabel;
use crate::util::Rgb;
use mma_algebra::Id;
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
                add: read.rows(h[2] as usize, Id::new),
                patch: read.rows(h[3] as usize, |key| key),
            }
        })
        .collect();
    let len = read.u32s(1)[0] as usize;
    let selection = (len > 0).then(|| bytes[read.off..read.off + len].to_vec());
    read.off = (read.off + len).next_multiple_of(4);
    let counts = read.u32s(2);
    let removed = (0..counts[1]).map(|_| read.key()).collect();
    let added = (0..counts[0])
        .map(|_| {
            let key = read.key();
            let len = read.u32s(1)[0] as usize;
            read.off = read.off.next_multiple_of(8);
            let mesh = bytes[read.off..read.off + len].to_vec();
            read.off += len;
            (key, Arc::new(mesh))
        })
        .collect();
    assert_eq!(
        read.off,
        bytes.len(),
        "the frame ends where its last section does"
    );
    Frame {
        kind: head[0],
        version: u64::from(head[1]) | (u64::from(head[2]) << 32),
        palette,
        cells,
        selection,
        polygons: PolygonFrame { added, removed },
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    off: usize,
}

impl Reader<'_> {
    fn key(&mut self) -> String {
        let len = self.u32s(1)[0] as usize;
        let key = String::from_utf8(self.bytes[self.off..self.off + len].to_vec()).unwrap();
        self.off = (self.off + len).next_multiple_of(4);
        key
    }

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

    fn rows<K: Default>(&mut self, n: usize, key: impl Fn(u32) -> K) -> CellRows<K> {
        CellRows {
            key: self.u32s(n).into_iter().map(key).collect(),
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

fn rows<K: Default>(
    entries: &[(u32, f32, f32, f32, PaletteIdx)],
    convert: impl Fn(u32) -> K,
) -> CellRows<K> {
    let mut r = CellRows::default();
    for &(key, lng, lat, angle, sel) in entries {
        r.key.push(convert(key));
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
                add: rows(
                    &[
                        (11, 1.5, -2.5, 90.0, PaletteIdx(0)),
                        (12, 3.0, 4.0, 0.0, PaletteIdx::NONE),
                    ],
                    Id::new,
                ),
                patch: rows(&[(1, 5.0, 6.0, -45.0, PaletteIdx::NONE)], |key| key),
            },
            CellFrame {
                cell: 31,
                remove: vec![],
                add: rows(&[(13, 7.0, 8.0, 0.0, PaletteIdx(0))], Id::new),
                patch: CellRows::default(),
            },
        ],
        selection: Some(vec![1, 2, 3, 4, 5]),
        polygons: PolygonFrame {
            added: vec![
                (
                    "polygon:a".into(),
                    Arc::new(polygon_mesh(&square_with_bowtie())),
                ),
                ("polygon:bc".into(), Arc::new(vec![1, 2, 3, 4])),
            ],
            removed: vec!["polygon:gone".into()],
        },
    }
}

fn geometry(parts: Vec<Vec<Vec<[f64; 2]>>>) -> PolygonGeometry {
    let mut parts = parts.into_iter();
    PolygonGeometry {
        coordinates: parts.next().unwrap(),
        extra_polygons: Some(parts.collect()),
        properties: None,
    }
}

/// A bowtie, plus a square with a square hole: two fill pieces, a holed one, three rings.
fn square_with_bowtie() -> PolygonGeometry {
    let square = |w: f64, s: f64, e: f64, n: f64| vec![[w, s], [e, s], [e, n], [w, n], [w, s]];
    geometry(vec![
        vec![vec![
            [0.0, 0.0],
            [2.0, 2.0],
            [2.0, 0.0],
            [0.0, 2.0],
            [0.0, 0.0],
        ]],
        vec![square(40.0, 0.0, 50.0, 10.0), square(44.0, 4.0, 46.0, 6.0)],
    ])
}

fn polygon_mesh_fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/unit/fixtures/polygon-mesh.bin")
}

/// Generator, not an assertion. `cargo test emit_polygon_mesh_fixture -- --ignored` rewrites
/// `app/test/unit/fixtures/polygon-mesh.bin`, which `polygonMeshes.test.ts` decodes.
#[test]
#[ignore]
fn emit_polygon_mesh_fixture() {
    std::fs::write(
        polygon_mesh_fixture_path(),
        polygon_mesh(&square_with_bowtie()),
    )
    .unwrap();
}

#[test]
fn the_polygon_mesh_fixture_matches_the_encoder() {
    let on_disk = std::fs::read(polygon_mesh_fixture_path())
        .expect("fixture; regenerate with `cargo test emit_polygon_mesh_fixture -- --ignored`");
    assert_eq!(on_disk, polygon_mesh(&square_with_bowtie()));
}

#[test]
fn a_polygon_mesh_counts_what_it_carries() {
    let bytes = polygon_mesh(&square_with_bowtie());
    let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    let (vertices, indices, rings, ring_vertices) = (word(0), word(1), word(2), word(3));
    assert_eq!(rings, 3);
    assert_eq!(ring_vertices, 15);
    assert_eq!(indices % 3, 0);
    assert!(indices > 0);
    assert_eq!(
        bytes.len(),
        16 + 16 * (vertices + ring_vertices) + 4 * (indices + rings + 1)
    );
}

#[test]
fn a_polygon_without_area_has_rings_but_no_fill() {
    let flat = geometry(vec![vec![vec![
        [0.0, 0.0],
        [1.0, 1.0],
        [2.0, 2.0],
        [0.0, 0.0],
    ]]]);
    let bytes = polygon_mesh(&flat);
    let word = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
    assert_eq!([word(0), word(1), word(2), word(3)], [0, 0, 1, 4]);
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
        polygons: PolygonFrame::default(),
        ..sample_frame()
    };
    let bytes = frame.encode();
    assert_eq!(&bytes[bytes.len() - 12..], &[0; 12]);
    assert_eq!(decode(&bytes).selection, None);
}

#[test]
fn every_sink_gets_the_same_bytes() {
    let (a, b) = (Captured::default(), Captured::default());
    let mut sinks = Sinks::default();
    sinks.insert(WindowLabel("a".into()), a.sink());
    sinks.insert(WindowLabel("b".into()), b.sink());

    sinks.send(FrameBytes(sample_frame().encode()));

    assert_eq!(a.bytes(), vec![sample_frame().encode()]);
    assert_eq!(b.bytes(), a.bytes());
}

#[test]
fn a_sink_that_cannot_take_a_frame_is_dropped() {
    let live = Captured::default();
    let mut sinks = Sinks::default();
    sinks.insert(WindowLabel("live".into()), live.sink());
    sinks.insert(
        WindowLabel("gone".into()),
        Channel::new(|_| Err(tauri::Error::WebviewNotFound)),
    );

    sinks.send(FrameBytes(sample_frame().encode()));
    sinks.send(FrameBytes(sample_frame().encode()));

    assert_eq!(live.bytes().len(), 2, "the live window keeps receiving");
    assert!(!sinks.has(&WindowLabel("gone".into()).into()));
}

/// The frame behind `app/test/unit/fixtures/polygon-frame.bin`: no marker changes, a
/// polygon gone, and two new ones (the bowtie-and-square, and one without area).
fn polygon_frame_fixture() -> Vec<u8> {
    let flat = geometry(vec![vec![vec![
        [0.0, 0.0],
        [1.0, 1.0],
        [2.0, 2.0],
        [0.0, 0.0],
    ]]]);
    Frame {
        kind: FrameKind::PATCH,
        version: 3,
        palette: vec![],
        cells: vec![],
        selection: None,
        polygons: PolygonFrame {
            added: vec![
                (
                    "polygon:a".into(),
                    Arc::new(polygon_mesh(&square_with_bowtie())),
                ),
                ("polygon:flat".into(), Arc::new(polygon_mesh(&flat))),
            ],
            removed: vec!["polygon:gone".into()],
        },
    }
    .encode()
}

fn polygon_frame_fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/unit/fixtures/polygon-frame.bin")
}

/// Generator, not an assertion. `cargo test emit_polygon_frame_fixture -- --ignored` rewrites
/// `app/test/unit/fixtures/polygon-frame.bin`, which `polygonMeshes.test.ts` applies.
#[test]
#[ignore]
fn emit_polygon_frame_fixture() {
    std::fs::write(polygon_frame_fixture_path(), polygon_frame_fixture()).unwrap();
}

#[test]
fn the_polygon_frame_fixture_matches_the_encoder() {
    let on_disk = std::fs::read(polygon_frame_fixture_path())
        .expect("fixture; regenerate with `cargo test emit_polygon_frame_fixture -- --ignored`");
    assert_eq!(on_disk, polygon_frame_fixture());
}
