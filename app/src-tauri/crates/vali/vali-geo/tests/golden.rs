use std::path::{Path, PathBuf};
use vali_geo::geohash::{bounding_box, encode, neighbors, HashPrecision};
use vali_geo::points_are_closer_than;

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/geo")
}

struct Cursor {
    bytes: Vec<u8>,
    pos: usize,
}

impl Cursor {
    fn open(path: &Path) -> Cursor {
        let bytes = std::fs::read(path)
            .unwrap_or_else(|e| panic!("cannot read golden fixture {}: {e}", path.display()));
        Cursor { bytes, pos: 0 }
    }

    fn f64(&mut self) -> f64 {
        f64::from_le_bytes(self.take::<8>())
    }

    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take::<8>())
    }

    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take::<8>())
    }

    fn u8(&mut self) -> u8 {
        let v = self.bytes[self.pos];
        self.pos += 1;
        v
    }

    fn take<const N: usize>(&mut self) -> [u8; N] {
        let v: [u8; N] = self.bytes[self.pos..self.pos + N].try_into().unwrap();
        self.pos += N;
        v
    }
}

fn precision_from(p: u8) -> HashPrecision {
    use HashPrecision::*;
    match p {
        1 => Size_km_5000x5000,
        2 => Size_km_1250x625,
        3 => Size_km_156x156,
        4 => Size_km_39x20,
        5 => Size_km_5x5,
        6 => Size_km_1x1,
        7 => Size_m_153x153,
        8 => Size_m_38x19,
        9 => Size_m_5x5,
        10 => Size_m_1x1,
        11 => Size_mm_149x149,
        12 => Size_mm_37x19,
        _ => panic!("bad precision {p}"),
    }
}

/// Always runs the committed `-small` set, plus `-boundary` (crafted near-threshold cases,
/// where a "better" formula diverges from the oracle while random samples still agree) and
/// the full regenerated set when either is present.
fn on_fixtures(name: &str, check: impl Fn(&Path)) {
    let dir = fixture_dir();
    check(&dir.join(format!("{name}-small.bin")));
    for extra in [format!("{name}-boundary.bin"), format!("{name}.bin")] {
        let path = dir.join(extra);
        if path.exists() {
            check(&path);
        }
    }
}

#[test]
fn geohash_encode_matches_oracle() {
    on_fixtures("geohash", |path| {
        let mut c = Cursor::open(path);
        let n = c.i64();
        let mut bad = 0u64;
        for i in 0..n {
            let (lat, lng, p, expected) = (c.f64(), c.f64(), c.u8(), c.u64());
            let got = encode(lat, lng, precision_from(p));
            if got != expected {
                bad += 1;
                if bad <= 5 {
                    eprintln!(
                        "record {i}: encode({lat:?}, {lng:?}, {p}) = {got:#x}, oracle {expected:#x}"
                    );
                }
            }
        }
        assert_eq!(bad, 0, "{bad}/{n} geohash mismatches in {}", path.display());
    });
}

#[test]
fn neighbors_match_oracle() {
    on_fixtures("neighbors", |path| {
        let mut c = Cursor::open(path);
        let n = c.i64();
        let mut bad = 0u64;
        for i in 0..n {
            let hash = c.u64();
            let expected: [u64; 8] = std::array::from_fn(|_| c.u64());
            let got = neighbors(hash);
            if got != expected {
                bad += 1;
                if bad <= 5 {
                    eprintln!("record {i}: neighbors({hash:#x}) = {got:x?}, oracle {expected:x?}");
                }
            }
        }
        assert_eq!(
            bad,
            0,
            "{bad}/{n} neighbor mismatches in {}",
            path.display()
        );
    });
}

#[test]
fn bounding_box_matches_oracle_bitwise() {
    on_fixtures("bbox", |path| {
        let mut c = Cursor::open(path);
        let n = c.i64();
        let mut bad = 0u64;
        for i in 0..n {
            let hash = c.u64();
            let expected = [c.f64(), c.f64(), c.f64(), c.f64()];
            let bb = bounding_box(hash);
            let got = [bb.min_lat, bb.max_lat, bb.min_lng, bb.max_lng];
            if got.map(f64::to_bits) != expected.map(f64::to_bits) {
                bad += 1;
                if bad <= 5 {
                    eprintln!("record {i}: bounding_box({hash:#x}) = {got:?}, oracle {expected:?}");
                }
            }
        }
        assert_eq!(
            bad,
            0,
            "{bad}/{n} bounding-box mismatches in {}",
            path.display()
        );
    });
}

#[test]
fn points_are_closer_than_matches_oracle() {
    on_fixtures("distance", |path| {
        let mut c = Cursor::open(path);
        let n = c.i64();
        let mut bad = 0u64;
        for i in 0..n {
            let (lat1, lng1, lat2, lng2, m2) = (c.f64(), c.f64(), c.f64(), c.f64(), c.f64());
            let expected = c.u8() == 1;
            let got = points_are_closer_than(lat1, lng1, lat2, lng2, m2);
            if got != expected {
                bad += 1;
                if bad <= 5 {
                    eprintln!(
                        "record {i}: points_are_closer_than({lat1:?}, {lng1:?}, {lat2:?}, {lng2:?}, {m2:?}) = {got}, oracle {expected}"
                    );
                }
            }
        }
        assert_eq!(
            bad,
            0,
            "{bad}/{n} distance-boolean mismatches in {}",
            path.display()
        );
    });
}
