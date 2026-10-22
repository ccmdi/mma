//! Shared fixtures for the `*.test.rs` modules.

use crate::selections::LocView;
use crate::store::arrow;
use crate::store::engine::{
    ChangeEvent, EditResult, Entry, Finished, Holder, Intent, Reached, Recording, Store, Target,
    Tracked, Upstream, ValueRecord,
};
use crate::store::id_set::IdSet;
use crate::store::maps::MapMeta;
use crate::types::{AppResult, Location};
use arrow_array::RecordBatch;
use futures::future::FutureExt;
use mma_algebra::{Id, IdRange, Op};
use std::collections::HashMap;
use std::ops::Deref;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::{env, fs, iter, mem};
use tokio::sync::{mpsc, oneshot};

/// A location at `(lat, lng)` with default everything else.
pub(crate) fn loc(id: u32, lat: f64, lng: f64) -> Location {
    Location {
        id: Id::new(id),
        lat,
        lng,
        zoom: 1.0,
        ..Default::default()
    }
}

/// Typed value ids from raw numbers.
pub(crate) fn tag_ids(raw: impl IntoIterator<Item = u32>) -> Vec<Id<ValueRecord>> {
    raw.into_iter().map(Id::new).collect()
}

pub(crate) fn loc_ids(raw: impl IntoIterator<Item = u32>) -> Vec<Id<Location>> {
    raw.into_iter().map(Id::new).collect()
}

/// A directory under the system temp dir, removed on drop so a panicking test
/// leaves nothing behind. Derefs to its path.
pub(crate) struct TempDir(PathBuf);

impl TempDir {
    /// Fresh empty directory.
    pub(crate) fn new(name: &str) -> Self {
        let d = TempDir::slot(name);
        fs::create_dir_all(&d.0).unwrap();
        d
    }

    /// Path cleared but not created, for code under test that must create it.
    pub(crate) fn slot(name: &str) -> Self {
        let path = env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&path);
        TempDir(path)
    }
}

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Owns the batch and overlay a [`LocView`] borrows from, so tests don't stage
/// each piece in its own binding to satisfy the view's lifetime.
#[derive(Default)]
pub(crate) struct Fx {
    pub batch: Option<RecordBatch>,
    pub dead: IdSet<Location>,
    pub patches: HashMap<Id<Location>, Location>,
    pub adds: Vec<Location>,
    pub selected: Option<IdSet<Location>>,
}

impl Fx {
    /// Overlay adds only, no committed batch.
    pub(crate) fn adds(adds: Vec<Location>) -> Self {
        Fx {
            adds,
            ..Default::default()
        }
    }

    /// Committed batch built from `locs`.
    pub(crate) fn base(locs: &[Location]) -> Self {
        Fx::batch(arrow::locations_to_batch(locs))
    }

    pub(crate) fn batch(batch: RecordBatch) -> Self {
        Fx {
            batch: Some(batch),
            ..Default::default()
        }
    }

    pub(crate) fn with_adds(mut self, adds: Vec<Location>) -> Self {
        self.adds = adds;
        self
    }

    pub(crate) fn with_dead(mut self, ids: impl IntoIterator<Item = u32>) -> Self {
        self.dead.extend(ids.into_iter().map(Id::new));
        self
    }

    pub(crate) fn with_patch(mut self, id: u32, loc: Location) -> Self {
        self.patches.insert(Id::new(id), loc);
        self
    }

    pub(crate) fn with_selected(mut self, ids: impl IntoIterator<Item = u32>) -> Self {
        self.selected = Some(ids.into_iter().map(Id::new).collect());
        self
    }

    pub(crate) fn view(&self) -> LocView<'_> {
        LocView::new(
            self.batch.as_ref(),
            &self.dead,
            &self.patches,
            &self.adds,
            self.selected.as_ref(),
        )
    }
}

/// What a write a store applied here came to, for a test that expects it to land.
pub(crate) trait Now<T> {
    fn now(self) -> T;
}

impl<T: Send + 'static> Now<T> for Reached<T> {
    fn now(self) -> T {
        self.settled().unwrap()
    }
}

/// Every change `store` finishes from now on, as a session listening to it hears them.
pub(crate) fn listen(store: &mut Store) -> mpsc::UnboundedReceiver<ChangeEvent> {
    let (sink, feed) = mpsc::unbounded_channel();
    store
        .changes
        .insert(Holder::Session(store.meta.id.clone()), sink);
    feed
}

/// How many ids [`Host::pair`] lends its replica.
pub(crate) const LEASE: u32 = 16;

