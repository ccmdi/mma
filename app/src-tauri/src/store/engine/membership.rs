//! Resolved selection membership and the bitmasks shipped to the render overlay.

use super::*;
use crate::selections::{self, Selection, Selector};
use crate::types::Location;
use mma_algebra::{ordered_rows, ordered_table, Change, Keyed};
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

#[derive(Default)]
pub(crate) struct SelectionState {
    resolved: Vec<ResolvedSelection>,
    /// Resolved count of every selection node (top-level and nested), keyed by `Selection.key`.
    /// The faithful per-node count source for sidebar display; refreshed on every sync/resolve.
    pub node_counts: HashMap<String, u32>,
    /// Union of every member set. Answers "is this id selected".
    pub ids: RoaringBitmap,
    pub(crate) set_dependent: bool,
}

impl SelectionState {
    pub(crate) fn is_empty(&self) -> bool {
        self.resolved.is_empty()
    }

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
}

/// A selection as the sidebar lists it, plus whether it is ghosted.
// Ghosting means nothing for a nested child, which is why the flag lives here and not on
// `Selection`.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListedSelection {
    pub selection: Selection,
    /// Counted, but kept out of the overlay and the selected set.
    pub ghosted: bool,
}

impl Store {
    pub(super) fn selection_consequences(&mut self, entry: &Entry) -> SelectionDelta {
        let pruned = self.pruned_selections(entry);
        let colors: HashMap<(&str, u32), [u8; 3]> = entry
            .piles
            .iter()
            .flat_map(|(field, pile)| {
                pile.after().filter_map(move |(id, rec)| {
                    Some(((field.as_str(), *id), util::hex_to_rgb(rec.color()?)?))
                })
            })
            .collect();
        if colors.is_empty() {
            return pruned;
        }
        self.selections.change(&pruned, |rows| {
            rows.into_iter()
                .map(|row| ListedSelection {
                    selection: row
                        .selection
                        .recolored(&|field, id| colors.get(&(field, id)).copied()),
                    ..row
                })
                .collect()
        })
    }

    /// Remove selections naming values that this write emptied.
    fn pruned_selections(&mut self, entry: &Entry) -> SelectionDelta {
        let fields: Vec<_> = self.registry().interned().map(str::to_string).collect();
        let gone: HashSet<_> = self
            .fields(fields.iter().map(String::as_str))
            .into_iter()
            .flat_map(|values| {
                let field = values.field();
                let touched = entry
                    .piles
                    .get(field)
                    .into_iter()
                    .flat_map(|pile| pile.keys_iter())
                    .map(|id| id.to_string());
                values
                    .absent_after(&entry.rows, touched)
                    .into_iter()
                    .map(move |key| (field.to_string(), key))
            })
            .collect();
        if gone.is_empty() {
            return entry.selections.clone();
        }
        self.selections.rewrite(&entry.selections, &|selector| {
            if selector
                .member_test()
                .is_some_and(|(field, id)| gone.contains(&(field.to_string(), id.to_string())))
            {
                None
            } else {
                Some(selector.clone())
            }
        })
    }

