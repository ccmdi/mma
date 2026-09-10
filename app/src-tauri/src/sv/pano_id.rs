//! Pano id <-> protobuf `ImageKey`. Ids outside the official and `F:` collections are a
//! base64url-encoded `ImageKey` in their own right.

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE};
use base64::Engine;

use crate::sv::schema::{ImageKey, PanoType};
use crate::sv::wire::{Node, put_str, put_varint_field};

const OFFICIAL_LEN: usize = 22;

/// The 21-character body plus one of the four ids that can close a 132-bit key.
pub fn is_official(pano_id: &str) -> bool {
    if pano_id.starts_with("F:") || pano_id.len() != OFFICIAL_LEN {
        return false;
    }
    let bytes = pano_id.as_bytes();
    bytes[..21]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
        && matches!(bytes[21], b'A' | b'Q' | b'g' | b'w')
}

pub fn to_image_key(pano_id: &str) -> (i32, String) {
    if let Some(rest) = pano_id.strip_prefix("F:") {
        return (i32::from(PanoType::UNKNOWN), rest.to_string());
    }
    if is_official(pano_id) {
        return (i32::from(PanoType::OFFICIAL), pano_id.to_string());
    }
    decode_key(pano_id).unwrap_or_else(|| (i32::from(PanoType::OFFICIAL), pano_id.to_string()))
}

fn decode_key(pano_id: &str) -> Option<(i32, String)> {
    let b64: String = pano_id
        .trim_end_matches('.')
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let bytes = STANDARD_NO_PAD
        .decode(b64.trim_end_matches('='))
        .ok()?;
    let key = ImageKey(Node::proto(&bytes));
    let frontend = match key.frontend() {
        0 => i32::from(PanoType::OFFICIAL),
        n => n as i32,
    };
    let id = key.id();
    Some((
        frontend,
        if id.is_empty() {
            pano_id.to_string()
        } else {
            id.to_string()
        },
    ))
}

pub fn from_image_key(frontend: i32, id: &str) -> String {
    if id.is_empty() {
        return String::new();
    }
    if frontend == 0 || frontend == i32::from(PanoType::OFFICIAL) {
        return id.to_string();
    }
    if frontend == i32::from(PanoType::UNKNOWN) {
        return format!("F:{id}");
    }
    let mut buf = Vec::new();
    put_varint_field(&mut buf, ImageKey::FRONTEND, frontend as u64);
    put_str(&mut buf, ImageKey::ID, id);
    URL_SAFE.encode(&buf).replace('=', ".")
}

#[cfg(test)]
#[path = "pano_id.test.rs"]
mod tests;
