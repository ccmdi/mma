#[allow(non_camel_case_types)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub enum HashPrecision {
    Size_km_5000x5000 = 1,
    Size_km_1250x625 = 2,
    Size_km_156x156 = 3,
    Size_km_39x20 = 4,
    Size_km_5x5 = 5,
    Size_km_1x1 = 6,
    Size_m_153x153 = 7,
    Size_m_38x19 = 8,
    Size_m_5x5 = 9,
    Size_m_1x1 = 10,
    Size_mm_149x149 = 11,
    Size_mm_37x19 = 12,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lng: f64,
    pub max_lng: f64,
}
const PAYLOAD_MASK: u64 = 0x0FFF_FFFF_FFFF_FFFF;
pub fn encode(latitude: f64, longitude: f64, precision: HashPrecision) -> u64 {
    let p = precision as i32;
    let total_bits = (p * 5) as u32;
    let lat_bits = total_bits / 2;
    let lng_bits = total_bits - lat_bits;
    let lat = (latitude + 90.0) / 180.0;
    let lng = (longitude + 180.0) / 360.0;
    let lat_val = encode_range(lat, lat_bits);
    let lng_val = encode_range(lng, lng_bits);
    let interleaved = interleave(lat_val, lng_val, total_bits);
    ((p as u64) << 60) | (interleaved << (60 - total_bits))
}
pub fn bounding_box(hash: u64) -> BoundingBox {
    let p = (hash >> 60) as i32;
    let total_bits = (p * 5) as u32;
    let lat_bits = total_bits / 2;
    let lng_bits = total_bits - lat_bits;
    let interleaved = (hash & PAYLOAD_MASK) >> (60 - total_bits);
    let (lat_val, lng_val) = deinterleave(interleaved, total_bits);
    let lat_range = (1u64 << lat_bits) as f64;
    let lng_range = (1u64 << lng_bits) as f64;
    BoundingBox {
        min_lat: lat_val as f64 / lat_range * 180.0 - 90.0,
        max_lat: (lat_val + 1) as f64 / lat_range * 180.0 - 90.0,
        min_lng: lng_val as f64 / lng_range * 360.0 - 180.0,
        max_lng: (lng_val + 1) as f64 / lng_range * 360.0 - 180.0,
    }
}
const DLAT: [i64; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const DLNG: [i64; 8] = [0, 1, 1, 1, 0, -1, -1, -1];
pub fn neighbors(hash: u64) -> [u64; 8] {
    let p = (hash >> 60) as i32;
    let total_bits = (p * 5) as u32;
    let lat_bits = total_bits / 2;
    let lng_bits = total_bits - lat_bits;
    let interleaved = (hash & PAYLOAD_MASK) >> (60 - total_bits);
    let (lat_val, lng_val) = deinterleave(interleaved, total_bits);
    let lat_range = (1u64 << lat_bits) as i64;
    let lng_range = (1u64 << lng_bits) as i64;
    let mut result = [0u64; 8];
    for i in 0..8 {
        let mut new_lat = lat_val as i64 + DLAT[i];
        let mut new_lng = lng_val as i64 + DLNG[i];
        if new_lat < 0 {
            new_lat = 0;
        }
        if new_lat >= lat_range {
            new_lat = lat_range - 1;
        }
        if new_lng < 0 {
            new_lng += lng_range;
        }
        if new_lng >= lng_range {
            new_lng -= lng_range;
        }
        let ni = interleave(new_lat as u64, new_lng as u64, total_bits);
        result[i] = ((p as u64) << 60) | (ni << (60 - total_bits));
    }
    result
}
#[inline]
fn encode_range(normalized: f64, bits: u32) -> u64 {
    let range = 1u64 << bits;
    let val = (normalized * range as f64) as u64;
    if val >= range {
        range - 1
    } else {
        val
    }
}
#[inline]
fn spread(mut x: u64) -> u64 {
    x &= 0x3FFF_FFFF;
    x = (x | (x << 16)) & 0x0000_FFFF_0000_FFFF;
    x = (x | (x << 8)) & 0x00FF_00FF_00FF_00FF;
    x = (x | (x << 4)) & 0x0F0F_0F0F_0F0F_0F0F;
    x = (x | (x << 2)) & 0x3333_3333_3333_3333;
    x = (x | (x << 1)) & 0x5555_5555_5555_5555;
    x
}
#[inline]
fn compact(mut x: u64) -> u64 {
    x &= 0x5555_5555_5555_5555;
    x = (x | (x >> 1)) & 0x3333_3333_3333_3333;
    x = (x | (x >> 2)) & 0x0F0F_0F0F_0F0F_0F0F;
    x = (x | (x >> 4)) & 0x00FF_00FF_00FF_00FF;
    x = (x | (x >> 8)) & 0x0000_FFFF_0000_FFFF;
    x = (x | (x >> 16)) & 0x0000_0000_FFFF_FFFF;
    x
}
#[inline]
fn interleave(lat_val: u64, lng_val: u64, total_bits: u32) -> u64 {
    if total_bits % 2 == 0 {
        spread(lat_val) | (spread(lng_val) << 1)
    } else {
        spread(lng_val) | (spread(lat_val) << 1)
    }
}
#[inline]
fn deinterleave(interleaved: u64, total_bits: u32) -> (u64, u64) {
    if total_bits % 2 == 0 {
        (compact(interleaved), compact(interleaved >> 1))
    } else {
        (compact(interleaved >> 1), compact(interleaved))
    }
}
