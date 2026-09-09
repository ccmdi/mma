//! Coordinate -> IANA zone id from tz-lookup's packed quadtree, read in place.
//! `data/tzgrid.bin` is that library's own tree and zone list repacked verbatim by
//! `scripts/gen-tzgrid.mjs`, and this walk is a port of its decoder: a 48x24 root grid,
//! then quadtree descent with delta-coded node indices; `grid.test.rs` diffs against a
//! fixture answered by the JS itself.

use crate::Error;
use std::str::from_utf8;

const HEADER_LEN: usize = 16;

pub struct TzGrid<'a> {
    data: &'a [u8],
    zone_count: usize,
    names_idx_at: usize,
    names_at: usize,
    tree_at: usize,
    etc_gmt: usize,
}

impl<'a> TzGrid<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, Error> {
        if data.len() < HEADER_LEN {
            return Err(Error::Truncated);
        }
        let u32_at = |off: usize| u32::from_le_bytes(data[off..off + 4].try_into().unwrap());
        if &data[0..4] != b"TZGR" {
            return Err(Error::BadMagic);
        }
        let version = u32_at(4);
        if version != 1 {
            return Err(Error::UnsupportedVersion(version));
        }
        let zone_count = u32_at(8) as usize;
        let tree_len = u32_at(12) as usize;
        let names_idx_at = HEADER_LEN;
        let names_at = names_idx_at + (zone_count + 1) * 4;
        if data.len() < names_at {
            return Err(Error::Truncated);
        }
        let tree_at = names_at + u32_at(names_idx_at + zone_count * 4) as usize;
        if data.len() < tree_at + tree_len {
            return Err(Error::Truncated);
        }
        let g = TzGrid {
            data,
            zone_count,
            names_idx_at,
            names_at,
            tree_at,
            etc_gmt: 0,
        };
        let etc_gmt = (0..zone_count)
            .find(|&i| g.zone_name(i) == "Etc/GMT")
            .ok_or(Error::Truncated)?;
        Ok(TzGrid { etc_gmt, ..g })
    }

    pub fn zone_name(&self, i: usize) -> &'a str {
        let u32_at = |off: usize| {
            u32::from_le_bytes(self.data[off..off + 4].try_into().unwrap()) as usize
        };
        let a = u32_at(self.names_idx_at + i * 4);
        let b = u32_at(self.names_idx_at + i * 4 + 4);
        from_utf8(&self.data[self.names_at + a..self.names_at + b]).unwrap_or_default()
    }

    /// IANA zone at a coordinate; `None` outside [-90, 90] x [-180, 180] (NaN included).
    pub fn zone_at(&self, lat: f64, lng: f64) -> Option<&'a str> {
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lng) {
            return None;
        }
        if lat >= 90.0 {
            return Some(self.zone_name(self.etc_gmt));
        }
        let tree = &self.data[self.tree_at..];
        let at = |k: i64| -> Option<i64> {
            let k = usize::try_from(k).ok()?;
            Some(56 * (*tree.get(k)? as i64) + (*tree.get(k + 1)? as i64) - 1995)
        };
        // tz-lookup's decoder verbatim, denominators included: they keep 180/-180 and
        // the poles inside the last cell.
        let mut s = 48.0 * (180.0 + lng) / 360.000_000_000_000_06;
        let mut u = 24.0 * (90.0 - lat) / 180.000_000_000_000_03;
        let mut zi = s as i64;
        let mut ui = u as i64;
        let mut v: i64 = -1;
        let mut k = at(96 * ui + 2 * zi)?;
        let n = self.zone_count as i64;
        for _ in 0..64 {
            if k + n >= 3136 {
                return Some(self.zone_name(usize::try_from(k + n - 3136).ok()?));
            }
            v = v + k + 1;
            u = 2.0 * (u - ui as f64) % 2.0;
            ui = u as i64;
            s = 2.0 * (s - zi as f64) % 2.0;
            zi = s as i64;
            k = at(8 * v + 4 * ui + 2 * zi + 2304)?;
        }
        None
    }
}

#[cfg(test)]
#[path = "grid.test.rs"]
mod grid_tests;
