//! Core data types shared across the Rust backend.
//!
//! These are the canonical definitions for locations and tags -- serialized to/from
//! Arrow IPC on disk, JSON over IPC to the JS frontend, and used throughout the
//! store, import, and selection engines.

use rmp_serde::decode;
use rmp_serde::encode;
use specta::datatype::DataType;
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

/// A single Street View location on a map.
///
/// This is the atomic unit of data in the system. Locations are stored columnar
/// in Arrow IPC on disk and addressed by `id` everywhere. The `id` is unique
/// within a map and assigned by the store's monotonic allocator.
#[derive(
    Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize, specta::Type, mma_fields::Fields,
)]
#[serde(rename_all = "camelCase")]
#[fields(
    derived_len(key = "tagCount", label = "Tag count", of = tags),
    flag(key = "loadAsPanoId", label = "Load as pano ID", bit = LOAD_AS_PANO_ID)
)]
pub struct Location {
    /// Monotonically increasing within a map. Zero is a sentinel meaning
    /// "not yet assigned" (used during import before IDs are allocated).
    #[field(label = "ID", kind = identity)]
    pub id: u32,
    #[field(label = "Latitude", kind = identity)]
    pub lat: f64,
    #[field(label = "Longitude", kind = identity)]
    pub lng: f64,
    #[field(label = "Heading", kind = writable, circular = 360.0)]
    pub heading: f64,
    #[field(label = "Pitch", kind = writable, column = pitches)]
    pub pitch: f64,
    #[field(label = "Zoom", kind = writable)]
    pub zoom: f64,
    /// The empty string means absent, the same absence a missing key has.
    #[specta(type = Option<String>)]
    #[field(label = "Pano ID", absent_when_empty)]
    pub pano_id: Option<compact_str::CompactString>,
    /// The location's bits, such as whether it opens exactly its stored pano.
    #[field(skip)]
    pub flags: LocationFlags,
    /// Tag IDs applied to this location. References interned values of the `tags`
    /// field (`Tag.id`). Empty resolves to absent, so "untagged" is the ordinary
    /// `Nothas` on an absent field.
    #[field(label = "Tags", kind = writable, interned, absent_when_empty, column = tags)]
    pub tags: Vec<u32>,
    /// Arbitrary key-value metadata. Its keys are the `extra` fields, resolved by
    /// name past the builtins.
    // Stored as raw JSON bytes; see [`RawExtra`].
    #[specta(type = Option<HashMap<String, specta_typescript::Unknown>>)]
    #[field(skip)]
    pub extra: Option<RawExtra>,
    /// Unix timestamp (seconds)
    #[field(label = "Created", date)]
    pub created_at: u32,
    #[field(label = "Modified", date)]
    pub modified_at: Option<u32>,
}
#[allow(
    clippy::single_component_path_imports,
    reason = "lifts the derive-emitted macro into the module namespace so other modules can path-import it"
)]
pub(crate) use location_fields;

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

/// The `PascalCase` name -> value pairs TypeScript mirrors, in declaration order.
pub fn wire_names<V>(pairs: impl IntoIterator<Item = (&'static str, V)>) -> Vec<(String, V)> {
    pairs.into_iter().map(|(n, v)| (pascal(n), v)).collect()
}

/// One constant the TypeScript mirror declares: its docs, its literal, and whether it
/// also carries the value union.
pub struct TsConst {
    doc: &'static [&'static str],
    literal: String,
    union: bool,
    unstable: bool,
}

impl TsConst {
    /// Any serializable value, spelled as its JSON literal.
    pub fn value<T: serde::Serialize>(v: T) -> Self {
        Self {
            doc: &[],
            literal: serde_json::to_string(&v).expect("constant serializes"),
            union: false,
            unstable: false,
        }
    }

