//! Core data types shared across the Rust backend.
//!
//! These are the canonical definitions for locations and tags -- serialized to/from
//! Arrow IPC on disk, JSON over IPC to the JS frontend, and used throughout the
//! store, import, and selection engines.

/// A user-defined label that can be applied to any number of locations.
///
/// Tags are stored in `MapMeta` and referenced by id in each `Location.tags`.
/// Member counts are not part of the tag record: `TagState.counts` owns them and
/// `StoreStatus.tag_counts` is the only channel that ships them.
use rmp_serde::decode;
use rmp_serde::encode;
use specta::datatype::DataType;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::error;
use std::fmt;
use std::fmt::Display;
use std::fmt::Formatter;
use std::io;
use std::iter;
use std::sync::PoisonError;
use tokio::task::JoinError;
use zip::result::ZipError;

pub use raw_extra::*;

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, specta::Type)]
pub struct Tag {
    pub id: u32,
    pub name: String,
    /// Hex color string (e.g. "#3a7fc2"). Generated deterministically from
    /// the tag name via `util::color_for_name` when not explicitly set.
    pub color: String,
    #[serde(default = "default_visible")]
    pub visible: bool,
    /// Display order in the sidebar tag list. `None` for legacy tags
    /// that predate ordered insertion.
    #[serde(default)]
    pub order: Option<u32>,
    /// Document links from the map JSON's `extra.tags[name].doclinks` --
    /// URLs into external docs (e.g. Google Docs heading links). Read-only
    /// in the app; round-trips through import/export.
    #[serde(default)]
    pub doclinks: Vec<String>,
}

fn default_visible() -> bool {
    true
}

/// A single Street View location on a map.
///
/// This is the atomic unit of data in the system. Locations are stored columnar
/// in Arrow IPC on disk and addressed by `id` everywhere. The `id` is unique
/// within a map and assigned by the store's monotonic allocator.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Monotonically increasing within a map. Zero is a sentinel meaning
    /// "not yet assigned" (used during import before IDs are allocated).
    pub id: u32,
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: f64,
    #[specta(type = Option<String>)]
    pub pano_id: Option<compact_str::CompactString>,
    /// See [`LocationFlags`].
    pub flags: LocationFlags,
    /// Tag IDs applied to this location. References `Tag.id`.
    pub tags: Vec<u32>,
    /// Arbitrary key-value metadata
    // Stored as raw JSON bytes; see [`RawExtra`].
    #[specta(type = Option<HashMap<String, specta_typescript::Unknown>>)]
    pub extra: Option<RawExtra>,
    /// Unix timestamp (seconds)
    pub created_at: u32,
    pub modified_at: Option<u32>,
}

impl Default for Location {
    fn default() -> Self {
        Location {
            id: 0,
            lat: 0.0,
            lng: 0.0,
            heading: 0.0,
            pitch: 0.0,
            zoom: 0.0,
            pano_id: None,
            flags: LocationFlags::empty(),
            tags: Vec::new(),
            extra: None,
            created_at: 0,
            modified_at: None,
        }
    }
}

/// `SCREAMING_SNAKE` -> `PascalCase`, so a wire-visible name is spelled once here.
fn pascal(name: &str) -> String {
    name.split('_')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f
                    .to_uppercase()
                    .chain(c.flat_map(char::to_lowercase))
                    .collect(),
                None => String::new(),
            }
        })
        .collect()
}

