//! Resolved selection membership and the bitmasks shipped to the render overlay.

use super::*;
use crate::selections::tree::SelectionOp;
use crate::selections::{self, Selection};
use crate::store::id_set::IdSet;
use crate::types::Location;
use crate::util::Rgb;
use mma_algebra::{Change, Id};
use std::collections::{HashMap, HashSet};
use std::time::Instant;

/// A selection together with its resolved membership. One value rather than two parallel
/// vectors, so the index correspondence the color lookups depend on cannot drift.
pub(crate) struct ResolvedSelection {
    pub sel: Selection,
    /// Its place in the list.
    pub order: u32,
    /// Member location ids.
    pub set: IdSet<Location>,
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
    pub ids: IdSet<Location>,
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
    pub(crate) fn live_ids(&self) -> IdSet<Location> {
        self.live().fold(IdSet::new(), |acc, r| acc | &r.set)
    }

    /// The live selection painting a selected id: the last one containing it, by its
    /// index in `live` order. `None` if unselected.
    pub(super) fn paint_for(&self, id: Id<Location>) -> Option<PaletteIdx> {
        if !self.ids.contains(id) {
            return None;
        }
        self.live()
            .enumerate()
            .filter(|(_, r)| r.set.contains(id))
            .last()
            .map(|(i, _)| PaletteIdx(i as u32))
    }

    /// Bulk form of `paint_for`. Later selections overwrite earlier ones, so each id ends
    /// up with the same paint the per-id lookup would return.
    pub(super) fn paint_map(&self) -> HashMap<Id<Location>, PaletteIdx> {
        let mut map = HashMap::with_capacity(self.ids.len() as usize);
        for (i, r) in self.live().enumerate() {
            for id in &r.set {
                map.insert(id, PaletteIdx(i as u32));
            }
        }
        map
    }
}

/// A selection as the sidebar lists it, plus whether it is ghosted.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ListedSelection {
    pub selection: Selection,
    /// Counted, but kept out of the overlay and the selected set.
    pub ghosted: bool,
}

impl Store {
    /// What `entry` does to the selection list beyond its own changes: selections naming
    /// values it empties are pruned, and a selection naming a value paints in that value's
    /// record colour, when the selection is new to the list or the entry changes the record.
    pub(super) fn selection_consequences(&mut self, entry: &Entry) -> SelectionDelta {
        let pruned = self.pruned_selections(entry);
        let changed: HashMap<(&str, Id<ValueRecord>), Rgb> = entry
            .records
            .iter()
            .flat_map(|(field, pile)| {
                pile.after()
                    .filter_map(move |(id, rec)| Some(((field.as_str(), *id), rec.shown_color()?)))
            })
            .collect();
        let listed = self.selections.table();
        let is_new = |key: &str| !listed.contains_key(key);
        if changed.is_empty() && !pruned.after().any(|(key, _)| is_new(key)) {
            return pruned;
        }
        self.selections.change(&pruned, |rows| {
            rows.into_iter()
                .map(|row| {
                    let new = is_new(&row.selection.key);
                    let color = |field: &str, id: u32| {
                        let id = Id::new(id);
                        changed.get(&(field, id)).copied().or_else(|| {
                            new.then(|| self.value_record(field, id)?.shown_color())
                                .flatten()
                        })
                    };
                    ListedSelection {
                        selection: row.selection.recolored(&color),
                        ..row
                    }
                })
                .collect()
        })
    }

    /// Remove the listed rows that are exactly a test for a value this write emptied.
    fn pruned_selections(&mut self, entry: &Entry) -> SelectionDelta {
        let gone = self.emptied_values(&entry.locations, |field| {
            entry
                .records
                .get(field)
                .into_iter()
                .flat_map(Change::keys_iter)
                .map(|id| id.to_string())
                .collect()
        });
        if gone.is_empty() {
            return entry.selections.clone();
        }
        self.selections.change(&entry.selections, |rows| {
            rows.into_iter()
                .filter(|row| !names_emptied(&gone, row))
                .collect()
        })
    }

    /// Interned values that hold no row once `rows` apply, among the values `rows` move and
    /// the ones `touched` names for each field, as field and value.
    fn emptied_values(
        &mut self,
        rows: &Change<Location>,
        touched: impl Fn(&str) -> Vec<String>,
    ) -> HashSet<(String, String)> {
        let fields: Vec<_> = self.registry().interned().map(str::to_string).collect();
        self.fields(fields.iter().map(String::as_str))
            .into_iter()
            .flat_map(|values| {
                let field = values.field();
                values
                    .absent_after(rows, touched(field))
                    .into_iter()
                    .map(move |key| (field.to_string(), key))
            })
            .collect()
    }

