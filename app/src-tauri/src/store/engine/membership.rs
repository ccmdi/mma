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
    pub version: u64,
    /// Union of every member set. Answers "is this id selected".
    pub ids: RoaringBitmap,
    pub active_id: Option<u32>,
}

impl SelectionState {
    /// The selections that draw and select, in order: every one but the ghosted. Their
    /// position here is the selection index the overlay and the bitmask speak.
    pub(crate) fn live(&self) -> impl Iterator<Item = &ResolvedSelection> {
        self.resolved.iter().filter(|r| !r.ghosted)
    }

    /// Every id some live selection holds: the selected set.
    pub(crate) fn live_ids(&self) -> RoaringBitmap {
        self.live().fold(RoaringBitmap::new(), |acc, r| acc | &r.set)
    }

    /// Paint of a selected id = the last selection containing it. None if unselected.
    pub(super) fn paint_for(&self, id: u32) -> Option<SelPaint> {
        if !self.ids.contains(id) {
            return None;
        }
        let mut paint = None;
        for (i, r) in self.live().enumerate() {
            if r.set.contains(id) {
                paint = Some(SelPaint {
                    idx: i as u32,
                    color: r.sel.color,
                });
            }
        }
        paint
    }

    /// Bulk form of `paint_for`. Later selections overwrite earlier ones, so each id ends
    /// up with the same paint the per-id lookup would return.
    pub(super) fn paint_map(&self) -> HashMap<u32, SelPaint> {
        let mut map = HashMap::with_capacity(self.ids.len() as usize);
        for (i, r) in self.live().enumerate() {
            let paint = SelPaint {
                idx: i as u32,
                color: r.sel.color,
            };
            for id in &r.set {
                map.insert(id, paint);
            }
        }
        map
    }
}

/// Ids whose selection paint changed in a mutation - including moves between overlapping
/// selections, where union membership never flips but the winning colour does. Carries no
/// paint: `SelectionState::paint_for` is the one place colour and draw order is decided.
pub(super) struct MembershipDelta {
    pub(super) changed: HashSet<u32>,
}

/// Selection bitmask sync payload. `bitmask` carries the packed per-cell bitmask bytes
/// inline in the IPC response (no shared temp file → no clobber race under concurrent
/// mutations). `None` when nothing changed. `counts` gives per-selection match counts.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSync {
    /// Resolved count per selection node, keyed by `Selection.key` (top-level and nested).
    pub counts: HashMap<String, u32>,
    pub bitmask: Option<Vec<u8>>,
    pub selected_count: usize,
}

/// Input for `store_sync_selections`: selection criteria + display color.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionInput {
    /// Deterministic selection key (e.g. `"tag:5"`), used to return per-node counts back keyed.
    pub key: String,
    pub selector: Selector,
    pub color: [u8; 3],
    /// Counted, but kept out of the overlay and the selected set.
    #[serde(default)]
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
                    | Selector::TopK { .. }
                    | Selector::Uncommitted
                    | Selector::Intersection { .. }
                    | Selector::Union { .. }
                    | Selector::Invert { .. }
            )
        })
    }

    /// Update selection membership sets for incremental changes (adds/removes/updates).
    /// Returns which ids changed paint, so the render delta can state their new
    /// selection state.
    pub(super) fn update_selection_membership(&mut self, changes: &ChangeSet) -> MembershipDelta {
        let drop_ids: HashSet<u32> = changes
            .removed
            .iter()
            .copied()
            .chain(changes.updated.iter().map(|(_, n)| n.id))
            .collect();
        // Paint before the mutation, snapshotted while the sets still reflect it. Paint is
        // the compared fact - not union membership - because a row that moves between
        // overlapping selections changes colour without ever leaving the union.
        let mut prev_paint: HashMap<u32, Option<SelPaint>> = HashMap::new();
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
        self.selections.version += 1;
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
        MembershipDelta { changed }
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
        let (loc_sets, node_counts) = {
            let view = self.loc_view();
            selections::resolve_forest(&view, &sels)
        };
        self.selections.node_counts = node_counts;
        self.selections.resolved = pair_selections(sels, loc_sets, ghosted);

        self.selections.ids = self.selections.live_ids();
        self.selections.version += 1;
    }

    /// Build the full selection bitmask from the current render cells + member sets.
    /// Every cell is rebuilt; incremental membership changes ride the `sel` field on the
    /// render delta's own entries instead (see `finish_mutation`).
    pub(super) fn build_selection_bitmask(&self) -> SelectionSync {
        let counts = self.selections.node_counts.clone();
        let selected_count = self.selections.ids.len() as usize;

        let t0 = Instant::now();
        let live: Vec<&ResolvedSelection> = self.selections.live().collect();
        let num_sels = live.len();
        let (buf, num_cells) = build_selection_buf(&self.render, &live);
        let bitmask = if num_cells > 0 { Some(buf) } else { None };

        log::debug!(
            "[sel] total={}ms sels={} selected={} cells={}",
            t0.elapsed().as_millis(),
            num_sels,
            selected_count,
            num_cells,
        );

        SelectionSync {
            counts,
            bitmask,
            selected_count,
        }
    }
}
