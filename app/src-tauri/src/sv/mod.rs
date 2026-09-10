//! Street View wire schema: the proto-stated messages of Google's MapsJs RPCs and the
//! generated layer that reads them.

pub(crate) mod schema;
#[cfg(test)]
mod schema_codegen;
pub(crate) mod wire;