    /// Recompute selection membership and per-node counts. Render bitmasks are built separately.
    pub(crate) fn resolve_selection_membership(&mut self) {
        #[cfg(test)]
        tests::RESOLVES.with(|n| n.set(n.get() + 1));
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

/// Whether `row` is exactly the test for membership of a value in `gone`.
fn names_emptied(gone: &HashSet<(String, String)>, row: &ListedSelection) -> bool {
    row.selection
        .selector
        .member_test()
        .is_some_and(|(field, id)| gone.contains(&(field.to_string(), id.to_string())))
}

/// A listed selection and its place in the list, counted from the top.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Listing {
    pub(crate) order: u32,
    pub(crate) row: ListedSelection,
}

pub(crate) type SelectionDelta = Change<(String, Listing)>;

/// `table`'s listings in list order, ties broken by key.
fn in_order(table: HashMap<String, Listing>) -> Vec<Listing> {
    let mut rows: Vec<Listing> = table.into_values().collect();
    rows.sort_by(|x, y| {
        x.order
            .cmp(&y.order)
            .then_with(|| x.row.selection.key.cmp(&y.row.selection.key))
    });
    rows
}

/// `table`'s rows in list order.
pub(crate) fn listed_rows(table: HashMap<String, Listing>) -> Vec<ListedSelection> {
    in_order(table)
        .into_iter()
        .map(|listing| listing.row)
        .collect()
}

/// `rows` keyed by their keys, each placed at its position.
fn numbered(rows: Vec<ListedSelection>) -> HashMap<String, Listing> {
    rows.into_iter()
        .zip(0..)
        .map(|(row, order)| (row.selection.key.clone(), Listing { order, row }))
        .collect()
}

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
    pub(crate) fn palette(&self) -> Vec<Rgb> {
        self.live().map(|r| r.sel.color).collect()
    }

    pub(crate) fn table(&self) -> HashMap<String, Listing> {
        self.resolved
            .iter()
            .map(|root| {
                let row = ListedSelection {
                    selection: root.sel.clone(),
                    ghosted: root.ghosted,
                };
                (
                    root.sel.key.clone(),
                    Listing {
                        order: root.order,
                        row,
                    },
                )
            })
            .collect()
    }

    pub(crate) fn change(
        &self,
        pending: &SelectionDelta,
        edit: impl FnOnce(Vec<ListedSelection>) -> Vec<ListedSelection>,
    ) -> SelectionDelta {
        let before = self.table();
        let mut held = before.clone();
        pending.apply_to(&mut held);
        let after = numbered(edit(listed_rows(held)));
        Change::at(&before, &after, before.keys().chain(after.keys()).cloned())
    }

    pub(crate) fn apply(&mut self, change: &SelectionDelta) {
        let mut table = self.table();
        change.apply_to(&mut table);
        let rows = in_order(table);
        self.set_dependent = rows
            .iter()
            .any(|listing| !listing.row.selection.selector.row_local());
        self.resolved = rows
            .into_iter()
            .map(|Listing { order, row }| ResolvedSelection {
                sel: row.selection,
                order,
                ghosted: row.ghosted,
                set: IdSet::new(),
            })
            .collect();
    }

    pub(crate) fn resolve(&mut self, sets: Vec<IdSet<Location>>, counts: HashMap<String, u32>) {
        self.node_counts = counts;
        for (root, set) in self.resolved.iter_mut().zip(sets) {
            root.set = set;
        }
        self.ids = self.live_ids();
    }

    /// Update membership for changed rows and return ids whose selection colour changed.
    /// This includes moves between overlapping selections.
    pub(super) fn update(&mut self, changes: &Change<Location>) -> HashSet<Id<Location>> {
        let drop_ids: HashSet<Id<Location>> = changes.before().map(|l| l.id).collect();
        // Compare selection colours, since overlap can change a row's colour without deselecting it.
        let mut prev_paint: HashMap<Id<Location>, Option<PaletteIdx>> = HashMap::new();
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
    pub(crate) fn edit_selections(&mut self, op: &SelectionOp) -> MutationResult<ListedSelection> {
        let rows = op.apply(&self.selections.list());
        self.replace_selections(rows)
    }

    /// `table` without the rows that are exactly a test for a value no row holds any more.
    pub(crate) fn valid_selections(
        &mut self,
        table: HashMap<String, Listing>,
    ) -> HashMap<String, Listing> {
        let named = |field: &str| {
            table
                .values()
                .filter_map(|listing| listing.row.selection.selector.member_test())
                .filter(|(tested, _)| *tested == field)
                .map(|(_, id)| id.to_string())
                .collect()
        };
        let gone = self.emptied_values(&Change::default(), named);
        table
            .into_iter()
            .filter(|(_, listing)| !names_emptied(&gone, &listing.row))
            .collect()
    }

    fn replace_selections(
        &mut self,
        rows: Vec<ListedSelection>,
    ) -> MutationResult<ListedSelection> {
        let selections = self.selections.change(&SelectionDelta::default(), |_| rows);
        let written = self.write(
            [],
            &mut None,
            Entry {
                selections,
                ..Default::default()
            },
        );
        MutationResult {
            mutation: Mutation {
                version: written.version,
                keys: Vec::new(),
                history_cleared: written.history_cleared,
            },
        }
    }
}
