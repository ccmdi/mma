//! Street View: Google's GetMetadata RPC on the wire, the [`pano::Pano`] every
//! metadata-backed feature reads, and the imagery [`tiles`] every consumer fetches through.

pub(crate) mod pano;
pub(crate) mod pano_id;
#[rustfmt::skip]
pub(crate) mod schema;
#[cfg(test)]
#[path = "schema_codegen.test.rs"]
mod schema_codegen;
pub(crate) mod tiles;
pub(crate) mod wire;
