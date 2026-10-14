//! Undo and redo by replaying edits forward or in reverse.

use super::*;
use crate::types::{wire_str_enum, Location};
use mma_algebra::{Change, Delta, Id};
use mma_fields::Delta;
use std::ops::{Index, IndexMut};
use std::sync::Arc;

/// What one write did to an interned field's records.
pub(crate) type RecordDelta = Change<(Id<ValueRecord>, ValueRecord)>;

/// What one write did to every interned field's records, by field.
pub(crate) type RecordDeltas = HashMap<String, RecordDelta>;

/// What one write did to the map's extra-field definitions.
pub(crate) type DefsDelta = Change<(String, maps::FieldDef)>;

/// A change to the map, recorded for undo in the timeline its parts declare.
#[derive(Clone, Default, Debug, PartialEq, serde::Serialize, serde::Deserialize, Delta)]
pub struct Entry {
    /// The edit's changes to locations.
    #[serde(skip)]
    pub locations: Change<Location>,
    /// The edit's changes to the records of interned values such as tags, by field.
    #[serde(alias = "piles")]
    pub records: RecordDeltas,
    /// The edit's changes to the map's field definitions.
    pub defs: DefsDelta,
    /// The edit's changes to the map's details and settings, which are not undone.
    #[serde(default)]
    pub meta: Change<MapMeta>,
    /// The edit's changes to saved selections.
    #[serde(default)]
    pub selections: SelectionDelta,
}

pub(super) const MAX_UNDO_ENTRIES: usize = 1000;

/// Maximum rows in an undo step. Larger steps clear history to limit memory
/// and prevent older undo entries from restoring stale rows.
pub(super) const MAX_UNDO_LOCATIONS: usize = 500_000;

/// Whether an edit changing `rows` rows is too large to undo.
pub(crate) fn too_large_to_undo(rows: usize) -> bool {
    rows > MAX_UNDO_LOCATIONS
}

wire_str_enum! {
    /// Which edit history stack to step through.
    derive(serde::Deserialize, specta::Type, Clone, Copy, PartialEq, Eq, Debug)
    pub enum Stack {
        /// The steps that can be undone.
        Undo = "undo",
        /// The undone steps that can be redone.
        Redo = "redo",
    }
}

wire_str_enum! {
    /// Which edit history to step through. Each part of the map that undoes on its own has one.
    derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)
    pub enum Timeline {
        /// Edits to locations, value records, and field definitions.
        Edits = "edits",
        /// Changes to the listed selections.
        Selections = "selections",
    }
}

impl EntryKey {
    /// The timeline an edit holding this part records into, or `None` for a part never undone.
    pub(crate) fn timeline(self) -> Option<Timeline> {
        match self {
            EntryKey::Locations | EntryKey::Records | EntryKey::Defs => Some(Timeline::Edits),
            EntryKey::Selections => Some(Timeline::Selections),
            EntryKey::Meta => None,
        }
    }
}

impl Entry {
    /// The first timeline any of its parts records into, so a selection change an edit
    /// caused undoes with that edit.
    pub(crate) fn timeline(&self) -> Option<Timeline> {
        self.keys().filter_map(EntryKey::timeline).min()
    }
}

/// The undo and redo stacks of each timeline.
#[derive(Default)]
pub(crate) struct Timelines([Tracked<StepStacks>; Timeline::ALL.len()]);

impl Timelines {
    /// Mark every timeline's stacks as seen; true when any had not been.
    pub(crate) fn ship(&mut self) -> bool {
        self.0
            .iter_mut()
            .fold(false, |any, stacks| stacks.ship() | any)
    }
}

impl Index<Timeline> for Timelines {
    type Output = Tracked<StepStacks>;
    fn index(&self, timeline: Timeline) -> &Self::Output {
        &self.0[timeline as usize]
    }
}