/// The `PascalCase` name -> value map TypeScript mirrors.
pub fn wire_names<V>(pairs: impl IntoIterator<Item = (&'static str, V)>) -> BTreeMap<String, V> {
    pairs.into_iter().map(|(n, v)| (pascal(n), v)).collect()
}

/// A closed set of numeric values Rust owns: the constants, the enum-field catalogue
/// entries built from them, and the map TypeScript mirrors, all from one list.
macro_rules! wire_enum {
    ($(#[$m:meta])* $name:ident : $repr:ty { $($konst:ident = $val:expr => $label:literal),* $(,)? }) => {
        $(#[$m])*
        pub struct $name;
        impl $name {
            $(pub const $konst: $repr = $val;)*
            /// Values as the `extra` column stores them.
            pub const VALUES: &'static [&'static str] = &[$(stringify!($val)),*];
            pub const LABELS: &'static [(&'static str, &'static str)] =
                &[$((stringify!($val), $label)),*];
            pub fn wire_names() -> std::collections::BTreeMap<String, $repr> {
                wire_names([$((stringify!($konst), $val)),*])
            }
        }
    };
}

wire_enum! {
    /// Panorama source type, as Google's metadata reports it.
    PanoType: u8 {
        OFFICIAL = 2 => "Official",
        UNKNOWN = 3 => "Unknown",
        USER_UPLOADED = 10 => "User uploaded",
    }
}

bitflags::bitflags! {
    /// Per-location bitfield, serialized as a plain `u32` over IPC and Arrow.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct LocationFlags: u32 {
        const LOAD_AS_PANO_ID = 1;
        const INFORMATIONAL = 2;
        /// Preview kinds, set only on the ephemeral active-location preview and stripped
        /// by [`LocationFlags::VIRTUAL`] before one is materialized. Never persisted.
        const IMPORT_PREVIEW = 4;
        const SEEN_OVERLAY = 8;
    }
}

impl LocationFlags {
    /// The bits a preview carries that a real location must not.
    pub const VIRTUAL: Self = Self::IMPORT_PREVIEW.union(Self::SEEN_OVERLAY);

    pub fn wire_names() -> BTreeMap<String, u32> {
        wire_names(
            iter::once(("NONE", 0)).chain(Self::all().iter_names().map(|(n, f)| (n, f.bits()))),
        )
    }
}

impl serde::Serialize for LocationFlags {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u32(self.bits())
    }
}

impl<'de> serde::Deserialize<'de> for LocationFlags {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::from_bits_retain(
            <u32 as serde::Deserialize>::deserialize(d)?,
        ))
    }
}

impl specta::Type for LocationFlags {
    fn definition(types: &mut specta::Types) -> DataType {
        <u32 as specta::Type>::definition(types)
    }
}

/// Error type for every fallible backend operation and Tauri command.
#[derive(Debug, Clone)]
pub struct AppError(pub String);

/// Result alias for backend operations and commands.
pub type AppResult<T> = Result<T, AppError>;

impl Display for AppError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl error::Error for AppError {}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl specta::Type for AppError {
    fn definition(types: &mut specta::Types) -> DataType {
        <String as specta::Type>::definition(types)
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError(s.to_string())
    }
}

macro_rules! impl_app_error_from {
    ($($t:ty),* $(,)?) => {$(
        impl From<$t> for AppError {
            fn from(e: $t) -> Self { AppError(e.to_string()) }
        }
    )*};
}

impl_app_error_from!(
    io::Error,
    rusqlite::Error,
    serde_json::Error,
    arrow_schema::ArrowError,
    encode::Error,
    decode::Error,
    tauri::Error,
    JoinError,
    ZipError,
    keyring::Error,
);

// reqwest's Display is just "error sending request for url (...)"; the actionable cause
// (timed out / dns / tls) lives in the source chain, so flatten it into the message.
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        let mut msg = e.to_string();
        let mut source = error::Error::source(&e);
        while let Some(s) = source {
            msg.push_str(": ");
            msg.push_str(&s.to_string());
            source = s.source();
        }
        AppError(msg)
    }
}

// `PoisonError<T>` is generic; Display is unconditional, so one blanket covers all lock types.
impl<T> From<PoisonError<T>> for AppError {
    fn from(e: PoisonError<T>) -> Self {
        AppError(e.to_string())
    }
}

mod raw_extra;

#[cfg(test)]
#[path = "types.test.rs"]
mod tests;
