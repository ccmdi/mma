//! Persistence layer: SQLite metadata database and Arrow IPC file I/O.
//!
//! All disk writes use [`atomic_write`] (temp-file-then-rename) to prevent
//! corruption on crash. Arrow IPC writes go through [`BufWriter`](std::io::BufWriter)
//! because unbuffered `File` writes are ~15x slower.

mod commands;
mod db;
mod files;
mod paths;
mod secrets;
pub(crate) use commands::*;
pub(crate) use db::*;
pub(crate) use files::*;
pub(crate) use paths::*;
pub(crate) use secrets::*;

// ---------------------------------------------------------------------------
// secret: named secrets in the OS credential store (not the DB)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Arrow IPC
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "storage.test.rs"]
mod tests;
