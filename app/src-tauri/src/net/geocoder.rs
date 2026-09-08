//! Offline reverse geocoding -- nearest city/admin1/country for a coordinate, read from
//! the packed GeoNames table `data/cities.bin` (layout in `scripts/gen-cities-bin.mjs`).
//!
//! Points are unit-sphere vectors stored in implicit kd-tree order (children of node `i`
//! at `2i+1`/`2i+2`). Ranking uses squared chord distance, which is monotonic with
//! great-circle distance, so nearest-by-chord equals nearest-by-haversine. The tests diff
//! every result against the `reverse_geocoder` crate (dev-dependency, oracle only).

use serde::Serialize;
use std::str::from_utf8;
use std::sync::OnceLock;

static TABLE: &[u8] = include_bytes!("../../data/cities.bin");

const HEADER_LEN: usize = 32;

fn u32_at(off: usize) -> u32 {
    u32::from_le_bytes(TABLE[off..off + 4].try_into().unwrap())
}

fn f32_at(off: usize) -> f64 {
    f32::from_le_bytes(TABLE[off..off + 4].try_into().unwrap()) as f64
}

const STRIDE: usize = 20;

struct Cities {
    count: usize,
    pts_at: usize,
    names_at: usize,
    admins_at: usize,
    admin_bytes_at: usize,
}

fn cities() -> &'static Cities {
    static CITIES: OnceLock<Cities> = OnceLock::new();
    CITIES.get_or_init(|| {
        assert_eq!(&TABLE[0..4], b"MMAC", "cities.bin: bad magic");
        assert_eq!(u32_at(4), 3, "cities.bin: unsupported version");
        let count = u32_at(8) as usize;
        let admin_count = u32_at(24) as usize;
        let admins_at = u32_at(20) as usize;
        Cities {
            count,
            pts_at: HEADER_LEN,
            names_at: u32_at(16) as usize,
            admins_at,
            admin_bytes_at: admins_at + (admin_count + 1) * 4,
        }
    })
}

impl Cities {
    fn xyz(&self, i: usize) -> (f64, f64, f64) {
        let at = self.pts_at + i * STRIDE;
        (f32_at(at), f32_at(at + 4), f32_at(at + 8))
    }

    #[cfg(test)]
    fn lat_lng(&self, i: usize) -> (f64, f64) {
        let (x, y, z) = self.xyz(i);
        (z.asin().to_degrees(), y.atan2(x).to_degrees())
    }

    fn name(&self, i: usize) -> &'static str {
        let off = self.names_at + u32_at(self.pts_at + i * STRIDE + 12) as usize;
        let len = TABLE[off] as usize;
        from_utf8(&TABLE[off + 1..off + 1 + len]).unwrap_or_default()
    }

    fn admin(&self, i: usize) -> &'static str {
        let id = u16::from_le_bytes(
            TABLE[self.pts_at + i * STRIDE + 16..self.pts_at + i * STRIDE + 18]
                .try_into()
                .unwrap(),
        ) as usize;
        let a = u32_at(self.admins_at + id * 4) as usize;
        let b = u32_at(self.admins_at + id * 4 + 4) as usize;
        from_utf8(&TABLE[self.admin_bytes_at + a..self.admin_bytes_at + b])
            .unwrap_or_default()
    }

    fn cc(&self, i: usize) -> &'static str {
        let at = self.pts_at + i * STRIDE + 18;
        from_utf8(&TABLE[at..at + 2]).unwrap_or_default()
    }
}

/// Squared chord distance from the query unit vector to point `i`.
fn dist2(c: &Cities, i: usize, q: (f64, f64, f64)) -> f64 {
    let (x, y, z) = c.xyz(i);
    let (dx, dy, dz) = (x - q.0, y - q.1, z - q.2);
    dx * dx + dy * dy + dz * dz
}

fn descend(c: &Cities, node: usize, depth: usize, q: (f64, f64, f64), best: &mut (f64, usize)) {
    if node >= c.count {
        return;
    }
    let d = dist2(c, node, q);
    if d < best.0 {
        *best = (d, node);
    }
    let (x, y, z) = c.xyz(node);
    let split = match depth % 3 {
        0 => q.0 - x,
        1 => q.1 - y,
        _ => q.2 - z,
    };
    let (near, far) = if split < 0.0 {
        (2 * node + 1, 2 * node + 2)
    } else {
        (2 * node + 2, 2 * node + 1)
    };
    descend(c, near, depth + 1, q, best);
    if split * split < best.0 {
        descend(c, far, depth + 1, q, best);
    }
}

/// Index of the city nearest `(lat, lng)`, or `None` when the table is empty.
fn nearest(lat: f64, lng: f64) -> Option<usize> {
    let c = cities();
    if c.count == 0 {
        return None;
    }
    let (rlat, rlng) = (lat.to_radians(), lng.to_radians());
    let q = (rlat.cos() * rlng.cos(), rlat.cos() * rlng.sin(), rlat.sin());
    let mut best = (f64::INFINITY, 0usize);
    descend(c, 0, 0, q, &mut best);
    best.0.is_finite().then_some(best.1)
}

/// Reverse geocode result: nearest populated place to a coordinate.
#[derive(Serialize, specta::Type)]
pub struct GeoResult {
    pub city: String,
    /// First-level administrative division (state, province, region).
    pub admin: String,
    pub country: String,
    /// ISO 3166-1 alpha-2 (e.g. "US", "FR").
    pub country_code: String,
}

/// Build the table's header ahead of the first lookup.
pub fn warm() {
    cities();
}

/// Return the nearest city, administrative region, and country for a coordinate.
/// Always returns `Some` - the dataset covers every landmass.
#[tauri::command]
#[specta::specta]
pub fn reverse_geocode(lat: f64, lng: f64) -> Option<GeoResult> {
    let c = cities();
    nearest(lat, lng).map(|i| GeoResult {
        city: c.name(i).to_string(),
        admin: c.admin(i).to_string(),
        country: c.cc(i).to_string(),
        country_code: c.cc(i).to_string(),
    })
}

#[cfg(test)]
#[path = "geocoder.test.rs"]
mod tests;
