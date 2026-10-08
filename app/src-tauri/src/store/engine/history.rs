//! Undo and redo: each edit is the `Entry` it made, replayed forward or as its inverse.

use super::*;
use crate::types::Location;
use std::sync::Arc;

/// What one write did to an interned field's records.
pub(crate) type PileDelta = mma_algebra::Change<(u32, ValueRecord)>;

/// What one write did to every interned field's records, by field.
pub(crate) type Piles = HashMap<String, PileDelta>;

/// What one write did to the map's extra-field definitions.
pub(crate) type DefsDelta = mma_algebra::Change<(String, maps::FieldDef)>;

/// What one write did: to the rows, to the records of each interned field, and to the
/// field definitions. The rows persist as Arrow; the rest as JSON.
#[derive(Clone, Default, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Entry {
    #[serde(skip)]
    pub rows: Change,
    pub piles: Piles,
    pub defs: DefsDelta,
}

impl Entry {
    pub(crate) fn inverse(&self) -> Self {
        Self {
            rows: self.rows.inverse(),
            piles: self
                .piles
                .iter()
                .map(|(field, d)| (field.clone(), d.inverse()))
                .collect(),
            defs: self.defs.inverse(),
        }
    }

    /// This entry and then `later`, as one.
    pub(crate) fn then(self, later: Self) -> Self {
        let mut piles = self.piles;
        for (field, d) in later.piles {
            let held = piles.remove(&field).unwrap_or_default();
            piles.insert(field, held.then(d));
        }
        Self {
            rows: self.rows.then(later.rows),
            piles,
            defs: self.defs.then(later.defs),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.piles.values().all(PileDelta::is_empty) && self.defs.is_empty()
    }
}

pub(super) const MAX_UNDO_ENTRIES: usize = 1000;

/// A change touching more rows than this leaves no undo entry (the entry would clone
/// every row into the persisted history); redo is dropped as for any unrecorded change.
pub(crate) const MAX_UNDO_ROWS: usize = 500_000;

/// Which stack an edit sits in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Stack {
    Undo,
    Redo,
}

/// The undo and redo stacks. Undo holds ascending `seq`, redo descending, and every undo
/// `seq` is below every redo `seq`, so the order of both is recoverable from `seq` alone.
/// Only this module moves edits, which keeps that true.
#[derive(Default, Clone)]
pub(crate) struct EditStacks {
    undo: Vec<LoggedEdit>,
    redo: Vec<LoggedEdit>,
    next_seq: u64,
}

/// An edit and the number it is stored under, never reused within a map, so a stored
/// row with a live `seq` always holds that same edit. `entry` is `None` while the edit
/// is only on disk.
#[derive(Clone)]
pub(crate) struct LoggedEdit {
    pub seq: u64,
    pub entry: Option<Arc<Entry>>,
}

impl EditStacks {
    /// Stacks for edits that are only on disk, from each one's `seq` and stack. New edits
    /// number after every stored one.
    pub(crate) fn on_disk(mut rows: Vec<(u64, Stack)>) -> Self {
        rows.sort_unstable_by_key(|&(seq, _)| seq);
        let next_seq = rows.last().map_or(0, |&(seq, _)| seq + 1);
        let (undo, mut redo): (Vec<_>, Vec<_>) = rows
            .into_iter()
            .map(|(seq, stack)| (LoggedEdit { seq, entry: None }, stack))
            .partition(|(_, stack)| *stack == Stack::Undo);
        redo.reverse();
        Self {
            undo: undo.into_iter().map(|(edit, _)| edit).collect(),
            redo: redo.into_iter().map(|(edit, _)| edit).collect(),
            next_seq,
        }
    }

