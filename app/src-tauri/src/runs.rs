//! The one place a long-running job gets an id and a cancel flag.

use crate::store::engine::Target;
use crate::store::maps::MapMeta;
use crate::types::AppResult;
use mma_algebra::Id;
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

#[derive(Clone)]
pub(crate) struct RunEntry {
    cancel: Arc<AtomicBool>,
    /// The map and target the run writes to, when it writes to a store.
    pub(crate) writer: Option<(Id<MapMeta, String>, Target)>,
}

fn runs() -> &'static Mutex<HashMap<u32, RunEntry>> {
    static R: OnceLock<Mutex<HashMap<u32, RunEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn next_run_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn register_run(
    run_id: u32,
    writer: Option<(Id<MapMeta, String>, Target)>,
) -> AppResult<Arc<AtomicBool>> {
    let cancel = Arc::new(AtomicBool::new(false));
    runs().lock()?.insert(
        run_id,
        RunEntry {
            cancel: cancel.clone(),
            writer,
        },
    );
    Ok(cancel)
}

pub(crate) fn unregister_run(run_id: u32) -> Option<RunEntry> {
    runs().lock().ok()?.remove(&run_id)
}

pub(crate) fn cancel_run(run_id: u32) -> AppResult<()> {
    if let Some(run) = runs().lock()?.get(&run_id) {
        run.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub(crate) fn pending_writers(map_id: &Id<MapMeta, String>) -> BTreeSet<String> {
    runs()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .values()
        .filter_map(|run| match &run.writer {
            Some((id, Target::Pending { name })) if id == map_id => Some(name.clone()),
            _ => None,
        })
        .collect()
}

/// Cancel only active procedures that still target this unlanded pending layer.
pub(crate) fn cancel_pending_writers(map_id: &Id<MapMeta, String>, name: &str) {
    for run in runs()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .values()
    {
        if matches!(&run.writer, Some((id, Target::Pending { name: target })) if id == map_id && target == name)
        {
            run.cancel.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
#[path = "runs.test.rs"]
mod tests;
