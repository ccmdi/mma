//! The one place a long-running job gets an id and a way to be cancelled.

use crate::store::engine::Target;
use crate::store::maps::MapMeta;
use crate::types::AppResult;
use crate::util::Lock;
use mma_algebra::Id;
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::task;

#[derive(Clone)]
pub(crate) struct RunEntry {
    flag: Arc<AtomicBool>,
    /// Halts work that does not watch the flag.
    stop: Option<Arc<dyn Fn() + Send + Sync>>,
    /// The map and target the run writes to, when it writes to a store.
    pub(crate) writer: Option<(Id<MapMeta, String>, Target)>,
}

impl RunEntry {
    fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed);
        if let Some(stop) = &self.stop {
            stop();
        }
    }
}

fn runs() -> &'static Mutex<HashMap<u32, RunEntry>> {
    static R: OnceLock<Mutex<HashMap<u32, RunEntry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reserve an id for a job before starting it, so the results it streams carry the id and
/// `runCancel` can stop it.
#[tauri::command]
#[specta::specta]
pub fn run_reserve() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn register_run(
    run_id: u32,
    writer: Option<(Id<MapMeta, String>, Target)>,
) -> AppResult<Arc<AtomicBool>> {
    let flag = Arc::new(AtomicBool::new(false));
    runs().lock()?.insert(
        run_id,
        RunEntry {
            flag: flag.clone(),
            stop: None,
            writer,
        },
    );
    Ok(flag)
}

/// Register a run whose work halts through `stop` rather than by watching a flag.
pub(crate) fn register_stoppable(
    run_id: u32,
    stop: impl Fn() + Send + Sync + 'static,
) -> AppResult<()> {
    runs().lock()?.insert(
        run_id,
        RunEntry {
            flag: Arc::default(),
            stop: Some(Arc::new(stop)),
            writer: None,
        },
    );
    Ok(())
}

pub(crate) fn unregister_run(run_id: u32) -> Option<RunEntry> {
    runs().lock().ok()?.remove(&run_id)
}

/// Stop a run. Work it already finished stays done, and a run that has ended ignores this.
#[tauri::command]
#[specta::specta]
pub async fn run_cancel(run_id: u32) -> AppResult<()> {
    let run = runs().lock()?.get(&run_id).cloned();
    if let Some(run) = run {
        task::spawn_blocking(move || run.cancel()).await?;
    }
    Ok(())
}

pub(crate) fn pending_writers(map_id: &Id<MapMeta, String>) -> BTreeSet<String> {
    runs()
        .locked()
        .values()
        .filter_map(|run| match &run.writer {
            Some((id, Target::Pending { name })) if id == map_id => Some(name.clone()),
            _ => None,
        })
        .collect()
}

/// Cancel only active procedures that still target this unlanded pending layer.
pub(crate) fn cancel_pending_writers(map_id: &Id<MapMeta, String>, name: &str) {
    let writers: Vec<RunEntry> = runs()
        .locked()
        .values()
        .filter(|run| {
            matches!(&run.writer, Some((id, Target::Pending { name: target })) if id == map_id && target == name)
        })
        .cloned()
        .collect();
    for run in writers {
        run.cancel();
    }
}

#[cfg(test)]
#[path = "runs.test.rs"]
mod tests;
