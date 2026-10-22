//! Undo and redo by replaying edits forward or in reverse.

use super::*;
use crate::types::{wire_str_enum, Location};
use mma_algebra::{Change, Delta, Id};
use mma_fields::Delta;
use std::ops::{Index, IndexMut};
use std::sync::Arc;

/// An entry serialized whole, its rows beside the rest, for `#[serde(with = "whole")]`. It
/// travels without the sender's selections, which stay each store's own.
pub(crate) mod whole {
    use super::Entry;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub(crate) fn serialize<S: Serializer>(
        entry: &Entry,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        (&entry.locations, &entry.records, &entry.defs, &entry.meta).serialize(serializer)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>, E: From<Entry>>(
        deserializer: D,
    ) -> Result<E, D::Error> {
        let (locations, records, defs, meta) = Deserialize::deserialize(deserializer)?;
        Ok(Entry {
            locations,
            records,
            defs,
            meta,
            selections: Default::default(),
        }
        .into())
    }
}

/// A change to the map, recorded for undo in the timeline its parts declare.
#[derive(Clone, Default, Debug, PartialEq, serde::Serialize, serde::Deserialize, Delta)]
pub struct Entry {
    /// The edit's changes to locations.
    #[serde(skip)]
    pub locations: Change<Location>,
    /// The edit's changes to the records of interned values such as tags, by field.
    #[serde(alias = "piles")]
    pub records: HashMap<String, Change<(Id<ValueRecord>, ValueRecord)>>,
    /// The edit's changes to the map's field definitions.
    pub defs: Change<(String, maps::FieldDef)>,
    /// The edit's changes to the map's details and settings, which are not undone.
    #[serde(default)]
    pub meta: Change<MapMeta>,
    /// The edit's changes to saved selections.
    #[serde(default)]
    pub selections: Change<(String, Listing)>,
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
/// row with a live `seq` always holds that same step. `join` names it to the writes that join
/// it, and outlives a fold that renumbers `seq`. `entry` is `None` while the step is only on
/// disk.
#[derive(Clone)]
pub(crate) struct LoggedStep {
    pub seq: u64,
    join: u64,
    pub entry: Option<Arc<Entry>>,
}

/// Where a write files its undo step.
pub(crate) enum Recording {
    /// A step of its own, or the step `join` names while it is the newest.
    Step(Option<u64>),
    /// A step being undone or redone, onto `onto` of `timeline` once the write lands.
    Moving {
        timeline: Timeline,
        onto: Stack,
        step: LoggedStep,
    },
    /// Nowhere: the write is not undone here.
    Off,
}

impl Default for Recording {
    fn default() -> Self {
        Recording::Step(None)
    }
}

impl Recording {
    /// What a write sent elsewhere carries of this recording: the step it joins, which later
    /// writes here join too, or the moving step itself.
    pub(crate) fn carried(&mut self) -> Recording {
        match self {
            Recording::Step(join) => Recording::Step(*join),
            moving => mem::replace(moving, Recording::Off),
        }
    }
}

impl StepStacks {
    /// Stacks for steps that are only on disk, from each one's `seq` and stack. New steps
    /// number after every stored one.
    pub(crate) fn on_disk(mut rows: Vec<(u64, Stack)>) -> Self {
        rows.sort_unstable_by_key(|(seq, _)| *seq);
        let next_seq = rows.last().map_or(0, |(seq, _)| seq + 1);
        let (undo, mut redo): (Vec<_>, Vec<_>) = rows
            .into_iter()
            .map(|(seq, stack)| {
                let step = LoggedStep {
                    seq,
                    join: seq,
                    entry: None,
                };
                (step, stack)
            })
            .partition(|(_, stack)| *stack == Stack::Undo);
        redo.reverse();
        Self {
            undo: undo.into_iter().map(|(step, _)| step).collect(),
            redo: redo.into_iter().map(|(step, _)| step).collect(),
            next_seq,
        }
    }

