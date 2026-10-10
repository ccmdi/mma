//! Undo and redo by replaying edits forward or in reverse.

use super::*;
use crate::types::wire_str_enum;
use crate::types::Location;
use mma_algebra::{ordered_rows, Change, Delta};
use mma_fields::Delta;
use std::sync::Arc;

/// What one write did to an interned field's records.
pub(crate) type PileDelta = Change<(u32, ValueRecord)>;

/// What one write did to every interned field's records, by field.
pub(crate) type Piles = HashMap<String, PileDelta>;

/// What one write did to the map's extra-field definitions.
pub(crate) type DefsDelta = Change<(String, maps::FieldDef)>;

/// An undoable change to locations, value records, and field definitions.
#[derive(Clone, Default, Debug, PartialEq, serde::Serialize, serde::Deserialize, Delta)]
pub struct Entry {
    #[serde(skip)]
    pub rows: Change<Location>,
    pub piles: Piles,
    pub defs: DefsDelta,
    #[serde(default)]
    pub meta: Change<maps::MapMeta>,
    #[serde(default)]
    pub selections: SelectionDelta,
}

pub(super) const MAX_UNDO_ENTRIES: usize = 1000;

/// Maximum rows in an undoable edit. Larger edits clear history to limit memory
/// and prevent older undo entries from restoring stale rows.
pub(crate) const MAX_UNDO_ROWS: usize = 500_000;

wire_str_enum! {
    /// Which edit history stack to step through.
    derive(serde::Deserialize, specta::Type, Clone, Copy, PartialEq, Eq, Debug)
    pub enum Stack {
        /// The edits that can be undone.
        Undo = "undo",
        /// The undone edits that can be redone.
        Redo = "redo",
    }
}

impl Stack {
    fn other(self) -> Self {
        match self {
            Stack::Undo => Stack::Redo,
            Stack::Redo => Stack::Undo,
        }
    }
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
    pub keys: Vec<EntryKey>,
}

impl EditStacks {
    /// Stacks for edits that are only on disk, from each one's `seq` and stack. New edits
    /// number after every stored one.
    pub(crate) fn on_disk(mut rows: Vec<(u64, Stack, Vec<EntryKey>)>) -> Self {
        rows.sort_unstable_by_key(|(seq, _, _)| *seq);
        let next_seq = rows.last().map_or(0, |(seq, _, _)| seq + 1);
        let (undo, mut redo): (Vec<_>, Vec<_>) = rows
            .into_iter()
            .map(|(seq, stack, keys)| {
                (
                    LoggedEdit {
                        seq,
                        entry: None,
                        keys,
                    },
                    stack,
                )
            })
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
        self.push(
            Stack::Undo,
            LoggedEdit {
                seq,
                keys: entry.keys().collect(),
                entry: Some(entry),
            },
        );
        self.redo.clear();
        seq
    }

    /// Join `later` to the newest edit if its sequence and states match.
    /// Assign a fresh sequence so persistence replaces the old entry; return `later` if it cannot join.
    pub(crate) fn fold_into_newest(&mut self, seq: u64, later: Entry) -> Result<u64, Entry> {
        let Some(top) = self.undo.last_mut().filter(|top| top.seq == seq) else {
            return Err(later);
        };
        let Some(entry) = top.entry.as_mut() else {
            return Err(later);
        };
        let held = Arc::make_mut(entry);
        match mem::take(held).then(later) {
            Ok(grown) => *held = grown,
            Err((kept, later)) => {
                *held = kept;
                return Err(later);
            }
        }
        top.keys = held.keys().collect();
        top.seq = self.next_seq;
        self.next_seq += 1;
        self.redo.clear();
        Ok(top.seq)
    }

    fn stack_mut(&mut self, stack: Stack) -> &mut Vec<LoggedEdit> {
        match stack {
            Stack::Undo => &mut self.undo,
            Stack::Redo => &mut self.redo,
        }
    }

    fn push(&mut self, stack: Stack, edit: LoggedEdit) {
        let edits = self.stack_mut(stack);
        edits.push(edit);
        if edits.len() > MAX_UNDO_ENTRIES {
            let excess = edits.len() - MAX_UNDO_ENTRIES;
            edits.drain(..excess);
        }
    }

    /// Clear both undo and redo history.
    pub(crate) fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
    }

    pub(crate) fn len(&self, stack: Stack) -> usize {
        match stack {
            Stack::Undo => self.undo.len(),
            Stack::Redo => self.redo.len(),
        }
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

impl EditStacks {
    pub(crate) fn availability(&self) -> HashMap<EntryKey, History> {
        let mut histories: HashMap<EntryKey, History> = HashMap::new();
        for stack in [Stack::Undo, Stack::Redo] {
            let top = match stack {
                Stack::Undo => self.undo.last(),
                Stack::Redo => self.redo.last(),
            };
            for key in top.into_iter().flat_map(|edit| &edit.keys) {
                let history = histories.entry(*key).or_default();
                match stack {
                    Stack::Undo => history.undo = true,
                    Stack::Redo => history.redo = true,
                }
            }
        }
        histories
    }

    /// Move the newest edit to the other stack, reversing it for undo.
    /// Load disk-only entries with `fetch`; a read failure clears history to avoid replaying across a gap.
    pub(crate) fn step(
        &mut self,
        from: Stack,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        let Some(mut edit) = self.stack_mut(from).pop() else {
            return Ok(None);
        };
        let entry = match edit.entry.take() {
            Some(entry) => entry,
            None => Arc::new(fetch(edit.seq).inspect_err(|_| self.clear())?),
        };
        let changes = match from {
            Stack::Undo => entry.inverse(),
            Stack::Redo => (*entry).clone(),
        };
        edit.entry = Some(entry);
        self.push(from.other(), edit);
        Ok(Some(changes))
    }
}

impl Store {
    pub(crate) fn step(
        &mut self,
        from: Stack,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        let changes = self.edits.edit().step(from, fetch)?;
        if let Some(changes) = &changes {
            self.put_entry(changes);
        }
        Ok(changes)
    }

    pub(crate) fn step_key(
        &mut self,
        from: Stack,
        key: EntryKey,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        if !self.histories.contains_key(&key) {
            let available = self.history().get(&key).is_some_and(|history| match from {
                Stack::Undo => history.undo,
                Stack::Redo => history.redo,
            });
            return if available {
                self.step(from, fetch)
            } else {
                Ok(None)
            };
        }
        let Some(history) = self.histories.edit().get_mut(&key) else {
            return Ok(None);
        };
        let Some(mut changes) =
            history.step(from, |_| Err("history entry is not resident".into()))?
        else {
            return Ok(None);
        };
        let mut rows = self.selections.table();
        changes.selections.apply_to(&mut rows);
        let rows = self.valid_selections(ordered_rows(rows));
        changes.selections = self.selections.change(&SelectionDelta::default(), |_| rows);
        self.put_entry(&changes);
        Ok(Some(changes))
    }
}
