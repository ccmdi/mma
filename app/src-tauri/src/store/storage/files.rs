//! Generic file ops: temp-file-then-rename writes and orphan sweeps.

use super::*;
use crate::types::{AppError, AppResult};
use std::fs;
use std::fs::{File, OpenOptions};
use std::path::Path;

/// Write to `path` via a temporary `.tmp` sibling, then atomically rename.
/// Guarantees readers never observe a partially-written file.
pub(crate) fn atomic_write(
    path: &Path,
    write_fn: impl FnOnce(File) -> AppResult<()>,
) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    let file = File::create(&tmp)?;
    write_fn(file)?;
    // write_fn consumed the handle; reopen to fsync - without it the rename can
    // become durable before the data, losing the file on power cut.
    OpenOptions::new().write(true).open(&tmp)?.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// [`atomic_write`] for a caller that already holds the whole payload.
pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> AppResult<()> {
    atomic_write(path, |mut file| {
        use std::io::Write;
        file.write_all(bytes).map_err(AppError::from)
    })
}

/// Delete orphaned `.tmp` files left under the Arrow root by interrupted
/// [`atomic_write`]s. Returns the number removed. Called once at startup.
pub(crate) fn sweep_orphaned_tmp() -> usize {
    arrow_dir().map(|d| sweep_tmp_under(&d)).unwrap_or(0)
}

/// Recursively delete `*.tmp` files under `dir`; returns the number removed.
pub(crate) fn sweep_tmp_under(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            n += sweep_tmp_under(&p);
        } else if p.extension().is_some_and(|x| x == "tmp") && fs::remove_file(&p).is_ok() {
            n += 1;
        }
    }
    n
}
