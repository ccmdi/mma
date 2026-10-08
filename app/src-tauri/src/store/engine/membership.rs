//! Resolved selection membership and the bitmasks shipped to the render overlay.

use super::*;
use crate::selections::{self, Selection, Selector};
use crate::types::Location;
use roaring::RoaringBitmap;
use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// A selection together with its resolved membership. One value rather than two parallel
/// vectors, so the index correspondence the color lookups depend on cannot drift.
pub(crate) struct ResolvedSelection {
    pub sel: Selection,
    /// Member location ids.
    pub set: RoaringBitmap,
    /// Counted, but kept out of the overlay and the selected set.
    pub ghosted: bool,
}

/// Zip selections with the member sets `resolve_forest` returned for them. The only place
/// the two are joined, so the pairing is stated once.
pub(crate) fn pair_selections(
    sels: Vec<Selection>,
    sets: Vec<RoaringBitmap>,
    ghosted: impl IntoIterator<Item = bool>,
) -> Vec<ResolvedSelection> {
    debug_assert_eq!(
        sels.len(),
        sets.len(),
        "resolve_forest returns one set per selection"
    );
    sels.into_iter()
        .zip(sets)
        .zip(ghosted)
        .map(|((sel, set), ghosted)| ResolvedSelection { sel, set, ghosted })
        .collect()
}

pub(crate) struct SelectionState {
    pub resolved: Vec<ResolvedSelection>,
    /// Resolved count of every selection node (top-level and nested), keyed by `Selection.key`.
    /// The faithful per-node count source for sidebar display; refreshed on every sync/resolve.
    pub node_counts: HashMap<String, u32>,
    /// Union of every member set. Answers "is this id selected".
    pub ids: RoaringBitmap,
}

impl SelectionState {
    /// The selections that draw and select, in order: every one but the ghosted. Their
    /// position here is the selection index the overlay and the bitmask speak.
    pub(crate) fn live(&self) -> impl Iterator<Item = &ResolvedSelection> {
        self.resolved.iter().filter(|r| !r.ghosted)
    }

    /// Every id some live selection holds: the selected set.
    pub(crate) fn live_ids(&self) -> RoaringBitmap {
        self.live()
            .fold(RoaringBitmap::new(), |acc, r| acc | &r.set)
    }

    /// The live selection painting a selected id: the last one containing it, by its
    /// index in `live` order. `None` if unselected.
    pub(super) fn paint_for(&self, id: u32) -> Option<u32> {
        if !self.ids.contains(id) {
            return None;
        }
        self.live()
            .enumerate()
            .filter(|(_, r)| r.set.contains(id))
            .last()
            .map(|(i, _)| i as u32)
    }

    /// Bulk form of `paint_for`. Later selections overwrite earlier ones, so each id ends
    /// up with the same paint the per-id lookup would return.
    pub(super) fn paint_map(&self) -> HashMap<u32, u32> {
        let mut map = HashMap::with_capacity(self.ids.len() as usize);
        for (i, r) in self.live().enumerate() {
            for id in &r.set {
                map.insert(id, i as u32);
            }
        }
        map
    }

    /// Every live selection's colour, indexed by the paint `paint_for` returns.
    pub(crate) fn palette(&self) -> Vec<[u8; 3]> {
        self.live().map(|r| r.sel.color).collect()
    }
}

/// A selection as the sidebar lists it, plus whether it is ghosted.
// Ghosting means nothing for a nested child, which is why the flag lives here and not on
// `Selection`.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListedSelection {
    pub selection: Selection,
    /// Counted, but kept out of the overlay and the selected set.
    pub ghosted: bool,
}

impl Store {
    /// Whether any active selection requires a full O(S*N) resolve rather than
    /// incremental membership updates (composites and duplicates depend on global state).
    pub(super) fn selections_need_full_resolve(&self) -> bool {
        self.selections.resolved.iter().any(|r| {
            matches!(
                r.sel.selector,
                Selector::Duplicates { .. }
                    | Selector::Ranked { .. }
                    | Selector::Uncommitted
                    | Selector::Intersection { .. }
                    | Selector::Union { .. }
                    | Selector::Invert { .. }
            )
        })
    }