    /// A name -> value object in declaration order, which also gets its value union.
    pub fn names<V: Display>(
        entries: impl IntoIterator<Item = ((String, V), &'static str)>,
    ) -> Self {
        Self::object(entries, true)
    }

    pub fn strings(
        entries: impl IntoIterator<Item = (&'static str, &'static str, &'static str)>,
    ) -> Self {
        Self::object(
            entries.into_iter().map(|(name, value, doc)| {
                let literal = serde_json::to_string(value).expect("string serializes");
                ((name.to_string(), literal), doc)
            }),
            true,
        )
    }

    fn object<V: Display>(
        entries: impl IntoIterator<Item = ((String, V), &'static str)>,
        union: bool,
    ) -> Self {
        let body: String = entries
            .into_iter()
            .map(|((n, v), doc)| format!("\t/** {} */\n\t{n}: {v},\n", doc.trim()))
            .collect();
        Self {
            doc: &[],
            literal: format!("{{\n{body}}}"),
            union,
            unstable: false,
        }
    }

    pub fn with_doc(mut self, doc: &'static [&'static str]) -> Self {
        self.doc = doc;
        self
    }

    /// Marks the constant as carrying no stability promise to plugins.
    pub fn unstable(mut self) -> Self {
        self.unstable = true;
        self
    }

    /// The declaration as it lands in the file.
    pub fn render(&self, name: &str) -> String {
        let mut ts = String::from(
            "
",
        );
        let tag = if self.unstable { " @unstable" } else { "" };
        match self.doc {
            [] if self.unstable => ts.push_str("/** @unstable */\n"),
            [] => {}
            [one] => ts.push_str(&format!(
                "/** {}{tag} */
",
                one.trim()
            )),
            many => {
                ts.push_str(
                    "/**
",
                );
                for line in many {
                    ts.push_str(&format!(
                        " * {}
",
                        line.trim()
                    ));
                }
                if self.unstable {
                    ts.push_str(" * @unstable\n");
                }
                ts.push_str(
                    " */
",
                );
            }
        }
        ts.push_str(&format!(
            "export const {name} = {} as const;
",
            self.literal
        ));
        if self.union {
            ts.push_str(&format!(
                "export type {name} = (typeof {name})[keyof typeof {name}];
"
            ));
        }
        ts
    }
}

/// A closed set of numeric values Rust owns: the constants, the enum-field catalogue
/// entries built from them, and the map TypeScript mirrors, all from one list.
macro_rules! wire_enum {
    (@base $(#[doc = $doc:literal])* $name:ident : $repr:ty { $(#[doc = $kdoc:literal] $konst:ident = $val:expr),* }) => {
        $(#[doc = $doc])*
        pub struct $name;
        impl $name {
            $(
                #[doc = $kdoc]
                #[allow(dead_code, reason = "the wire value is mirrored to TypeScript, not read here")]
                pub const $konst: $repr = $val;
            )*
            /// Every value, in declaration order, which is also the wire order.
            #[allow(dead_code, reason = "not every wire enum has an all-values caller")]
            pub const ALL: &'static [$repr] = &[$($val),*];
            /// The rustdoc above, one entry per line, for the TypeScript mirror.
            pub const DOC: &'static [&'static str] = &[$($doc),*];
            pub fn wire_names() -> Vec<(String, $repr)> {
                wire_names([$((stringify!($konst), $val)),*])
            }
            pub fn ts_const() -> TsConst {
                TsConst::names(Self::wire_names().into_iter().zip([$($kdoc),*])).with_doc(Self::DOC)
            }
        }
    };
    ($(#[doc = $doc:literal])* $name:ident : $repr:ty { $(#[doc = $kdoc:literal] $konst:ident = $val:expr => $label:literal),* $(,)? }) => {
        wire_enum!(@base $(#[doc = $doc])* $name : $repr { $(#[doc = $kdoc] $konst = $val),* });
        impl $name {
            /// Values as the `extra` column stores them.
            pub const VALUES: &'static [&'static str] = &[$(stringify!($val)),*];
            pub const LABELS: &'static [(&'static str, &'static str)] =
                &[$((stringify!($val), $label)),*];
        }
    };
    ($(#[doc = $doc:literal])* $name:ident : $repr:ty { $(#[doc = $kdoc:literal] $konst:ident = $val:expr),* $(,)? }) => {
        wire_enum!(@base $(#[doc = $doc])* $name : $repr { $(#[doc = $kdoc] $konst = $val),* });
    };
}
pub(crate) use wire_enum;

macro_rules! wire_str_enum {
    (@base [$($doc:literal),*] [$($derive:path),*] $vis:vis $name:ident { $(#[doc = $vdoc:literal] [$(#[$vattr:meta])*] $variant:ident = $value:literal),* }) => {
        $(#[doc = $doc])*
        #[derive($($derive),*)]
        $vis enum $name {
            $(#[doc = $vdoc] $(#[$vattr])* #[serde(rename = $value)] $variant),*
        }
        impl $name {
            pub fn ts_const() -> $crate::types::TsConst {
                $crate::types::TsConst::strings([$((stringify!($variant), $value, $vdoc)),*]).with_doc(&[$($doc),*])
            }
        }
    };
    ($(#[doc = $doc:literal])* derive($($derive:path),* $(,)?) $vis:vis enum $name:ident { $(#[doc = $vdoc:literal] $(#[$vattr:meta])* $variant:ident = $value:literal => $label:literal),* $(,)? }) => {
        wire_str_enum!(@base [$($doc),*] [$($derive),*] $vis $name { $(#[doc = $vdoc] [$(#[$vattr])*] $variant = $value),* });
        impl $name {
            pub const VALUES: &'static [&'static str] = &[$($value),*];
            pub const LABELS: &'static [(&'static str, &'static str)] = &[$(($value, $label)),*];
        }
    };
    ($(#[doc = $doc:literal])* derive($($derive:path),* $(,)?) $vis:vis enum $name:ident { $(#[doc = $vdoc:literal] $(#[$vattr:meta])* $variant:ident = $value:literal),* $(,)? }) => {
        wire_str_enum!(@base [$($doc),*] [$($derive),*] $vis $name { $(#[doc = $vdoc] [$(#[$vattr])*] $variant = $value),* });
    };
}
pub(crate) use wire_str_enum;

wire_enum! {
    /// Outcome of a Street View coverage check, as `validate` answers it per row.
    ValidationState: u8 {
        /// The location's coverage checked out, with nothing to report.
        OK = 0,
        /// The location is pinned to a pano, and newer official coverage exists that it does not show.
        UPDATE_AVAILABLE = 1,
        /// Newer official coverage exists here, and the unpinned location already shows it.
        UPDATE_APPLIED = 2,
        /// The location shows bad-camera coverage, but its timeline holds a better camera capture.
        GOODCAM_AVAILABLE = 6,
        /// The location's pinned pano no longer loads, though coverage still exists at its coordinates.
        PANO_ID_BROKE = 4,
        /// The coverage the location shows is unofficial.
        UNOFFICIAL = 5,
        /// No coverage was found, neither the stored pano nor any within the search radius.
        NOT_FOUND = 3,
    }
}

/// A bitflags set Rust owns, plus the composite constants TypeScript mirrors. Docs are
/// captured once here and travel with the value to the wire.
macro_rules! wire_bitflags {
    (
        $(#[doc = $doc:literal])*
        $name:ident : $repr:ty { $(#[doc = $fdoc:literal] const $flag:ident = $bits:expr;)* }
        consts { $($(#[doc = $cdoc:literal])* $konst:ident as $ts:literal = $val:expr;)* }
    ) => {
        bitflags::bitflags! {
            $(#[doc = $doc])*
            #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
            pub struct $name: $repr { $(#[doc = $fdoc] const $flag = $bits;)* }
        }

        impl $name {
            /// The rustdoc above, one entry per line, for the TypeScript mirror.
            pub const DOC: &'static [&'static str] = &[$($doc),*];
            pub const FLAG_DOCS: &'static [&'static str] = &[$($fdoc),*];
            $(
                $(#[doc = $cdoc])*
                pub const $konst: Self = $val;
            )*
            /// Each composite constant as TypeScript spells it: name, value, docs.
            pub const WIRE_CONSTS: &'static [(&'static str, $repr, &'static [&'static str])] =
                &[$(($ts, Self::$konst.bits(), &[$($cdoc),*])),*];
        }
    };
}

wire_bitflags! {
    /// Per-location bitfield, serialized as a plain `u32` over IPC and Arrow.
    LocationFlags: u32 {
        /// When the location has a stored pano, it opens exactly that pano instead of the nearest coverage.
        const LOAD_AS_PANO_ID = 1;
        /// Legacy marker (web). Kept as imported, with no effect in the app.
        const INFORMATIONAL = 2;
        // Preview kinds, set only on the ephemeral active-location preview and stripped
        // by [`LocationFlags::VIRTUAL`] before one is materialized. Never persisted.
        /// A location from a pending import, opened for preview and not yet on the map.
        const IMPORT_PREVIEW = 4;
        /// A pano opened from the seen history overlay, not yet on the map.
        const SEEN_OVERLAY = 8;
    }
    consts {
        /// The bits a preview carries that a real location must not.
        VIRTUAL as "VIRTUAL_FLAGS" = Self::IMPORT_PREVIEW.union(Self::SEEN_OVERLAY);
    }
}

impl LocationFlags {
    pub fn ts_const() -> TsConst {
        let names = wire_names(
            iter::once(("NONE", 0)).chain(Self::all().iter_names().map(|(n, f)| (n, f.bits()))),
        );
        let docs = iter::once("No flags set.").chain(Self::FLAG_DOCS.iter().copied());
        TsConst::names(names.into_iter().zip(docs)).with_doc(Self::DOC)
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

macro_rules! err_codes {
    ($($(#[$doc:meta])* $variant:ident => $wire:literal),* $(,)?) => {
        /// A failure the user reads, classified rather than worded. The wire form is the code
        /// alone or `<code>: <detail>`, where the detail is data (a status, a byte count) and
        /// never prose. TypeScript owns the message.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum ErrCode { $($(#[$doc])* $variant),* }

        impl ErrCode {
            pub const ALL: &'static [ErrCode] = &[$(ErrCode::$variant),*];

            pub fn wire(self) -> &'static str {
                match self { $(ErrCode::$variant => $wire),* }
            }
        }
    };
}

err_codes! {
    /// The provider rejected our credentials; stamped where the 401 is seen.
    Auth => "auth",
    AttachmentNotStaged => "attachment-not-staged",
    AttachmentTooLarge => "attachment-too-large",
    AttachmentNotImage => "attachment-not-image",
    UploadRejected => "upload-rejected",
    ReportRejected => "report-rejected",
    ReportUnreadable => "report-unreadable",
    SignInTimedOut => "sign-in-timed-out",
    SignInTokenRejected => "sign-in-token-rejected",
    IssueRejected => "issue-rejected",
    GeoguessrPolygonal => "geoguessr-polygonal",
    GeoguessrDraftTooLarge => "geoguessr-draft-too-large",
}

impl ErrCode {
    pub fn err(self) -> AppError {
        AppError(self.wire().to_string())
    }

    pub fn with(self, detail: impl Display) -> AppError {
        AppError(format!("{}: {detail}", self.wire()))
    }
}

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
