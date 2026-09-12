//! Pano id <-> protobuf `ImageKey`. Ids outside the official and `F:` collections are a
//! base64url-encoded `ImageKey` in their own right.

use std::sync::OnceLock;

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE};
use base64::Engine;
use regex::Regex;

use crate::sv::schema::{ImageKey, PanoType};
use crate::sv::wire::{Node, put_str, put_varint_field};

/// The shape of an official pano id: a 21-character base64url body closed by one of the
/// four characters that can end a 132-bit key.
pub const OFFICIAL_ID_PATTERN: &str = "^[-_A-Za-z0-9]{21}[AQgw]$";

pub fn is_official(pano_id: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(OFFICIAL_ID_PATTERN).expect("official id pattern"))
        .is_match(pano_id)
}

pub fn to_image_key(pano_id: &str) -> (i32, String) {
    if let Some(rest) = pano_id.strip_prefix("F:") {
        return (i32::from(PanoType::UNKNOWN), rest.to_string());
    }
    // Bare user-contribution keys can be exactly 22 characters, colliding with the
    // official shape; by prefix they resolve only over the user-uploaded frontend.
    if pano_id.starts_with("CIHM") {
        return (i32::from(PanoType::USER_UPLOADED), pano_id.to_string());
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
