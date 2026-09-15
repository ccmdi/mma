use vali_core::{GoogleData, Location, NominatimData, OsmData};

/// Cursor over a protobuf byte slice. Shared by every decoder in the workspace.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    pub fn at_end(&self) -> bool {
        self.pos >= self.buf.len()
    }
    #[inline]
    pub fn read_varint(&mut self) -> anyhow::Result<u64> {
        if let Some(chunk) = self.buf.get(self.pos..self.pos + 10) {
            let mut result: u64 = 0;
            for (i, &byte) in chunk.iter().enumerate() {
                result |= ((byte & 0x7f) as u64) << (7 * i as u32);
                if byte & 0x80 == 0 {
                    self.pos += i + 1;
                    return Ok(result);
                }
            }
            anyhow::bail!("varint exceeds 64 bits");
        }
        self.read_varint_slow()
    }
    fn read_varint_slow(&mut self) -> anyhow::Result<u64> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let byte = *self
                .buf
                .get(self.pos)
                .ok_or_else(|| anyhow::anyhow!("varint truncated at {}", self.pos))?;
            self.pos += 1;
            result |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift >= 64 {
                anyhow::bail!("varint exceeds 64 bits");
            }
        }
    }
    pub fn read_tag(&mut self) -> anyhow::Result<(u32, u8)> {
        let key = self.read_varint()?;
        Ok(((key >> 3) as u32, (key & 7) as u8))
    }
    pub fn read_f64(&mut self) -> anyhow::Result<f64> {
        let end = self.pos + 8;
        let slice = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| anyhow::anyhow!("f64 truncated"))?;
        self.pos = end;
        Ok(f64::from_le_bytes(slice.try_into().unwrap()))
    }
    pub fn read_len_slice(&mut self) -> anyhow::Result<&'a [u8]> {
        // The length is wire-controlled, so the end offset can overflow on a corrupt buffer.
        let len = self.read_varint()? as usize;
        let slice = self
            .pos
            .checked_add(len)
            .and_then(|end| self.buf.get(self.pos..end))
            .ok_or_else(|| anyhow::anyhow!("len-delimited field truncated"))?;
        self.pos += len;
        Ok(slice)
    }
    pub fn read_string(&mut self) -> anyhow::Result<compact_str::CompactString> {
        Ok(compact_str::CompactString::from_utf8(
            self.read_len_slice()?,
        )?)
    }
    /// Length-delimited field as a lossy UTF-8 `String`, for wire formats that may carry
    /// invalid UTF-8 rather than treating it as a decode failure.
    pub fn read_string_lossy(&mut self) -> anyhow::Result<String> {
        Ok(String::from_utf8_lossy(self.read_len_slice()?).into_owned())
    }
    pub fn read_i64(&mut self) -> anyhow::Result<i64> {
        Ok(self.read_varint()? as i64)
    }
    pub fn read_i32(&mut self) -> anyhow::Result<i32> {
        Ok(self.read_varint()? as i64 as i32)
    }
    pub fn read_bool(&mut self) -> anyhow::Result<bool> {
        Ok(self.read_varint()? != 0)
    }
    /// Advance past an unknown field of the given wire type.
    pub fn skip(&mut self, wire: u8) -> anyhow::Result<()> {
        match wire {
            0 => {
                self.read_varint()?;
            }
            1 => self.advance(8)?,
            2 => {
                let len = self.read_varint()? as usize;
                self.advance(len)?;
            }
            5 => self.advance(4)?,
            other => anyhow::bail!("unsupported wire type {other}"),
        }
        Ok(())
    }
    pub fn advance(&mut self, n: usize) -> anyhow::Result<()> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len());
        self.pos = end.ok_or_else(|| anyhow::anyhow!("unexpected end of buffer"))?;
        Ok(())
    }
}
pub fn decode_locations(buf: &[u8]) -> anyhow::Result<Vec<Location>> {
    let mut r = Reader::new(buf);
    let mut out = Vec::with_capacity(buf.len() / 160);
    while !r.at_end() {
        let (field, wire) = r.read_tag()?;
        if field == 1 && wire == 2 {
            out.push(decode_location(r.read_len_slice()?)?);
        } else {
            r.skip(wire)?;
        }
    }
    Ok(out)
}
fn decode_location(buf: &[u8]) -> anyhow::Result<Location> {
    let mut r = Reader::new(buf);
    let mut loc = Location::default();
    while !r.at_end() {
        let (field, wire) = r.read_tag()?;
        match (field, wire) {
            (1, 0) => loc.node_id = r.read_i64()?,
            (2, 1) => loc.lat = r.read_f64()?,
            (3, 1) => loc.lng = r.read_f64()?,
            (4, 2) => loc.google = decode_google(r.read_len_slice()?)?,
            (5, 2) => loc.osm = decode_osm(r.read_len_slice()?)?,
            (6, 2) => loc.nominatim = decode_nominatim(r.read_len_slice()?)?,
            _ => r.skip(wire)?,
        }
    }
    Ok(loc)
}
fn decode_google(buf: &[u8]) -> anyhow::Result<GoogleData> {
    let mut r = Reader::new(buf);
    let mut g = GoogleData::default();
    while !r.at_end() {
        let (field, wire) = r.read_tag()?;
        match (field, wire) {
            (1, 2) => g.pano_id = r.read_string()?,
            (2, 1) => g.lat = r.read_f64()?,
            (3, 1) => g.lng = r.read_f64()?,
            (4, 1) => g.default_heading = r.read_f64()?,
            (5, 2) => g.country_code = r.read_string()?,
            (7, 0) => g.year = r.read_i32()?,
            (8, 0) => g.month = r.read_i32()?,
            (9, 0) => g.driving_direction_angle = r.read_i32()?,
            (10, 0) => g.arrow_count = r.read_i32()?,
            (11, 0) => g.elevation = Some(r.read_i32()?),
            (12, 0) => g.description_length = Some(r.read_i32()?),
            (13, 0) => g.is_scout = r.read_bool()?,
            (14, 0) => g.resolution_height = r.read_i32()?,
            _ => r.skip(wire)?,
        }
    }
    Ok(g)
}
fn decode_osm(buf: &[u8]) -> anyhow::Result<OsmData> {
    let mut r = Reader::new(buf);
    let mut o = OsmData::default();
    while !r.at_end() {
        let (field, wire) = r.read_tag()?;
        match (field, wire) {
            (1, 0) => o.buildings10 = r.read_i32()?,
            (2, 0) => o.buildings25 = r.read_i32()?,
            (3, 0) => o.buildings100 = r.read_i32()?,
            (4, 0) => o.buildings200 = r.read_i32()?,
            (5, 0) => o.roads10 = r.read_i32()?,
            (6, 0) => o.roads25 = r.read_i32()?,
            (7, 0) => o.roads50 = r.read_i32()?,
            (8, 0) => o.roads100 = r.read_i32()?,
            (9, 0) => o.roads200 = r.read_i32()?,
            (10, 0) => o.tunnels10 = r.read_i32()?,
            (11, 0) => o.tunnels200 = r.read_i32()?,
            (12, 0) => o.is_residential = r.read_bool()?,
            (13, 2) => o.surface = Some(r.read_string()?),
            (14, 0) => o.roads0 = r.read_i32()?,
            (15, 0) => o.closest_coast = Some(r.read_i32()?),
            (16, 0) => o.road_type = r.read_varint()? as u32,
            (17, 0) => o.closest_lake = Some(r.read_i32()?),
            (18, 0) => o.closest_river = Some(r.read_i32()?),
            (19, 0) => o.closest_railway = Some(r.read_i32()?),
            (20, 2) => {
                let mut rr = Reader::new(r.read_len_slice()?);
                while !rr.at_end() {
                    o.way_ids.push(rr.read_i64()?);
                }
            }
            (20, 0) => o.way_ids.push(r.read_i64()?),
            _ => r.skip(wire)?,
        }
    }
    Ok(o)
}
fn decode_nominatim(buf: &[u8]) -> anyhow::Result<NominatimData> {
    let mut r = Reader::new(buf);
    let mut n = NominatimData::default();
    while !r.at_end() {
        let (field, wire) = r.read_tag()?;
        match (field, wire) {
            (1, 2) => n.country_code = r.read_string()?,
            (2, 2) => n.subdivision_code = r.read_string()?,
            (3, 2) => n.county = Some(r.read_string()?),
            _ => r.skip(wire)?,
        }
    }
    Ok(n)
}

#[cfg(test)]
#[path = "decode.test.rs"]
mod tests;
