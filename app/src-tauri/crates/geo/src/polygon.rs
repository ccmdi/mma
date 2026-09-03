//! Ray-casting point-in-polygon and bbox primitives, antimeridian-aware. Rings are
//! `[lng, lat]` vertex lists (GeoJSON order); a polygon is outer ring first, then holes.

use std::borrow::Cow;

/// Shortest signed longitude delta from `from` to `to`, in [-180, 180].
#[inline]
pub fn lng_delta(from: f64, to: f64) -> f64 {
    let d = (to - from) % 360.0;
    if d > 180.0 {
        d - 360.0
    } else if d < -180.0 {
        d + 360.0
    } else {
        d
    }
}

/// Rewrite longitudes so each vertex sits within 180° of its predecessor; the span may
/// run outside [-180, 180]. Edges of 180° or more fold the short way round - split them
/// first (JS `densifyRing`). Mirrors JS `unwrapRing`. Borrows when already continuous.
pub fn unwrap_ring(ring: &[[f64; 2]]) -> Cow<'_, [[f64; 2]]> {
    if ring.windows(2).all(|w| (w[1][0] - w[0][0]).abs() <= 180.0) {
        return Cow::Borrowed(ring);
    }
    let mut out = Vec::with_capacity(ring.len());
    out.push(ring[0]);
    let mut prev = ring[0][0];
    for &[lng, lat] in &ring[1..] {
        prev += lng_delta(prev, lng);
        out.push([prev, lat]);
    }
    Cow::Owned(out)
}

/// Shift `lng` by whole turns into `[min, min + 360)`.
#[inline]
pub fn fold_lng(lng: f64, min: f64) -> f64 {
    min + (lng - min).rem_euclid(360.0)
}

/// Ray-casting algorithm: cast a horizontal ray eastward from (lng, lat) and count
/// edge crossings. Odd count = inside. O(V) where V = vertices.
pub fn point_in_ring(lng: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    if ring.is_empty() {
        return false;
    }
    let ring = unwrap_ring(ring);
    let min = ring.iter().map(|v| v[0]).fold(f64::INFINITY, f64::min);
    ring_test_raw(fold_lng(lng, min), lat, &ring)
}