/// A map's host in process. A replica's writes apply to the host's store as they arrive;
/// [`Host::answer`] then brings the replica what the host did before answering each write.
pub(crate) struct Host {
    pub(crate) store: Mutex<Store>,
    feed: Mutex<mpsc::UnboundedReceiver<ChangeEvent>>,
    due: Mutex<Vec<Due>>,
}

/// A write the host applied, still unanswered: the changes the host made before it, the change
/// that carries it, the keys it gave new value records, and where the writer files its step.
struct Due {
    before: Vec<Entry>,
    carried: Vec<Entry>,
    outcome: AppResult<EditResult>,
    recording: Recording,
    reply: oneshot::Sender<AppResult<EditResult>>,
}

impl Host {
    /// A host of map `id` holding `rows`, and a replica of it whose writes go to the host.
    pub(crate) fn pair(id: &str, rows: &[Location]) -> (Arc<Self>, Store) {
        let meta = MapMeta {
            id: Id::new(id.into()),
            ..Default::default()
        };
        let mut store = Store::new();
        store.meta = Tracked::new(meta.clone());
        let feed = listen(&mut store);
        store
            .at(&Target::Map { id: None })
            .write(rows.iter().cloned().map(Op::Add).collect::<Vec<_>>())
            .now();
        let host = Arc::new(Self {
            store: Mutex::new(store),
            feed: Mutex::new(feed),
            due: Mutex::default(),
        });
        let mut replica = Store::new();
        replica.meta = Tracked::new(meta);
        for entry in host.fed() {
            replica
                .at(&Target::Map { id: None })
                .unrecorded()
                .write(entry)
                .now();
        }
        replica.replicate(host.clone());
        replica
            .next_id
            .lease(host.store.lock().unwrap().take_run(LEASE).unwrap());
        (host, replica)
    }

    fn fed(&self) -> Vec<Entry> {
        let mut feed = self.feed.lock().unwrap();
        iter::from_fn(|| feed.try_recv().ok())
            .filter_map(|change| change.finished)
            .map(|fed| match fed {
                Finished::Entry(entry) => Arc::unwrap_or_clone(entry),
                Finished::Base => panic!("no shared write rewrites the base"),
            })
            .collect()
    }

    /// Adopt into `replica` what the host did for each write it holds, then answer the write.
    pub(crate) fn answer(&self, replica: &mut Store) {
        for mut due in mem::take(&mut *self.due.lock().unwrap()) {
            for entry in due.before {
                replica
                    .at(&Target::Map { id: None })
                    .unrecorded()
                    .write(entry)
                    .now();
            }
            let mut reached = None;
            for entry in due.carried {
                reached = Some(
                    replica
                        .at(&Target::Map { id: None })
                        .joining(&mut due.recording)
                        .write(entry)
                        .now(),
                );
            }
            let outcome = due.outcome.map(|edited| EditResult {
                mutation: reached.expect("the host feeds every change it finishes"),
                ..edited
            });
            let _ = due.reply.send(outcome);
        }
    }
}

impl Upstream for Host {
    fn send(&self, intent: Intent, recording: &mut Recording) -> Reached<EditResult> {
        let (reply, answer) = oneshot::channel();
        let before = self.fed();
        let outcome = self
            .store
            .lock()
            .unwrap()
            .at(&Target::Map { id: None })
            .unrecorded()
            .write(intent)
            .settled();
        let carried = self.fed();
        self.due.lock().unwrap().push(Due {
            before,
            carried,
            outcome,
            recording: recording.carried(),
            reply,
        });
        Reached::later(answer.map(|answered| answered.expect("the host answers every write")))
    }

    fn lease(&self, len: u32) -> Reached<IdRange<Location>> {
        Reached::ready(self.store.lock().unwrap().take_run(len))
    }
}

/// Build a `Patch<Location>` from only the fields it sets.
/// Each value is wrapped in one `Some`, so nullable fields take the inner option:
/// `patch!(pano_id: None)` clears the pano id; `patch!(7; heading: 90.0)` names row 7.
macro_rules! patch {
    ($id:expr; $($field:ident: $value:expr),* $(,)?) => {
        mma_algebra::Patch::<crate::types::Location> {
            id: Id::new($id),
            $($field: $value.into(),)*
            ..Default::default()
        }
    };
    ($($field:ident: $value:expr),* $(,)?) => {
        mma_algebra::Patch::<crate::types::Location> {
            $($field: $value.into(),)*
            ..Default::default()
        }
    };
}

pub(crate) use patch;
