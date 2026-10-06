//! Operation-based undo/redo: each edit is a remove-set plus a create-set, replayed in either direction.

use super::*;
use crate::types::Location;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

pub(super) const MAX_UNDO_ENTRIES: usize = 1000;

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
    pub entry: Option<Arc<EditEntry>>,
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
    pub(crate) fn record(&mut self, entry: EditEntry) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.push_undo(LoggedEdit {
            seq,
            entry: Some(Arc::new(entry)),
        });
        self.redo.clear();
        seq
    }

    /// Fold update pairs into the newest edit when it is `seq` and in memory, and give it
    /// a fresh `seq`: a stored row keeps the edit as it was when stored, so the grown edit
    /// is stored anew and the old row goes on the next save. Redo is gone, as for any new
    /// edit. Hands `pairs` back when the newest edit is another.
    pub(crate) fn fold_into_newest(
        &mut self,
        seq: u64,
        pairs: Vec<(Location, Location)>,
    ) -> Result<u64, Vec<(Location, Location)>> {
        let Some(top) = self.undo.last_mut().filter(|top| top.seq == seq) else {
            return Err(pairs);
        };
        let Some(entry) = top.entry.as_mut() else {
            return Err(pairs);
        };
        Arc::make_mut(entry).fold_updates(pairs);
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

/// One undo/redo entry. Records the locations created and removed by a single user action.
/// Updates are encoded as simultaneous remove-old + create-new with the same ID.
/// Reversing an entry swaps `created` and `removed`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EditEntry {
    pub created: Vec<Location>,
    pub removed: Vec<Location>,
}

impl EditEntry {
    /// Fold update pairs in, keeping each row's first `removed` and newest `created`, so
    /// undoing the entry restores what stood before its first touch of the row.
    fn fold_updates(&mut self, pairs: Vec<(Location, Location)>) {
        let mut at: HashMap<u32, usize> = self
            .created
            .iter()
            .enumerate()
            .map(|(i, l)| (l.id, i))
            .collect();
        for (old, new) in pairs {
            match at.entry(new.id) {
                Entry::Occupied(e) => self.created[*e.get()] = new,
                Entry::Vacant(v) => {
                    v.insert(self.created.len());
                    self.created.push(new);
                    self.removed.push(old);
                }
            }
        }
    }

    /// Highest location id this edit can re-materialize.
    pub(crate) fn max_id(&self) -> u32 {
        self.created
            .iter()
            .chain(&self.removed)
            .map(|l| l.id)
            .max()
            .unwrap_or(0)
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
    /// Record the changed (old != new) pairs for undo: into the edit `group` names while
    /// it is still the newest one, else as a new entry. Either way `group` is pointed at
    /// the entry's `seq`, which a fold renews. Any edit or undo in between moves the
    /// group's entry off the top, so the next batch of a grouped run starts fresh.
    /// Returns whether anything was recorded.
    pub(super) fn record_update_undo(
        &mut self,
        group: &mut Option<u64>,
        updated: impl IntoIterator<Item = (Location, Location)>,
    ) -> bool {
        let changed: Vec<(Location, Location)> =
            updated.into_iter().filter(|(o, n)| o != n).collect();
        if changed.is_empty() {
            return false;
        }
        let edits = self.edits.edit();
        let changed = match *group {
            Some(seq) => match edits.fold_into_newest(seq, changed) {
                Ok(seq) => {
                    *group = Some(seq);
                    return true;
                }
                Err(changed) => changed,
            },
            None => changed,
        };
        let (removed, created): (Vec<_>, Vec<_>) = changed.into_iter().unzip();
        *group = Some(edits.record(EditEntry { created, removed }));
        true
    }

    /// Core edit primitive: atomically remove then create locations in the overlay.
    /// Undo/redo swap the arguments. O(R + C) where R = removed, C = created.
    /// The changeset takes ownership of the rows - removed rows move through it without
    /// a clone (they left the store), and `apply_undoable` moves them back out into the
    /// undo entry after `finish_mutation` has projected them.
    pub(crate) fn apply_edit(&mut self, remove: Vec<Location>, create: Vec<Location>) -> ChangeSet {
        let t0 = Instant::now();

        self.overlay_remove(&remove);
        self.overlay_add(create.clone());

        // Categorize: same-id remove+create is an update; the rest are pure add/remove.
        let mut changes = ChangeSet::default();
        let mut removed_by_id: HashMap<u32, Location> =
            remove.into_iter().map(|l| (l.id, l)).collect();
        for loc in create {
            match removed_by_id.remove(&loc.id) {
                Some(old) => changes.updated.push((old, loc)),
                None => changes.added.push(loc),
            }
        }
        changes.removed = removed_by_id.into_values().collect();

        log::debug!(
            "[apply_edit] +{} ~{} -{} in {}ms",
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len(),
            t0.elapsed().as_millis()
        );
        changes
    }

    pub(crate) fn apply_edit_forward(&mut self, entry: &EditEntry) -> ChangeSet {
        self.apply_edit(entry.removed.clone(), entry.created.clone())
    }

    pub(crate) fn apply_edit_reverse(&mut self, entry: &EditEntry) -> ChangeSet {
        self.apply_edit(entry.created.clone(), entry.removed.clone())
    }

    /// Apply an edit, finish the mutation, then record undo by moving the rows back out
    /// of the changeset (the report step ships the stack change on the same result).
    /// No-op when both sides are empty.
    pub(crate) fn apply_undoable(
        &mut self,
        remove: Vec<Location>,
        create: Vec<Location>,
    ) -> MutationResult {
        if remove.is_empty() && create.is_empty() {
            return self.finish_mutation(&ChangeSet::default());
        }
        let changes = self.apply_edit(remove, create);
        let mut result = self.finish_mutation(&changes);
        let ChangeSet {
            added,
            removed,
            updated,
            ..
        } = changes;
        let (mut created, mut removed_rows) = (added, removed);
        for (old, new) in updated {
            removed_rows.push(old);
            created.push(new);
        }
        self.push_undo(EditEntry {
            created,
            removed: removed_rows,
        });
        self.report(&mut result);
        result
    }

    /// Record a new edit; redo is gone.
    pub(crate) fn push_undo(&mut self, entry: EditEntry) {
        self.edits.edit().record(entry);
    }

    /// Reverse the newest edit and move it to redo. `fetch` reads an edit that is only on
    /// disk; when it fails the whole history goes, since replaying around a gap would
    /// corrupt the map. `None` when there is nothing to undo.
    pub(crate) fn undo(
        &mut self,
        fetch: impl FnOnce(u64) -> AppResult<EditEntry>,
    ) -> AppResult<Option<ChangeSet>> {
        self.step(Stack::Undo, fetch)
    }

    /// Re-apply the newest undone edit and move it back to undo. As [`Store::undo`].
    pub(crate) fn redo(
        &mut self,
        fetch: impl FnOnce(u64) -> AppResult<EditEntry>,
    ) -> AppResult<Option<ChangeSet>> {
        self.step(Stack::Redo, fetch)
    }

    fn step(
        &mut self,
        from: Stack,
        fetch: impl FnOnce(u64) -> AppResult<EditEntry>,
    ) -> AppResult<Option<ChangeSet>> {
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
            Stack::Undo => self.apply_edit_reverse(&entry),
            Stack::Redo => self.apply_edit_forward(&entry),
        };
        edit.entry = Some(entry);
        let edits = self.edits.edit();
        match from {
            Stack::Undo => edits.redo.push(edit),
            Stack::Redo => edits.push_undo(edit),
        }
        Ok(Some(changes))
    }
}
