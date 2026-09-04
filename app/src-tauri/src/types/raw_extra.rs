//! `RawExtra`: a location's `extra` map kept as raw JSON bytes, with the byte-level scanner that reads fields out of it without building a map.

use serde::de;
use serde::de::value::MapAccessDeserializer;
use serde::de::MapAccess;
use serde::de::Visitor;
use serde_json::value::RawValue;
use std::borrow::Cow;
use std::fmt;
use std::fmt::Formatter;
use std::ops::Range;
use std::sync::Arc;

/// `Location.extra` stored as its raw JSON bytes instead of a parsed map.
///
/// Over IPC/JSON and into the Arrow `extra` string column it emits transparently, so
/// those formats are unchanged. The binary (rmp) encoding used for delta sidecars and
/// undo blobs now writes a plain string; legacy shipped builds wrote a map there, so the
/// `Deserialize` impl accepts both (see [`BinRawExtraVisitor`]). Parsing happens only
/// when a consumer needs keyed access, via [`RawExtra::to_map`] (deep) or
/// [`RawExtra::get`]/[`RawExtra::for_each_field`] (zero-alloc byte scan).
#[derive(Clone, Debug)]
pub struct RawExtra(Arc<Box<RawValue>>);

impl RawExtra {
    /// Share an owned raw value. `Location` clones sit on the bulk-update and undo paths,
    /// so the JSON payload is refcounted rather than copied. `Arc::new` over the existing
    /// `Box` keeps construction to one pointer-sized allocation -- `Arc::from(box)` would
    /// reallocate and copy the payload, which costs more than the clone saves.
    pub(super) fn wrap(rv: Box<RawValue>) -> Self {
        RawExtra(Arc::new(rv))
    }

    /// Wrap an existing JSON string (e.g. from the Arrow column). Returns `None` for
    /// an empty object or an invalid JSON value, matching the `Option<...>` "no extra".
    pub fn from_string(s: String) -> Option<Self> {
        let rv = RawValue::from_string(s).ok()?;
        if is_empty_object(rv.get()) {
            return None;
        }
        Some(RawExtra::wrap(canonicalize_keys(rv)))
    }

    /// Build from a JSON value (an object). `None` if not an object or empty.
    #[allow(dead_code, reason = "exercised by tests; no production caller")]
    pub fn from_value(v: &serde_json::Value) -> Option<Self> {
        v.as_object().and_then(Self::from_map)
    }

    /// Test-only: wrap a JSON string verbatim, skipping key canonicalization -- the shape
    /// of blobs written to disk before canonicalization existed.
    #[cfg(test)]
    pub(crate) fn from_string_uncanonicalized(s: &str) -> Option<Self> {
        RawValue::from_string(s.to_string())
            .ok()
            .map(RawExtra::wrap)
    }

    /// Build from a map. `None` if the map is empty.
    pub fn from_map(m: &serde_json::Map<String, serde_json::Value>) -> Option<Self> {
        if m.is_empty() {
            return None;
        }
        let s = serde_json::to_string(m).ok()?;
        RawValue::from_string(s).ok().map(RawExtra::wrap)
    }

    /// The raw JSON bytes -- what gets written to the Arrow column.
    pub fn as_str(&self) -> &str {
        self.0.get()
    }

    /// Deep-parse into an owned map. Use only when full values are actually needed.
    pub fn to_map(&self) -> serde_json::Map<String, serde_json::Value> {
        serde_json::from_str(self.0.get()).unwrap_or_default()
    }

    /// One field's value, parsed on demand. Zero-alloc scan to the key; only the
    /// matching value slice is parsed. Keys are matched on raw bytes, which is exact
    /// because every constructor canonicalizes them (see [`canonicalize_keys`]).
    pub fn get(&self, key: &str) -> Option<serde_json::Value> {
        json_field(self.0.get(), key)
    }

