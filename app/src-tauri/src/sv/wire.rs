//! One reader for two encodings of the same message. Google answers the MapsJs RPCs as
//! binary protobuf or as array-JSON, in which index i holds field i+1; a [`Node`] is a
//! message in either form and answers by field number, so everything that reads a message
//! is written once. Field numbers live in `app/src/lib/proto/*.proto`.

use std::str;

use serde_json::Value;

#[derive(Clone, Copy)]
enum Field<'a> {
    Var(u64),
    F32(f32),
    F64(f64),
    Bytes(&'a [u8]),
}

const VARINT: u64 = 0;
const FIXED64: u64 = 1;
const BYTES: u64 = 2;
const FIXED32: u64 = 5;

fn read_varint(b: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *b.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

/// A message in either encoding. An absent field reads as an empty message, so a chain of
/// lookups through a message that is not there yields the same defaults as one that is
/// there but silent.
pub struct Node<'a>(Repr<'a>);

enum Repr<'a> {
    Proto(Vec<(u32, Field<'a>)>),
    Json(&'a Value),
    Empty,
}

impl<'a> Node<'a> {
    pub fn proto(body: &'a [u8]) -> Self {
        let mut fields = Vec::new();
        let mut at = 0;
        while at < body.len() {
            let Some(tag) = read_varint(body, &mut at) else {
                break;
            };
            let number = (tag >> 3) as u32;
            let field = match tag & 7 {
                VARINT => match read_varint(body, &mut at) {
                    Some(v) => Field::Var(v),
                    None => break,
                },
                FIXED64 => match body.get(at..at + 8) {
                    Some(b) => {
                        at += 8;
                        Field::F64(f64::from_le_bytes(b.try_into().unwrap_or_default()))
                    }
                    None => break,
                },
                FIXED32 => match body.get(at..at + 4) {
                    Some(b) => {
                        at += 4;
                        Field::F32(f32::from_le_bytes(b.try_into().unwrap_or_default()))
                    }
                    None => break,
                },
                BYTES => {
                    let Some(len) = read_varint(body, &mut at) else {
                        break;
                    };
                    let Some(b) = body.get(at..at.saturating_add(len as usize)) else {
                        break;
                    };
                    at += b.len();
                    Field::Bytes(b)
                }
                _ => break,
            };
            fields.push((number, field));
        }
        Self(Repr::Proto(fields))
    }

    pub fn json(v: &'a Value) -> Self {
        match v {
            Value::Array(_) => Self(Repr::Json(v)),
            _ => Self::EMPTY,
        }
    }

    const EMPTY: Self = Self(Repr::Empty);

    pub fn present(&self) -> bool {
        !matches!(self.0, Repr::Empty)
    }

    fn last(&self, number: u32) -> Option<Field<'a>> {
        match &self.0 {
            Repr::Proto(fields) => fields
                .iter()
                .rev()
                .find(|(n, _)| *n == number)
                .map(|(_, f)| *f),
            _ => None,
        }
    }

    fn slot(&self, number: u32) -> Option<&'a Value> {
        let Repr::Json(v) = self.0 else {
            return None;
        };
        v.as_array()?.get(number as usize - 1)
    }

    /// The message at `number`, `Empty` when the field carries none.
    pub fn at(&self, number: u32) -> Node<'a> {
        match self.0 {
            Repr::Proto(_) => match self.last(number) {
                Some(Field::Bytes(b)) => Self::proto(b),
                _ => Self::EMPTY,
            },
            Repr::Json(_) => self.slot(number).map_or(Self::EMPTY, Self::json),
            Repr::Empty => Self::EMPTY,
        }
    }

    /// Every message at `number`, in wire order.
    pub fn all(&self, number: u32) -> Vec<Node<'a>> {
        match &self.0 {
            Repr::Proto(fields) => fields
                .iter()
                .filter_map(|(n, f)| match (*n == number, f) {
                    (true, Field::Bytes(b)) => Some(Self::proto(b)),
                    _ => None,
                })
                .collect(),
            Repr::Json(_) => match self.slot(number) {
                Some(Value::Array(a)) => a.iter().map(Self::json).collect(),
                _ => Vec::new(),
            },
            Repr::Empty => Vec::new(),
        }
    }

    pub fn str(&self, number: u32) -> &'a str {
        match self.0 {
            Repr::Proto(_) => match self.last(number) {
                Some(Field::Bytes(b)) => str::from_utf8(b).unwrap_or_default(),
                _ => "",
            },
            Repr::Json(_) => self.slot(number).and_then(Value::as_str).unwrap_or_default(),
            Repr::Empty => "",
        }
    }

    /// A `float` field. Array-JSON prints one at single precision, so both encodings land
    /// on the same `f64` only after the value goes back through `f32`.
    pub fn float(&self, number: u32) -> f64 {
        f64::from(self.double(number) as f32)
    }

    /// A `double` field.
    pub fn double(&self, number: u32) -> f64 {
        match self.0 {
            Repr::Proto(_) => match self.last(number) {
                Some(Field::Var(v)) => v as i64 as f64,
                Some(Field::F32(v)) => f64::from(v),
                Some(Field::F64(v)) => v,
                _ => 0.0,
            },
            Repr::Json(_) => self.slot(number).and_then(Value::as_f64).unwrap_or(0.0),
            Repr::Empty => 0.0,
        }
    }

    pub fn int(&self, number: u32) -> i64 {
        match self.0 {
            Repr::Proto(_) => match self.last(number) {
                Some(Field::Var(v)) => v as i64,
                Some(Field::F32(v)) => v as i64,
                Some(Field::F64(v)) => v as i64,
                _ => 0,
            },
            Repr::Json(_) => self.slot(number).and_then(Value::as_i64).unwrap_or(0),
            Repr::Empty => 0,
        }
    }
}

// --- writing ---

pub fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_tag(out: &mut Vec<u8>, number: u32, wire_type: u64) {
    put_varint(out, (u64::from(number) << 3) | wire_type);
}

pub fn put_varint_field(out: &mut Vec<u8>, number: u32, value: u64) {
    put_tag(out, number, VARINT);
    put_varint(out, value);
}

pub fn put_str(out: &mut Vec<u8>, number: u32, value: &str) {
    put_bytes(out, number, value.as_bytes());
}

pub fn put_bytes(out: &mut Vec<u8>, number: u32, value: &[u8]) {
    put_tag(out, number, BYTES);
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

/// A submessage, built by `body` into a scratch buffer and framed at `number`.
pub fn put_msg(out: &mut Vec<u8>, number: u32, body: impl FnOnce(&mut Vec<u8>)) {
    let mut buf = Vec::new();
    body(&mut buf);
    put_bytes(out, number, &buf);
}

#[cfg(test)]
#[path = "wire.test.rs"]
mod tests;
