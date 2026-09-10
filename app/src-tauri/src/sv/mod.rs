//! Street View metadata: Google's GetMetadata RPC on the wire, and the [`pano::Pano`]
//! every metadata-backed feature reads.

pub(crate) mod pano;
pub(crate) mod pano_id;
pub(crate) mod schema;
#[cfg(test)]
mod schema_codegen;
pub(crate) mod wire;
