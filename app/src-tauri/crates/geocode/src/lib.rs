//! Offline reverse geocoding over a packed table read in place -- no parse, no index build,
//! no resident heap. Points are unit-sphere vectors stored in implicit kd-tree order
//! (children of node `i` at `2i+1`/`2i+2`); ranking uses squared chord distance, which is
//! monotonic with great-circle distance, so nearest-by-chord equals nearest-by-haversine.
//! Table layout lives in `scripts/gen-cities-bin.mjs`; `lib.test.rs` diffs every lookup
//! against the `reverse_geocoder` crate.

#[cfg(target_endian = "big")]
compile_error!("mma-geocode reads little-endian tables in place");

use std::str::from_utf8;

const HEADER_LEN: usize = 48;
const XYZ_STRIDE: usize = 12;
const PAYLOAD_STRIDE: usize = 6;
const NAME_BLOCK: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadMagic,
    UnsupportedVersion(u32),
    Truncated,
    /// The table must start on a 4-byte boundary (e.g. `include_bytes!` output wrapped in a
    /// `#[repr(align(4))]` struct) so coordinates can be viewed as `f32` in place.
    Misaligned,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadMagic => write!(f, "not a packed cities table"),
            Error::UnsupportedVersion(v) => write!(f, "unsupported table version {v}"),
            Error::Truncated => write!(f, "table shorter than its header claims"),
            Error::Misaligned => write!(f, "table not 4-byte aligned"),
        }
    }
}

impl std::error::Error for Error {}

pub struct Geocoder<'a> {
    data: &'a [u8],
    xyz: &'a [f32],
    count: usize,
    payload_at: usize,
    name_index_at: usize,
    name_data_at: usize,
    admin_index_at: usize,
    admin_bytes_at: usize,
    ccs_at: usize,
}

/// One row of the table. `admin1` and `country_code` borrow from the table; `lat`/`lng` are
/// recovered from the stored unit vector (~1e-5 degrees).
#[derive(Debug, Clone)]
pub struct Record<'a> {
    pub name: String,
    pub admin1: &'a str,
    pub country_code: &'a str,
    pub lat: f64,
    pub lng: f64,
}