    /// Visit each top-level `(key, raw_value)` without allocating a map. `raw_value` is
    /// the value's raw JSON slice. Cheap field discovery / counting; nested keys are not
    /// visited (the scan jumps over object/array values). String/escape aware.
    pub fn for_each_field(&self, mut f: impl FnMut(&str, &str)) {
        let s = self.0.get();
        let b = s.as_bytes();
        scan_fields(b, |fs| {
            f(&s[fs.key.clone()], &s[fs.value.clone()]);
            false
        });
    }
}

/// Decode JSON-escaped member keys (`ensure_ascii` encoders unicode-escape `café`) so
/// raw-byte key matching sees one spelling. A doc with no escaped key is returned as-is.
pub(super) fn canonicalize_keys(rv: Box<RawValue>) -> Box<RawValue> {
    if !has_escaped_key(rv.get()) {
        return rv;
    }
    let Ok(m) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(rv.get()) else {
        return rv;
    };
    serde_json::to_string(&m)
        .ok()
        .and_then(|s| RawValue::from_string(s).ok())
        .unwrap_or(rv)
}

pub(super) fn has_escaped_key(s: &str) -> bool {
    let b = s.as_bytes();
    if memchr::memchr(b'\\', b).is_none() {
        return false;
    }
    let mut hit = false;
    scan_fields(b, |fs| {
        hit = memchr::memchr(b'\\', &b[fs.key.clone()]).is_some();
        hit
    });
    hit
}

/// Decode a key captured from raw JSON source (e.g. by [`RawExtra::for_each_field`]) into
/// the text it denotes. Returned unchanged when there is nothing to decode.
pub(crate) fn decode_json_key(key: &str) -> Cow<'_, str> {
    if !key.contains('\\') {
        return Cow::Borrowed(key);
    }
    match serde_json::from_str::<String>(&format!("\"{key}\"")) {
        Ok(decoded) => Cow::Owned(decoded),
        Err(_) => Cow::Borrowed(key),
    }
}

/// One top-level member's value from raw object-JSON, without parsing the whole
/// document. First match wins; raw-byte key match (same contract as [`RawExtra::get`]).
pub(crate) fn json_field(s: &str, key: &str) -> Option<serde_json::Value> {
    let b = s.as_bytes();
    let mut out = None;
    scan_fields(b, |fs| {
        if &b[fs.key.clone()] == key.as_bytes() {
            out = serde_json::from_str(&s[fs.value.clone()]).ok();
            true
        } else {
            false
        }
    });
    out
}

/// One top-level member found by [`scan_fields`]: the key's content bytes (without
/// quotes; the opening quote is at `key.start - 1`) and the value's exact byte range.
pub(crate) struct FieldSpan {
    pub key: Range<usize>,
    pub value: Range<usize>,
}

/// Walk the top-level members of object JSON `b`, calling `f` for each; `f` returns
/// `true` to stop early. String/escape aware, and nested objects/arrays are skipped
/// wholesale, so a matching key inside a value is never yielded.
pub(crate) fn scan_fields(b: &[u8], f: impl FnMut(&FieldSpan) -> bool) {
    scan_fields_from(b, 0, 0, f);
}

/// [`scan_fields`] resumed mid-document: begins at byte `start`, with `start_depth`
/// as the nesting depth already open there.
pub(crate) fn scan_fields_from(
    b: &[u8],
    start: usize,
    start_depth: i32,
    mut f: impl FnMut(&FieldSpan) -> bool,
) {
    let mut i = start;
    let mut depth = start_depth;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                i += 1;
            }
            b'"' => {
                let kstart = i + 1;
                let kend = skip_string(b, kstart); // just past the closing quote
                i = kend;
                if depth == 1 && kend > kstart {
                    let mut j = kend;
                    while j < b.len() && is_ws(b[j]) {
                        j += 1;
                    }
                    if j < b.len() && b[j] == b':' {
                        let mut v = j + 1;
                        while v < b.len() && is_ws(b[v]) {
                            v += 1;
                        }
                        let vend = skip_value(b, v);
                        if f(&FieldSpan {
                            key: kstart..kend - 1,
                            value: v..vend,
                        }) {
                            return;
                        }
                        i = vend;
                    }
                }
            }
            _ => i += 1,
        }
    }
}