    /// Update selection membership sets for incremental changes (adds/removes/updates).
    /// Returns the ids whose paint changed - including moves between overlapping
    /// selections, where union membership never flips but the winning colour does - so the
    /// render frame can state their new selection state.
    pub(super) fn update_selection_membership(&mut self, changes: &Change) -> HashSet<u32> {
        let drop_ids: HashSet<u32> = changes
            .removed
            .iter()
            .map(|l| l.id)
            .chain(changes.updated.iter().map(|(_, n)| n.id))
            .collect();
        // Paint before the mutation, snapshotted while the sets still reflect it. Paint is
        // the compared fact - not union membership - because a row that moves between
        // overlapping selections changes colour without ever leaving the union.
        let mut prev_paint: HashMap<u32, Option<u32>> = HashMap::new();
        if !drop_ids.is_empty() {
            for id in &drop_ids {
                prev_paint.insert(*id, self.selections.paint_for(*id));
            }
            for r in &mut self.selections.resolved {
                for id in &drop_ids {
                    r.set.remove(*id);
                }
            }
            for id in &drop_ids {
                self.selections.ids.remove(*id);
            }
        }

        let test_locs: Vec<&Location> = changes
            .added
            .iter()
            .chain(changes.updated.iter().map(|(_, n)| n))
            .collect();
        // Split the borrow so membership and the union can be updated in one pass.
        let SelectionState { resolved, ids, .. } = &mut self.selections;
        for r in resolved.iter_mut() {
            for loc in &test_locs {
                if selections::RowRef::from_loc(loc).matches(&r.sel.selector) {
                    r.set.insert(loc.id);
                    if !r.ghosted {
                        ids.insert(loc.id);
                    }
                }
            }
        }
        // Incremental path runs only without composites, so every node is top-level.
        self.selections.node_counts = self
            .selections
            .resolved
            .iter()
            .map(|r| (r.sel.key.clone(), r.set.len() as u32))
            .collect();

        let mut changed = HashSet::new();
        for loc in changes
            .added
            .iter()
            .chain(changes.updated.iter().map(|(_, n)| n))
        {
            // Added rows have no snapshot: their previous paint is None, and they compare
            // against whatever they resolve to now.
            let before = prev_paint.get(&loc.id).copied().flatten();
            if self.selections.paint_for(loc.id) != before {
                changed.insert(loc.id);
            }
        }
        // A removed row leaves the overlay with its cell; nothing to state about it.
        changed
    }

    /// Full selection membership resolve: recomputes every member set, the union, and the
    /// per-node counts from scratch. O(S * N). Does NOT build the bitmask.
    pub(super) fn resolve_selection_membership(&mut self) {
        let sels: Vec<Selection> = self
            .selections
            .resolved
            .iter()
            .map(|r| r.sel.clone())
            .collect();
        let ghosted: Vec<bool> = self.selections.resolved.iter().map(|r| r.ghosted).collect();
        let (loc_sets, node_counts) = self.resolve_forest(&sels);
        self.selections.node_counts = node_counts;
        self.selections.resolved = pair_selections(sels, loc_sets, ghosted);

        self.selections.ids = self.selections.live_ids();
    }

    /// Every cell's selection membership, the selection section of a frame.
    pub(super) fn selection_section(&self) -> Vec<u8> {
        let t0 = Instant::now();
        let live: Vec<&ResolvedSelection> = self.selections.live().collect();
        let (buf, num_cells) = build_selection_buf(&self.render, &live);
        log::debug!(
            "[sel] total={}ms sels={} selected={} cells={}",
            t0.elapsed().as_millis(),
            live.len(),
            self.selections.ids.len(),
            num_cells,
        );
        buf
    }
}