impl<'a> Geocoder<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, Error> {
        if data.len() < HEADER_LEN {
            return Err(Error::Truncated);
        }
        let u32_at = |off: usize| u32::from_le_bytes(data[off..off + 4].try_into().unwrap());
        if &data[0..4] != b"MMAC" {
            return Err(Error::BadMagic);
        }
        let version = u32_at(4);
        if version != 4 {
            return Err(Error::UnsupportedVersion(version));
        }
        let count = u32_at(8) as usize;
        let admin_count = u32_at(12) as usize;
        let xyz_at = u32_at(20) as usize;
        let payload_at = u32_at(24) as usize;
        let names_at = u32_at(28) as usize;
        let admins_at = u32_at(32) as usize;
        let ccs_at = u32_at(36) as usize;

        let xyz_bytes = data
            .get(xyz_at..xyz_at.saturating_add(count * XYZ_STRIDE))
            .ok_or(Error::Truncated)?;
        let (head, xyz, _) = unsafe { xyz_bytes.align_to::<f32>() };
        if !head.is_empty() {
            return Err(Error::Misaligned);
        }
        let names_end = names_at.checked_add(4).ok_or(Error::Truncated)?;
        if data.len() < payload_at.saturating_add(count * PAYLOAD_STRIDE) || data.len() < names_end {
            return Err(Error::Truncated);
        }
        let restarts = u32_at(names_at) as usize;
        Ok(Self {
            data,
            xyz,
            count,
            payload_at,
            name_index_at: names_at + 4,
            name_data_at: names_at + 4 + (restarts + 1) * 4,
            admin_index_at: admins_at,
            admin_bytes_at: admins_at + (admin_count + 1) * 4,
            ccs_at,
        })
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// The record nearest to `(lat, lng)` by great-circle distance, or `None` on an empty table.
    pub fn nearest(&self, lat: f64, lng: f64) -> Option<Record<'a>> {
        if self.count == 0 {
            return None;
        }
        let (rlat, rlng) = (lat.to_radians(), lng.to_radians());
        let q = (rlat.cos() * rlng.cos(), rlat.cos() * rlng.sin(), rlat.sin());
        let mut best = (f64::INFINITY, 0usize);
        self.descend(0, 0, q, &mut best);
        best.0.is_finite().then(|| self.record(best.1))
    }

    pub fn get(&self, i: usize) -> Option<Record<'a>> {
        (i < self.count).then(|| self.record(i))
    }

    #[inline]
    fn point(&self, i: usize) -> (f64, f64, f64) {
        debug_assert!(i < self.count);
        let at = i * 3;
        // SAFETY: `new` checked xyz holds exactly `count * 3` floats and callers keep i < count.
        unsafe {
            (
                *self.xyz.get_unchecked(at) as f64,
                *self.xyz.get_unchecked(at + 1) as f64,
                *self.xyz.get_unchecked(at + 2) as f64,
            )
        }
    }

    fn descend(&self, node: usize, depth: usize, q: (f64, f64, f64), best: &mut (f64, usize)) {
        if node >= self.count {
            return;
        }
        let (x, y, z) = self.point(node);
        let (dx, dy, dz) = (x - q.0, y - q.1, z - q.2);
        let d = dx * dx + dy * dy + dz * dz;
        if d < best.0 {
            *best = (d, node);
        }
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
        self.descend(near, depth + 1, q, best);
        if split * split < best.0 {
            self.descend(far, depth + 1, q, best);
        }
    }

    fn record(&self, i: usize) -> Record<'a> {
        let (x, y, z) = self.point(i);
        Record {
            name: self.name(i),
            admin1: self.admin1(i),
            country_code: self.country_code(i),
            lat: z.asin().to_degrees(),
            lng: y.atan2(x).to_degrees(),
        }
    }

    fn name(&self, i: usize) -> String {
        let d = self.data;
        let idx = d[self.payload_at + i * PAYLOAD_STRIDE] as usize
            | (d[self.payload_at + i * PAYLOAD_STRIDE + 1] as usize) << 8
            | (d[self.payload_at + i * PAYLOAD_STRIDE + 2] as usize) << 16;
        let block = u32::from_le_bytes(
            d[self.name_index_at + (idx / NAME_BLOCK) * 4..][..4].try_into().unwrap(),
        ) as usize;
        let mut at = self.name_data_at + block;
        let mut buf: Vec<u8> = Vec::new();
        for _ in 0..=(idx % NAME_BLOCK) {
            let shared = d[at] as usize;
            let len = d[at + 1] as usize;
            buf.truncate(shared);
            buf.extend_from_slice(&d[at + 2..at + 2 + len]);
            at += 2 + len;
        }
        String::from_utf8(buf).unwrap_or_default()
    }

    fn admin1(&self, i: usize) -> &'a str {
        let d = self.data;
        let id = u16::from_le_bytes(
            d[self.payload_at + i * PAYLOAD_STRIDE + 3..][..2].try_into().unwrap(),
        ) as usize;
        let a = u32::from_le_bytes(d[self.admin_index_at + id * 4..][..4].try_into().unwrap());
        let b = u32::from_le_bytes(d[self.admin_index_at + id * 4 + 4..][..4].try_into().unwrap());
        from_utf8(&d[self.admin_bytes_at + a as usize..self.admin_bytes_at + b as usize])
            .unwrap_or_default()
    }

    fn country_code(&self, i: usize) -> &'a str {
        let d = self.data;
        let at = self.ccs_at + d[self.payload_at + i * PAYLOAD_STRIDE + 5] as usize * 2;
        from_utf8(&d[at..at + 2]).unwrap_or_default()
    }
}

#[cfg(test)]
#[path = "lib.test.rs"]
mod tests;