    /// Record a new edit: it goes on top of undo, under the cap, and redo is gone.
    /// Returns the `seq` it was stored under.
    pub(crate) fn record(&mut self, entry: Arc<Entry>) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.push_undo(LoggedEdit {
            seq,
            entry: Some(entry),
        });
        self.redo.clear();
        seq
    }

    /// Fold `later` into the newest edit when it is `seq` and in memory, and give it a
    /// fresh `seq`: a stored row keeps the edit as it was when stored, so the grown edit is
    /// stored anew and the old row goes on the next save. Redo is gone, as for any new
    /// edit. Hands `later` back when the newest edit is another.
    pub(crate) fn fold_into_newest(&mut self, seq: u64, later: Entry) -> Result<u64, Entry> {
        let Some(top) = self.undo.last_mut().filter(|top| top.seq == seq) else {
            return Err(later);
        };
        let Some(entry) = top.entry.as_mut() else {
            return Err(later);
        };
        let held = Arc::make_mut(entry);
        *held = mem::take(held).then(later);
        top.seq = self.next_seq;
        self.next_seq += 1;
        self.redo.clear();
        Ok(top.seq)
    }

    fn push_undo(&mut self, edit: LoggedEdit) {
        self.undo.push(edit);
        if self.undo.len() > MAX_UNDO_ENTRIES {
            let excess = self.undo.len() - MAX_UNDO_ENTRIES;
            self.undo.drain(..excess);
        }
    }

    /// Forget redo, for a change that leaves no undo entry of its own.
    pub(crate) fn clear_redo(&mut self) {
        self.redo.clear();
    }

    pub(crate) fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    /// The `seq` of the newest undoable edit.
    pub(crate) fn newest(&self) -> Option<u64> {
        self.undo.last().map(|e| e.seq)
    }

    pub(crate) fn undo_len(&self) -> usize {
        self.undo.len()
    }

    pub(crate) fn redo_len(&self) -> usize {
        self.redo.len()
    }

    /// Every edit with its stack: undo bottom to top, then redo bottom to top.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (Stack, &LoggedEdit)> {
        let undo = self.undo.iter().map(|e| (Stack::Undo, e));
        undo.chain(self.redo.iter().map(|e| (Stack::Redo, e)))
    }
}

/// Open-time `next_id` seed. Must exceed every id the system can re-materialize:
/// base rows, uncommitted overlay adds, and ids replayable from persisted undo/redo
/// (replay resurrects locations with their original ids; re-allocating one would
/// create a duplicate and break the strictly-sorted bake invariant).
pub(crate) fn seed_next_id(base_max: u32, adds: &[Location], history_max: u32) -> u32 {
    let max_add = adds.iter().map(|l| l.id).max().unwrap_or(0);
    base_max.max(max_add).max(history_max) + 1
}

impl Store {
    /// Reverse the newest edit and move it to redo. `fetch` reads an edit that is only on
    /// disk; when it fails the whole history goes, since replaying around a gap would
    /// corrupt the map. `None` when there is nothing to undo.
    pub(crate) fn undo(
        &mut self,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        self.step(Stack::Undo, fetch)
    }

    /// Re-apply the newest undone edit and move it back to undo. As [`Store::undo`].
    pub(crate) fn redo(
        &mut self,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        self.step(Stack::Redo, fetch)
    }

    fn step(
        &mut self,
        from: Stack,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        let edits = self.edits.edit();
        let popped = match from {
            Stack::Undo => edits.undo.pop(),
            Stack::Redo => edits.redo.pop(),
        };
        let Some(mut edit) = popped else {
            return Ok(None);
        };
        let entry = match edit.entry.take() {
            Some(entry) => entry,
            None => Arc::new(fetch(edit.seq).inspect_err(|_| self.edits.edit().clear())?),
        };
        let changes = match from {
            Stack::Undo => entry.inverse(),
            Stack::Redo => (*entry).clone(),
        };
        self.put_entry(&changes);
        edit.entry = Some(entry);
        let edits = self.edits.edit();
        match from {
            Stack::Undo => edits.redo.push(edit),
            Stack::Redo => edits.push_undo(edit),
        }
        Ok(Some(changes))
    }
}