#[inline]
pub(crate) fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

/// Given the index just past an opening `"`, return the index just past the
/// matching closing `"`, honoring backslash escapes. Uses memchr (SIMD) to jump
/// between quote candidates instead of inspecting every byte.
#[inline]
pub(crate) fn skip_string(bytes: &[u8], from: usize) -> usize {
    let mut search = from;
    while let Some(off) = memchr::memchr(b'"', &bytes[search..]) {
        let q = search + off;
        // Count consecutive backslashes immediately before the quote (down to,
        // but not past, the first content byte `from`). Even count => the quote
        // is unescaped and closes the string.
        let mut k = q;
        while k > from && bytes[k - 1] == b'\\' {
            k -= 1;
        }
        if (q - k).is_multiple_of(2) {
            return q + 1;
        }
        search = q + 1;
    }
    bytes.len()
}

/// Index just past the JSON value starting at `from` (string, object/array, or scalar).
pub(crate) fn skip_value(b: &[u8], from: usize) -> usize {
    match b.get(from) {
        Some(b'"') => skip_string(b, from + 1),
        Some(b'{') | Some(b'[') => {
            let (mut i, mut d) = (from + 1, 1i32);
            while i < b.len() && d > 0 {
                match b[i] {
                    b'"' => i = skip_string(b, i + 1),
                    b'{' | b'[' => {
                        d += 1;
                        i += 1;
                    }
                    b'}' | b']' => {
                        d -= 1;
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            i
        }
        _ => {
            let mut i = from;
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']') {
                i += 1;
            }
            i
        }
    }
}

pub(super) fn is_empty_object(s: &str) -> bool {
    let t = s.trim();
    t == "{}" || (t.starts_with('{') && t.ends_with('}') && t[1..t.len() - 1].trim().is_empty())
}

impl PartialEq for RawExtra {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || self.0.get() == other.0.get()
    }
}

// `RawValue` only round-trips through serde_json (its serialize/deserialize use a
// private magic token that only serde_json honors). So for human-readable formats
// (serde_json -- IPC to JS, on-disk JSON) we emit/read the object transparently, and
// for binary formats (rmp_serde -- delta overlay + undo stack persistence) we fall
// back to a plain string carrying the same raw JSON.
impl serde::Serialize for RawExtra {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            (**self.0).serialize(s)
        } else {
            s.serialize_str(self.0.get())
        }
    }
}

impl<'de> serde::Deserialize<'de> for RawExtra {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if d.is_human_readable() {
            Box::<RawValue>::deserialize(d)
                .map(canonicalize_keys)
                .map(RawExtra::wrap)
        } else {
            d.deserialize_any(BinRawExtraVisitor)
        }
    }
}

pub(super) struct BinRawExtraVisitor;

impl<'de> Visitor<'de> for BinRawExtraVisitor {
    type Value = RawExtra;

    fn expecting(&self, f: &mut Formatter) -> fmt::Result {
        f.write_str("a raw-JSON extra string or a legacy extra map")
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<RawExtra, E> {
        self.visit_string(v.to_owned())
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<RawExtra, E> {
        RawValue::from_string(v)
            .map(canonicalize_keys)
            .map(RawExtra::wrap)
            .map_err(E::custom)
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<RawExtra, A::Error> {
        let m = <serde_json::Map<String, serde_json::Value> as serde::Deserialize>::deserialize(
            MapAccessDeserializer::new(map),
        )?;
        let s = serde_json::to_string(&m).map_err(de::Error::custom)?;
        RawValue::from_string(s)
            .map(RawExtra::wrap)
            .map_err(de::Error::custom)
    }
}
