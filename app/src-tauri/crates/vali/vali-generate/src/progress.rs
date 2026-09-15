use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[derive(Debug, Clone)]
pub enum Event {
    WorkItems {
        total: usize,
    },
    WorkItemDone {
        country_code: String,
        subdivision_code: Option<String>,
        done: usize,
        total: usize,
    },
    CountryDownloadStarted {
        country_code: String,
        files: usize,
        bytes: i64,
        updates: bool,
    },
    FileDownloaded {
        country_code: String,
        name: String,
        bytes: i64,
    },
}
pub type Progress<'a> = &'a (dyn Fn(Event) + Sync);
pub(crate) fn emit(progress: Option<Progress<'_>>, event: Event) {
    if let Some(p) = progress {
        p(event);
    }
}
#[derive(Clone)]
pub struct CancelToken(Arc<AtomicBool>);
impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
    pub fn check(&self) -> anyhow::Result<()> {
        if self.is_cancelled() {
            anyhow::bail!("cancelled");
        }
        Ok(())
    }
}
impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}
