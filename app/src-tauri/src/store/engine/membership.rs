//! Resolved selection membership and the bitmasks shipped to the render overlay.

use super::*;
use crate::selections::tree::SelectionOp;
use crate::selections::{self, Selection};
use crate::selections::{PolygonGeometry, Selector};
use crate::store::engine::frame::{polygon_mesh, PolygonFrame};
use crate::store::id_set::IdSet;
use crate::types::Location;
use crate::util::Rgb;
use mma_algebra::{Change, Id};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
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
    /// The list as every window holds it.
    sent: Vec<ListedSelection>,
    /// Keys of listed selections whose members are not resolved yet.
    unresolved: HashSet<String>,
    /// The mesh of every polygon in the list, listed or inside a listed composite, by key.
    meshes: HashMap<String, Arc<Vec<u8>>>,
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

impl SelectionState {
    /// The listed selections following `entry` beyond its own changes: selections naming a
    /// value `gone` holds are pruned, and a selection naming a value paints in that value's
    /// record colour, from `records`, when the selection is new to the list or the entry
    /// changes the record.
    pub(super) fn follow(
        &self,
        entry: &Entry,
        gone: &HashSet<(String, String)>,
        records: &HashMap<String, Tracked<HashMap<Id<ValueRecord>, ValueRecord>>>,
    ) -> Change<(String, Listing)> {
        let pruned = if gone.is_empty() {
            entry.selections.clone()
        } else {
            self.change(&entry.selections, |rows| {
                rows.into_iter()
                    .filter(|row| !names_emptied(gone, row))
                    .collect()
            })
        };
        let changed: HashMap<(&str, Id<ValueRecord>), Rgb> = entry
            .records
            .iter()
            .flat_map(|(field, pile)| {
                pile.after()
                    .filter_map(move |(id, rec)| Some(((field.as_str(), *id), rec.shown_color()?)))
            })
            .collect();
        let listed = self.table();
        let is_new = |key: &str| !listed.contains_key(key);
        if changed.is_empty() && !pruned.after().any(|(key, _)| is_new(key)) {
            return pruned;
        }
        self.change(&pruned, |rows| {
            rows.into_iter()
                .map(|row| {
                    let new = is_new(&row.selection.key);
                    let color = |field: &str, id: u32| {
                        let id = Id::new(id);
                        changed.get(&(field, id)).copied().or_else(|| {
                            new.then(|| records.get(field)?.get(&id)?.shown_color())
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
}

impl Store {
    /// `rows` projected onto every indexed field, missing indexes built first from the rows
    /// as they stand. The one projection the emptied test and the reindex both consume.
    pub(super) fn field_projections(
        &mut self,
        rows: &Change<Location>,
    ) -> HashMap<String, selections::Projection> {
        let indexes: Vec<_> = self
            .registry()
            .iter()
            .filter(|(_, def)| def.builtin.is_some())
            .map(|(key, _)| selections::Index::Values(key.to_string()))
            .chain(
                self.registry()
                    .interned()
                    .map(|f| selections::Index::Presence(f.to_string())),
            )
            .collect();
        self.prepare(indexes);
        self.field_indexes
            .iter()
            .map(|(field, index)| (field.clone(), index.project(field, rows)))
            .collect()
    }

    /// Recompute selection membership and per-node counts. Render bitmasks are built separately.
    pub(crate) fn resolve_selection_membership(&mut self) {
        #[cfg(test)]
        tests::RESOLVES.with(|n| n.set(n.get() + 1));
        self.selections.unresolved = self
            .selections
            .resolved
            .iter()
            .map(|r| r.sel.key.clone())
            .collect();
        self.resolve_unresolved_selections();
    }

    /// Resolve only the listed selections a list edit added or changed. The rest keep their
    /// members, which no list edit can move unless a listed selection reads the selection.
    pub(crate) fn resolve_unresolved_selections(&mut self) {
        let sels: Vec<Selection> = self
            .selections
            .resolved
            .iter()
            .filter(|r| self.selections.unresolved.contains(&r.sel.key))
            .map(|r| r.sel.clone())
            .collect();
        let (sets, node_counts) = self.resolve_forest(&sels);
        self.selections
            .resolve(sels.into_iter().zip(sets), node_counts);
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

impl SelectionState {
    /// Bring the meshes in step with the list: mesh every polygon new to it, in parallel,
    /// and forget the ones it lost. Returns what changed.
    pub(crate) fn mesh_change(&mut self) -> PolygonFrame {
        fn polygons<'a>(sel: &'a Selection, out: &mut HashMap<&'a str, &'a PolygonGeometry>) {
            if let Selector::Polygon { polygon } = &sel.selector {
                out.insert(&sel.key, polygon);
            }
            for child in sel.selector.children() {
                polygons(child, out);
            }
        }
        let mut listed = HashMap::new();
        for root in &self.resolved {
            polygons(&root.sel, &mut listed);
        }
        let removed: Vec<String> = self
            .meshes
            .keys()
            .filter(|key| !listed.contains_key(key.as_str()))
            .cloned()
            .collect();
        for key in &removed {
            self.meshes.remove(key);
        }
        let added: Vec<(String, Arc<Vec<u8>>)> = listed
            .into_iter()
            .filter(|(key, _)| !self.meshes.contains_key(*key))
            .collect::<Vec<_>>()
            .into_par_iter()
            .map(|(key, polygon)| (key.to_string(), Arc::new(polygon_mesh(polygon))))
            .collect();
        self.meshes.extend(added.iter().cloned());
        PolygonFrame { added, removed }
    }

    /// Every mesh, for a frame that draws the scene from nothing.
    pub(crate) fn all_meshes(&self) -> PolygonFrame {
        PolygonFrame {
            added: self
                .meshes
                .iter()
                .map(|(k, m)| (k.clone(), m.clone()))
                .collect(),
            removed: Vec::new(),
        }
    }

    /// The whole list as rows by key and keys in order, which it now counts as sent.
    pub(crate) fn ship_list(&mut self) -> (HashMap<String, ListedSelection>, Vec<String>) {
        self.sent = self.list();
        let rows = self
            .sent
            .iter()
            .map(|row| (row.selection.key.clone(), row.clone()))
            .collect();
        let order = self
            .sent
            .iter()
            .map(|row| row.selection.key.clone())
            .collect();
        (rows, order)
    }

    /// How the list moved since it was last sent, as patch operations, which it now counts
    /// as sent.
    pub(crate) fn list_patch(&mut self) -> Vec<PatchOp> {
        let list = self.list();
        let key = |row: &ListedSelection| row.selection.key.clone();
        let sent: HashMap<&str, &ListedSelection> = self
            .sent
            .iter()
            .map(|row| (row.selection.key.as_str(), row))
            .collect();
        let listed: HashSet<&str> = list.iter().map(|row| row.selection.key.as_str()).collect();
        let mut patch: Vec<PatchOp> = list
            .iter()
            .filter(|row| sent.get(row.selection.key.as_str()) != Some(row))
            .map(|row| PatchOp::add(["selectionRows", row.selection.key.as_str()], row))
            .chain(
                sent.keys()
                    .filter(|gone| !listed.contains(*gone))
                    .map(|gone| PatchOp::remove(["selectionRows", gone])),
            )
            .collect();
        if !list.iter().map(key).eq(self.sent.iter().map(key)) {
            patch.push(PatchOp::replace(
                ["selectionOrder"],
                list.iter().map(key).collect::<Vec<_>>(),
            ));
        }
        self.sent = list;
        patch
    }

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
            .zip(self.list())
            .map(|(root, row)| {
                (
                    row.selection.key.clone(),
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
        pending: &Change<(String, Listing)>,
        edit: impl FnOnce(Vec<ListedSelection>) -> Vec<ListedSelection>,
    ) -> Change<(String, Listing)> {
        let before = self.table();
        let mut held = before.clone();
        pending.apply_to(&mut held);
        let after: HashMap<String, Listing> = edit(listed_rows(held))
            .into_iter()
            .zip(0..)
            .map(|(row, order)| (row.selection.key.clone(), Listing { order, row }))
            .collect();
        Change::between(&before, &after)
    }

    /// Apply a list edit. A selection still listed with the same selector keeps its members;
    /// every other one waits to be resolved. A key alone does not name a selector: a manual
    /// selection keeps its key while its locations change.
    pub(crate) fn apply(&mut self, change: &Change<(String, Listing)>) {
        let mut table = self.table();
        change.apply_to(&mut table);
        let rows = in_order(table);
        self.set_dependent = rows
            .iter()
            .any(|listing| !listing.row.selection.selector.row_local());
        let mut held: HashMap<String, (Selector, IdSet<Location>)> = self
            .resolved
            .drain(..)
            .filter(|r| !self.unresolved.contains(&r.sel.key))
            .map(|r| (r.sel.key, (r.sel.selector, r.set)))
            .collect();
        self.unresolved.clear();
        self.resolved = rows
            .into_iter()
            .map(|Listing { order, row }| {
                let set = held
                    .remove(&row.selection.key)
                    .filter(|(selector, _)| *selector == row.selection.selector)
                    .map(|(_, set)| set)
                    .unwrap_or_else(|| {
                        self.unresolved.insert(row.selection.key.clone());
                        IdSet::new()
                    });
                ResolvedSelection {
                    sel: row.selection,
                    order,
                    ghosted: row.ghosted,
                    set,
                }
            })
            .collect();
    }

    /// Take the members resolved for `sets`' selections and the counts of their nodes,
    /// dropping the counts of nodes no longer listed.
    pub(crate) fn resolve(
        &mut self,
        sets: impl IntoIterator<Item = (Selection, IdSet<Location>)>,
        counts: HashMap<String, u32>,
    ) {
        let mut sets: HashMap<String, IdSet<Location>> =
            sets.into_iter().map(|(sel, set)| (sel.key, set)).collect();
        for root in &mut self.resolved {
            if let Some(set) = sets.remove(&root.sel.key) {
                root.set = set;
            }
        }
        let mut listed = HashSet::new();
        for root in &self.resolved {
            root.sel.fold(&mut |node, _: Vec<()>| {
                listed.insert(node.key.clone());
            });
        }
        self.node_counts.retain(|key, _| listed.contains(key));
        self.node_counts.extend(counts);
        self.unresolved.clear();
        self.ids = self.live().fold(IdSet::new(), |acc, r| acc | &r.set);
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
                    let delta = changes
                        .count_by(|row| {
                            selections::RowRef::from_loc(row)
                                .matches(&node.selector)
                                .then_some(())
                        })
                        .remove(&())
                        .unwrap_or(0);
                    let count = self.node_counts.entry(node.key.clone()).or_default();
                    *count = (*count as i64 + delta).max(0) as u32;
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
        let gone = {
            let projections = self.field_projections(&Change::default());
            self.fields().interned().absent_after(&projections, named)
        };
        table
            .into_iter()
            .filter(|(_, listing)| !names_emptied(&gone, &listing.row))
            .collect()
    }
}

impl Write for SelectionOp {
    type Done = Mutation<ListedSelection>;

    /// The selection list is this device's own, never sent to a host.
    fn route(self, store: &Store) -> Routed {
        let rows = self.apply(&store.selections.list());
        Routed::Here(Entry {
            selections: store.selections.change(&Change::default(), |_| rows),
            ..Entry::default()
        })
    }

    fn done(edited: EditResult) -> Mutation<ListedSelection> {
        Mutation {
            version: edited.mutation.version,
            keys: Vec::new(),
        }
    }
}
