//! Operation-based undo/redo: each edit is a remove-set plus a create-set, replayed in either direction.

use super::*;
use crate::types::Location;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

pub(super) const MAX_UNDO_ENTRIES: usize = 1000;

pub(crate) struct EditStacks {
    pub undo: Vec<EditEntry>,
    pub redo: Vec<EditEntry>,
}

/// One undo/redo entry. Records the locations created and removed by a single user action.
/// Updates are encoded as simultaneous remove-old + create-new with the same ID.
/// Reversing an entry swaps `created` and `removed`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct EditEntry {
    pub created: Vec<Location>,
    pub removed: Vec<Location>,
}

/// Highest location id referenced anywhere in the undo/redo stacks. Used to seed
/// `next_id` on map open so undo/redo replay can never collide with a fresh allocation.
pub(crate) fn history_max_id(undo: &[EditEntry], redo: &[EditEntry]) -> u32 {
    undo.iter()
        .chain(redo.iter())
        .flat_map(|e| e.created.iter().chain(e.removed.iter()))
        .map(|l| l.id)
        .max()
        .unwrap_or(0)
}

/// Open-time `next_id` seed. Must exceed every id the system can re-materialize:
/// base rows, uncommitted overlay adds, and ids replayable from persisted undo/redo
/// (replay resurrects locations with their original ids; re-allocating one would
/// create a duplicate and break the strictly-sorted bake invariant).
pub(crate) fn seed_next_id(
    base_max: u32,
    adds: &[Location],
    undo: &[EditEntry],
    redo: &[EditEntry],
) -> u32 {
    let max_add = adds.iter().map(|l| l.id).max().unwrap_or(0);
    base_max.max(max_add).max(history_max_id(undo, redo)) + 1
}

impl Store {
    /// Push an undo entry for the changed (old != new) pairs and clear redo. Returns
    /// whether anything was pushed.
    pub(super) fn record_update_undo(
        &mut self,
        updated: impl IntoIterator<Item = (Location, Location)>,
    ) -> bool {
        let (changed_old, changed_new): (Vec<_>, Vec<_>) =
            updated.into_iter().filter(|(o, n)| o != n).unzip();
        if changed_old.is_empty() {
            return false;
        }
        self.push_undo(EditEntry {
            created: changed_new,
            removed: changed_old,
        });
        self.edits.redo.clear();
        true
    }

    /// Core edit primitive: atomically remove then create locations, updating tags, overlay,
    /// and render cells. Undo/redo swap the arguments. O(R + C) where R = removed, C = created.
    pub(super) fn apply_edit(&mut self, remove: &[Location], create: &[Location]) -> ChangeSet {
        let t0 = Instant::now();
        let create_ids: HashSet<u32> = create.iter().map(|l| l.id).collect();
        let remove_by_id: HashMap<u32, &Location> = remove.iter().map(|l| (l.id, l)).collect();

        self.remove_tag_counts(remove);
        self.overlay_remove(remove);
        self.add_tag_counts(create);
        self.overlay_add(create.to_vec());

        // Categorize: same-id remove+create is an update; the rest are pure add/remove.
        let mut changes = ChangeSet::default();
        for loc in remove {
            if !create_ids.contains(&loc.id) {
                changes.removed.push(loc.id);
            }
        }
        for loc in create {
            if let Some(old) = remove_by_id.get(&loc.id) {
                changes.updated.push(((*old).clone(), loc.clone()));
            } else {
                changes.added.push(loc.clone());
            }
        }

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
        self.apply_edit(&entry.removed, &entry.created)
    }

    pub(crate) fn apply_edit_reverse(&mut self, entry: &EditEntry) -> ChangeSet {
        self.apply_edit(&entry.created, &entry.removed)
    }

    /// Apply an edit, record undo, clear redo, finish mutation. No-op when both sides empty.
    pub(crate) fn apply_undoable(
        &mut self,
        remove: Vec<Location>,
        create: Vec<Location>,
    ) -> MutationResult {
        if remove.is_empty() && create.is_empty() {
            return self.finish_mutation(&ChangeSet::default());
        }
        let changes = self.apply_edit(&remove, &create);
        self.push_undo(EditEntry {
            created: create,
            removed: remove,
        });
        self.edits.redo.clear();
        self.finish_mutation(&changes)
    }

    /// Push an edit onto the undo stack, capping at MAX_UNDO_ENTRIES. O(1) amortized.
    pub(crate) fn push_undo(&mut self, entry: EditEntry) {
        self.edits.undo.push(entry);
        if self.edits.undo.len() > MAX_UNDO_ENTRIES {
            self.edits
                .undo
                .drain(..self.edits.undo.len() - MAX_UNDO_ENTRIES);
        }
    }
}