/// Crossing-number loop with no per-edge folding; callers pre-fold both the ring and
/// the test longitude into one frame.
#[inline]
fn ring_test_raw(lng: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let [xi, yi] = ring[i];
        let [xj, yj] = ring[j];
        if ((yi > lat) != (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// One ring preprocessed for repeated point tests: the unwrap pass, the bbox and a
/// latitude-band edge index are paid once here instead of once per tested point. A
/// point then runs the crossing-number test over the edges spanning its own latitude
/// band, not the whole ring, so a country at full fidelity costs a few dozen edges per
/// point rather than tens of thousands.
pub struct PreparedRing<'a> {
    ring: Cow<'a, [[f64; 2]]>,
    /// `[min_lng, min_lat, max_lng, max_lat]` in the unwrapped ring's frame, so
    /// `min_lng` may sit below -180 and `max_lng` above it.
    bb: [f64; 4],
    /// Edge index `i` (the edge from vertex `i - 1`, wrapping, to vertex `i`) listed under
    /// every band its latitude span touches; CSR layout, `band_start[b]..band_start[b + 1]`.
    band_start: Vec<u32>,
    band_edges: Vec<u32>,
    band_height: f64,
}

/// Edges per band the index aims for; the build is one pass, so bands are cheap.
const EDGES_PER_BAND: usize = 4;
const MAX_BANDS: usize = 1 << 14;

impl<'a> PreparedRing<'a> {
    pub fn new(ring: &'a [[f64; 2]]) -> Self {
        let ring = unwrap_ring(ring);
        let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        let mut any = false;
        extend_bbox_with_ring(&mut bb, &mut any, &ring);

        let n = ring.len();
        let bands = (n / EDGES_PER_BAND).clamp(1, MAX_BANDS);
        let span = bb[3] - bb[1];
        let band_height = if any && span > 0.0 {
            span / bands as f64
        } else {
            f64::INFINITY
        };
        let band_of = |lat: f64| -> usize {
            if band_height.is_infinite() {
                0
            } else {
                (((lat - bb[1]) / band_height) as usize).min(bands - 1)
            }
        };
        let edge_bands = |i: usize| -> (usize, usize) {
            let j = if i == 0 { n - 1 } else { i - 1 };
            let (lo, hi) = (ring[i][1].min(ring[j][1]), ring[i][1].max(ring[j][1]));
            (band_of(lo), band_of(hi))
        };
        let mut band_start = vec![0u32; bands + 1];
        for i in 0..n {
            let (lo, hi) = edge_bands(i);
            for b in lo..=hi {
                band_start[b + 1] += 1;
            }
        }
        for b in 0..bands {
            band_start[b + 1] += band_start[b];
        }
        let mut fill = band_start.clone();
        let mut band_edges = vec![0u32; band_start[bands] as usize];
        for i in 0..n {
            let (lo, hi) = edge_bands(i);
            for b in lo..=hi {
                band_edges[fill[b] as usize] = i as u32;
                fill[b] += 1;
            }
        }
        Self {
            ring,
            bb,
            band_start,
            band_edges,
            band_height,
        }
    }

    /// Bbox reject, then the crossing test over the edges spanning this latitude band.
    /// Equivalent to `point_in_ring`: an edge outside the band cannot cross the ray.
    #[inline]
    pub fn contains(&self, lng: f64, lat: f64) -> bool {
        let lng = fold_lng(lng, self.bb[0]);
        if lng > self.bb[2] || lat < self.bb[1] || lat > self.bb[3] {
            return false;
        }
        let band = if self.band_height.is_infinite() {
            0
        } else {
            (((lat - self.bb[1]) / self.band_height) as usize).min(self.band_start.len() - 2)
        };
        let ring = &self.ring;
        let n = ring.len();
        let mut inside = false;
        for &i in
            &self.band_edges[self.band_start[band] as usize..self.band_start[band + 1] as usize]
        {
            let i = i as usize;
            let j = if i == 0 { n - 1 } else { i - 1 };
            let [xi, yi] = ring[i];
            let [xj, yj] = ring[j];
            if ((yi > lat) != (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        inside
    }
}

/// Test point-in-polygon with holes over rings yielded as slices: inside the outer
/// ring (first) and outside all hole rings (rest). The single source of truth for the
/// outer/hole composition, shared by owned `Vec`-backed and mmap'd archived geometry.
pub fn polygon_contains<'a>(
    lng: f64,
    lat: f64,
    mut rings: impl Iterator<Item = &'a [[f64; 2]]>,
) -> bool {
    let Some(outer) = rings.next() else {
        return false;
    };
    if !point_in_ring(lng, lat, outer) {
        return false;
    }
    for hole in rings {
        if point_in_ring(lng, lat, hole) {
            return false;
        }
    }
    true
}

/// Grow a running `[min_lng, min_lat, max_lng, max_lat]` to cover one ring, unwrapped
/// then shifted by whole turns to sit nearest the box so far. `any` flips true once at
/// least one vertex has been seen. Shared by owned and archived bbox computation.
pub fn extend_bbox_with_ring(bb: &mut [f64; 4], any: &mut bool, ring: &[[f64; 2]]) {
    let ring = unwrap_ring(ring);
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for &[lng, _] in ring.iter() {
        lo = lo.min(lng);
        hi = hi.max(lng);
    }
    if lo > hi {
        return;
    }
    let shift = if *any {
        (((bb[0] + bb[2]) - (lo + hi)) / 720.0).round() * 360.0
    } else {
        0.0
    };
    for &[lng, lat] in ring.iter() {
        let lng = lng + shift;
        if lng < bb[0] {
            bb[0] = lng;
        }
        if lat < bb[1] {
            bb[1] = lat;
        }
        if lng > bb[2] {
            bb[2] = lng;
        }
        if lat > bb[3] {
            bb[3] = lat;
        }
        *any = true;
    }
}

/// Slide a finished box so its western edge sits in [-180, 180), letting the hot
/// `in_bbox` fold a test longitude with one conditional add instead of a modulo.
#[inline]
pub fn anchor_bbox(bb: &mut [f64; 4]) {
    let shift = -((bb[0] + 180.0) / 360.0).floor() * 360.0;
    bb[0] += shift;
    bb[2] += shift;
}

/// `bb` is `[min_lng, min_lat, max_lng, max_lat]` with `min_lng` anchored in [-180, 180)
/// by `anchor_bbox`; `max_lng` may run past 180 when the box crosses the antimeridian.
/// Requires a test longitude in [-180, 180]; out-of-range longitudes miss.
#[inline]
pub fn in_bbox(lng: f64, lat: f64, bb: &[f64; 4]) -> bool {
    if lat < bb[1] || lat > bb[3] {
        return false;
    }
    let lng = if lng < bb[0] { lng + 360.0 } else { lng };
    lng <= bb[2]
}
