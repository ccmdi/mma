//! Shared fixtures for the `*.test.rs` modules.

use crate::selections::LocView;
use crate::store::arrow_bridge;
use crate::types::Location;
use arrow_array::RecordBatch;
use roaring::RoaringBitmap;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::ops::Deref;
use std::path::Path;
use std::path::PathBuf;

/// A location at `(lat, lng)` with default everything else.
pub(crate) fn loc(id: u32, lat: f64, lng: f64) -> Location {
    Location {
        id,
        lat,
        lng,
        zoom: 1.0,
        ..Default::default()
    }
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
    pub dead: HashSet<u32>,
    pub patches: HashMap<u32, Location>,
    pub adds: Vec<Location>,
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
        Fx::batch(arrow_bridge::locations_to_batch(locs))
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
        self.dead.extend(ids);
        self
    }

    pub(crate) fn with_patch(mut self, id: u32, loc: Location) -> Self {
        self.patches.insert(id, loc);
        self
    }

    pub(crate) fn view(&self) -> LocView<'_> {
        self.view_with(None)
    }

    /// View backed by a `tag_id -> members` index.
    pub(crate) fn view_indexed<'a>(&'a self, sets: &'a HashMap<u32, RoaringBitmap>) -> LocView<'a> {
        self.view_with(Some(sets))
    }

    fn view_with<'a>(&'a self, sets: Option<&'a HashMap<u32, RoaringBitmap>>) -> LocView<'a> {
        LocView::new(
            self.batch.as_ref(),
            &self.dead,
            &self.patches,
            &self.adds,
            sets,
        )
    }
}

/// Build a [`crate::store::location_store::LocationPatch`] from only the fields it sets.
/// Each value is wrapped in one `Some`, so nullable fields take the inner option:
/// `patch!(pano_id: None)` clears the pano id.
macro_rules! patch {
    ($($field:ident: $value:expr),* $(,)?) => {
        crate::store::location_store::LocationPatch {
            $($field: Some($value),)*
            ..Default::default()
        }
    };
}

pub(crate) use patch;