    /// Recompute selection membership and per-node counts. Render bitmasks are built separately.
    pub(crate) fn resolve_selection_membership(&mut self) {
        let sels: Vec<Selection> = self
            .selections
            .resolved
            .iter()
            .map(|r| r.sel.clone())
            .collect();
        let (sets, node_counts) = self.resolve_forest(&sels);
        self.selections.resolve(sets, node_counts);
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

impl Keyed for ListedSelection {
    type Key = String;
    fn key(&self) -> String {
        self.selection.key.clone()
    }
}

pub(crate) type SelectionDelta = Change<(String, (u32, ListedSelection))>;

impl SelectionState {
    pub(crate) fn list(&self) -> Vec<ListedSelection> {
        self.resolved
            .iter()
            .map(|root| ListedSelection {
                selection: root.sel.clone(),
                ghosted: root.ghosted,
            })
            .collect()
    }

    /// Each live selection's colour, in the order frames index it.
    pub(crate) fn palette(&self) -> Vec<[u8; 3]> {
        self.live().map(|r| r.sel.color).collect()
    }

    pub(crate) fn table(&self) -> HashMap<String, (u32, ListedSelection)> {
        ordered_table(self.list())
    }

    pub(crate) fn change(
        &self,
        pending: &SelectionDelta,
        edit: impl FnOnce(Vec<ListedSelection>) -> Vec<ListedSelection>,
    ) -> SelectionDelta {
        let before = self.table();
        let mut held = before.clone();
        pending.apply_to(&mut held);
        let after = ordered_table(edit(ordered_rows(held)));
        Change::at(&before, &after, before.keys().chain(after.keys()).cloned())
    }

    pub(crate) fn rewrite(
        &self,
        pending: &SelectionDelta,
        edit: &impl Fn(&Selector) -> Option<Selector>,
    ) -> SelectionDelta {
        self.change(pending, |rows| {
            rows.into_iter()
                .filter_map(|row| {
                    Some(ListedSelection {
                        selection: row.selection.filter_map(edit)?,
                        ..row
                    })
                })
                .collect()
        })
    }

    pub(crate) fn apply(&mut self, change: &SelectionDelta) {
        let mut rows = self.table();
        change.apply_to(&mut rows);
        let rows = ordered_rows(rows);
        self.set_dependent = rows.iter().any(|root| !root.selection.selector.row_local());
        self.resolved = rows
            .into_iter()
            .map(|root| ResolvedSelection {
                sel: root.selection,
                ghosted: root.ghosted,
                set: RoaringBitmap::new(),
            })
            .collect();
    }

    pub(crate) fn resolve(&mut self, sets: Vec<RoaringBitmap>, counts: HashMap<String, u32>) {
        self.node_counts = counts;
        for (root, set) in self.resolved.iter_mut().zip(sets) {
            root.set = set;
        }
        self.ids = self.live_ids();
    }

    /// Update membership for changed rows and return ids whose selection colour changed.
    /// This includes moves between overlapping selections.
    pub(super) fn update(&mut self, changes: &Change<Location>) -> HashSet<u32> {
        let drop_ids: HashSet<u32> = changes.before().map(|l| l.id).collect();
        // Compare selection colours, since overlap can change a row's colour without deselecting it.
        let mut prev_paint: HashMap<u32, Option<u32>> = HashMap::new();
        if !drop_ids.is_empty() {
            for id in &drop_ids {
                prev_paint.insert(*id, self.paint_for(*id));
            }
            for r in &mut self.resolved {
                for id in &drop_ids {
                    r.set.remove(*id);
                }
            }
            for id in &drop_ids {
                self.ids.remove(*id);
            }
        }

        let test_locs: Vec<&Location> = changes.after().collect();
        // Split the borrow so membership and the union can be updated in one pass.
        let SelectionState { resolved, ids, .. } = self;
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
        let mut visited = HashSet::new();
        for root in &self.resolved {
            root.sel.fold(&mut |node, _| {
                if visited.insert(node.key.clone()) {
                    let before = changes
                        .before()
                        .filter(|row| selections::RowRef::from_loc(row).matches(&node.selector))
                        .count() as i64;
                    let after = changes
                        .after()
                        .filter(|row| selections::RowRef::from_loc(row).matches(&node.selector))
                        .count() as i64;
                    let count = self.node_counts.entry(node.key.clone()).or_default();
                    *count = (*count as i64 + after - before).max(0) as u32;
                }
            });
        }

        let mut changed = HashSet::new();
        for loc in changes.after() {
            // Added rows have no snapshot: their previous paint is None, and they compare
            // against whatever they resolve to now.
            let before = prev_paint.get(&loc.id).copied().flatten();
            if self.paint_for(loc.id) != before {
                changed.insert(loc.id);
            }
        }
        // A removed row leaves the overlay with its cell; nothing to state about it.
        changed
    }
}

impl Store {
    pub(crate) fn edit_selections(
        &mut self,
        op: &crate::selections::tree::SelectionOp,
    ) -> MutationResult {
        let before = self.selections.table();
        let rows = op
            .apply(&self.selections.list())
            .into_iter()
            .map(|row| match before.contains_key(&row.selection.key) {
                true => row,
                false => ListedSelection {
                    selection: row.selection.recolored(&|field, id| {
                        self.value_record(field, id)
                            .and_then(|rec| util::hex_to_rgb(rec.color()?))
                    }),
                    ..row
                },
            })
            .collect();
        self.replace_selections(rows)
    }

    pub(crate) fn valid_selections(&mut self, rows: Vec<ListedSelection>) -> Vec<ListedSelection> {
        let fields: Vec<_> = self.registry().interned().map(str::to_string).collect();
        let values = self.fields(fields.iter().map(String::as_str));
        rows.into_iter()
            .filter_map(|row| {
                let selection = row.selection.filter_map(&|selector| {
                    if selector.member_test().is_some_and(|(field, id)| {
                        values.iter().any(|values| {
                            values.field() == field && values.count(&id.to_string()) == 0
                        })
                    }) {
                        None
                    } else {
                        Some(selector.clone())
                    }
                })?;
                Some(ListedSelection { selection, ..row })
            })
            .collect()
    }

    fn replace_selections(&mut self, rows: Vec<ListedSelection>) -> MutationResult {
        let selections = self.selections.change(&SelectionDelta::default(), |_| rows);
        MutationResult {
            mutation: self.write(
                [],
                &mut None,
                Entry {
                    selections,
                    ..Default::default()
                },
            ),
        }
    }
}