    /// Record a new step joined by `join`, or by its own `seq`: it goes on top of undo, under
    /// the cap, and redo is gone. Returns its join.
    pub(crate) fn record(&mut self, entry: Arc<Entry>, join: Option<u64>) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        let join = join.unwrap_or(seq);
        self.push(
            Stack::Undo,
            LoggedStep {
                seq,
                join,
                entry: Some(entry),
            },
        );
        self.redo.clear();
        join
    }

    /// A join no step holds, for writes that record their step later.
    pub(crate) fn fresh_join(&mut self) -> u64 {
        let join = self.next_seq;
        self.next_seq += 1;
        join
    }

    /// Join `later` to the newest step if `join` names it and their states match.
    /// Assign a fresh sequence so persistence replaces the old entry; return `later` if it cannot join.
    pub(crate) fn fold_into_newest(&mut self, join: u64, later: Entry) -> Result<(), Entry> {
        let Some(top) = self.undo.last_mut().filter(|top| top.join == join) else {
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
        Ok(())
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

    /// Take the newest step off `from`, with the change that steps it: its reverse for undo.
    /// Load disk-only entries with `fetch`; a read failure clears history to avoid replaying across a gap.
    pub(crate) fn take(
        &mut self,
        from: Stack,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> AppResult<Option<(Entry, LoggedStep)>> {
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
        Ok(Some((changes, step)))
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

    /// File `entry`'s undo step as `recording` says, in the entry's timeline for a new step.
    /// An entry too large to undo clears its timeline instead, and this returns true.
    pub(super) fn record(&mut self, entry: &Arc<Entry>, recording: &mut Recording) -> bool {
        match recording {
            Recording::Off => false,
            Recording::Moving { .. } => {
                let Recording::Moving {
                    timeline,
                    onto,
                    step,
                } = mem::replace(recording, Recording::Off)
                else {
                    unreachable!("matched as moving");
                };
                self.steps[timeline].edit().push(onto, step);
                false
            }
            Recording::Step(join) => {
                let Some(timeline) = entry.timeline() else {
                    return false;
                };
                let steps = self.steps[timeline].edit();
                if too_large_to_undo(entry.locations.len()) {
                    steps.clear();
                    return true;
                }
                if let Some(held) = *join {
                    if steps.fold_into_newest(held, (**entry).clone()).is_ok() {
                        return false;
                    }
                }
                *join = Some(steps.record(Arc::clone(entry), *join));
                false
            }
        }
    }

    /// Undo or redo the newest step of `timeline`. An edit applies as a change that must still
    /// stand on the map, and one refused here stays where it was.
    pub(crate) fn step(
        &mut self,
        from: Stack,
        timeline: Timeline,
        fetch: impl FnOnce(u64) -> AppResult<Entry>,
    ) -> Reached<Option<Mutation>> {
        let (mut changes, step) = match self.steps[timeline].edit().take(from, fetch) {
            Ok(Some(taken)) => taken,
            taken => return Reached::ready(taken.map(|_| None)),
        };
        log::debug!(
            "[{from:?} {timeline:?}] +{} ~{} -{}",
            changes.locations.added.len(),
            changes.locations.updated.len(),
            changes.locations.removed.len()
        );
        let mut moving = Recording::Moving {
            timeline,
            onto: from.other(),
            step,
        };
        let stepped = match timeline {
            Timeline::Edits => self
                .at(&Target::Map { id: None })
                .joining(&mut moving)
                .write(Intent::Entry(Box::new(changes)))
                .map(|edited| edited.mutation),
            Timeline::Selections => {
                let before = self.selections.table();
                let mut rows = before.clone();
                changes.selections.apply_to(&mut rows);
                let after = self.valid_selections(rows);
                changes.selections = Change::between(&before, &after);
                let stepped = self
                    .at(&Target::Map { id: None })
                    .joining(&mut moving)
                    .apply(changes);
                Reached::ready(Ok(stepped))
            }
        };
        if let Recording::Moving { onto, step, .. } = moving {
            self.steps[timeline].edit().push(onto.other(), step);
        }
        stepped.map(Some)
    }
}

#[cfg(test)]
#[path = "history.test.rs"]
mod tests;