impl IndexMut<Timeline> for Timelines {
    fn index_mut(&mut self, timeline: Timeline) -> &mut Self::Output {
        &mut self.0[timeline as usize]
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
/// Only this module moves steps, which keeps that true.
#[derive(Default, Clone)]
pub(crate) struct StepStacks {
    undo: Vec<LoggedStep>,
    redo: Vec<LoggedStep>,
    next_seq: u64,
}

/// An undo step and the number it is stored under, never reused within a map, so a stored
/// row with a live `seq` always holds that same step. `entry` is `None` while the step
/// is only on disk.
#[derive(Clone)]
pub(crate) struct LoggedStep {
    pub seq: u64,
    pub entry: Option<Arc<Entry>>,
}

impl StepStacks {
    /// Stacks for steps that are only on disk, from each one's `seq` and stack. New steps
    /// number after every stored one.
    pub(crate) fn on_disk(mut rows: Vec<(u64, Stack)>) -> Self {
        rows.sort_unstable_by_key(|(seq, _)| *seq);
        let next_seq = rows.last().map_or(0, |(seq, _)| seq + 1);
        let (undo, mut redo): (Vec<_>, Vec<_>) = rows
            .into_iter()
            .map(|(seq, stack)| (LoggedStep { seq, entry: None }, stack))
            .partition(|(_, stack)| *stack == Stack::Undo);
        redo.reverse();
        Self {
            undo: undo.into_iter().map(|(step, _)| step).collect(),
            redo: redo.into_iter().map(|(step, _)| step).collect(),
            next_seq,
        }
    }

    /// Record a new step: it goes on top of undo, under the cap, and redo is gone.
    /// Returns the `seq` it was stored under.
    pub(crate) fn record(&mut self, entry: Arc<Entry>) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.push(
            Stack::Undo,
            LoggedStep {
                seq,
                entry: Some(entry),
            },
        );
        self.redo.clear();
        seq
    }

    /// Join `later` to the newest step if its sequence and states match.
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
        top.seq = self.next_seq;
        self.next_seq += 1;
        self.redo.clear();
        Ok(top.seq)
    }

    fn stack_mut(&mut self, stack: Stack) -> &mut Vec<LoggedStep> {
        match stack {
            Stack::Undo => &mut self.undo,
            Stack::Redo => &mut self.redo,
        }
    }

    fn push(&mut self, stack: Stack, step: LoggedStep) {
        let steps = self.stack_mut(stack);
        steps.push(step);
        if steps.len() > MAX_UNDO_ENTRIES {
            let excess = steps.len() - MAX_UNDO_ENTRIES;
            steps.drain(..excess);
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

    /// Every step with its stack: undo bottom to top, then redo bottom to top.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (Stack, &LoggedStep)> {
        let undo = self.undo.iter().map(|e| (Stack::Undo, e));
        undo.chain(self.redo.iter().map(|e| (Stack::Redo, e)))
    }
}

/// Open-time `next_id` seed. Must exceed every id the system can re-materialize:
/// base rows, uncommitted overlay adds, and ids replayable from persisted undo/redo
/// (replay resurrects locations with their original ids; re-allocating one would
/// create a duplicate and break the strictly-sorted bake invariant).
pub(crate) fn seed_next_id(
    base_max: Option<Id<Location>>,
    adds: &[Location],
    history_max: Option<Id<Location>>,
) -> Ids<Id<Location>> {
    Ids::above(
        base_max
            .into_iter()
            .chain(adds.iter().map(|l| l.id))
            .chain(history_max),
    )
}

impl StepStacks {
    pub(crate) fn availability(&self) -> History {
        History {
            undo: !self.undo.is_empty(),
            redo: !self.redo.is_empty(),
        }
    }

    /// Move the newest step to the other stack, reversing it for undo.
    /// Load disk-only entries with `fetch`; a read failure clears history to avoid replaying across a gap.
    pub(crate) fn step(
        &mut self,
        from: Stack,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        let Some(mut step) = self.stack_mut(from).pop() else {
            return Ok(None);
        };
        let entry = match step.entry.take() {
            Some(entry) => entry,
            None => Arc::new(fetch(step.seq).inspect_err(|_| self.clear())?),
        };
        let changes = match from {
            Stack::Undo => entry.inverse(),
            Stack::Redo => (*entry).clone(),
        };
        step.entry = Some(entry);
        self.push(from.other(), step);
        Ok(Some(changes))
    }
}

impl Store {
    /// Whether each timeline can step either way.
    pub(crate) fn history(&self) -> HashMap<Timeline, History> {
        Timeline::ALL
            .iter()
            .map(|&timeline| (timeline, self.steps[timeline].availability()))
            .collect()
    }

    /// Move the newest step of `timeline` to its other stack and apply it.
    pub(crate) fn step(
        &mut self,
        from: Stack,
        timeline: Timeline,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<Entry>> {
        let Some(mut changes) = self.steps[timeline].edit().step(from, fetch)? else {
            return Ok(None);
        };
        changes.selections = match timeline {
            // The selections timeline may have moved the list since, so an edit's own
            // selection change applies only where the list still holds its before-state.
            Timeline::Edits => changes.selections.if_standing(&self.selections.table()),
            Timeline::Selections => {
                let before = self.selections.table();
                let mut rows = before.clone();
                changes.selections.apply_to(&mut rows);
                let after = self.valid_selections(rows);
                Change::at(&before, &after, before.keys().chain(after.keys()).cloned())
            }
        };
        self.put_entry(&changes);
        Ok(Some(changes))
    }
}

#[cfg(test)]
#[path = "history.test.rs"]
mod tests;
