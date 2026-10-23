//! Location mutations as the engine applies them: adds, patches, field-wide ops, and the `Mutation` they report.

use super::*;
use crate::runs;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::neighborhood::coord_key;
use crate::selections::{self, tree};
use crate::selections::{FieldRegistry, FieldWriter, Selector};
use crate::store::maps;
use crate::types::{wire_str_enum, AppError, AppResult, Location, RawExtra};
use crate::util;
use mma_algebra::{
    number_value, same_field_value, Change, Counts, Delta, Edit, Id, Keys, Layer, Op, Patch,
    PatchOp, Patchable,
};
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};
use std::slice;

/// The derived state a window holds: everything about the open map besides its rows. Opening a
/// map sends it whole; every change after sends a JSON Patch over it.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub location_count: usize,
    /// Location changes since the last commit.
    pub pending: Counts,
    /// The map's own details.
    pub map: maps::MapDetails,
    pub history: HashMap<Timeline, History>,
    /// Every held value, keyed by field and value.
    pub field_values: HashMap<String, HashMap<String, HeldValue>>,
    /// The extra-field registry.
    pub field_defs: HashMap<String, maps::FieldDef>,
    /// Resolved count per selection node, keyed by `Selection.key` (top-level and nested).
    pub selection_counts: HashMap<String, u32>,
    /// The listed selections, keyed by `Selection.key`.
    pub selection_rows: HashMap<String, ListedSelection>,
    /// The keys of the listed selections, in list order.
    pub selection_order: Vec<String>,
    /// Pending layers that procedure work is currently writing to.
    pub writing_layers: BTreeSet<String>,
    /// Whether the map has changes not yet saved to disk.
    pub unsaved: bool,
}

/// Whether undo and redo are available.
#[derive(
    serde::Serialize, serde::Deserialize, Clone, Copy, Default, Debug, PartialEq, specta::Type,
)]
pub struct History {
    /// An edit can be undone.
    pub undo: bool,
    /// An undone edit can be redone.
    pub redo: bool,
}

/// One value of a field as the map holds it.
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq, specta::Type)]
pub struct HeldValue {
    /// Optional metadata for an interned value.
    #[specta(type = Option<HashMap<String, specta_typescript::Unknown>>)]
    pub record: Option<ValueRecord>,
    /// How many locations hold the value.
    pub count: usize,
}

/// The version a write reached and the keys it assigned. Other updates arrive on the change feed.
#[derive(serde::Serialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Mutation<_T = Location> {
    /// The map version this change brought the map to.
    pub version: u64,
    /// The key the store gave each keyless set, in the order they were written.
    pub keys: Vec<Id<_T>>,
    #[serde(skip)]
    pub(crate) history_cleared: bool,
}

/// What a location edit did.
#[derive(serde::Serialize, Default, specta::Type)]
pub struct EditResult {
    /// The version the edit reached and the keys it assigned.
    pub mutation: Mutation,
    /// Derived fields the edit cleared because a field they are computed from changed.
    pub invalidated: Vec<String>,
    #[serde(skip)]
    pub(crate) records: Vec<Id<ValueRecord>>,
    /// How many locations a work changed.
    #[serde(skip)]
    pub(crate) changed: u32,
    /// The locations a work could not work out a value for.
    #[serde(skip)]
    pub(crate) failed: Vec<Id<Location>>,
}

/// A map change broadcast to subscribers, with the keys it changed and derived state.
#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    /// The map version this change brought the map to.
    pub version: u64,
    /// The change itself, by key.
    #[serde(flatten)]
    pub keys: Keys<Id<Location>>,
    /// How the derived state moved, as a JSON Patch over what the window holds.
    pub patch: Vec<PatchOp>,
    #[serde(skip)]
    pub(crate) finished: Option<Finished>,
}

/// Read or edit map rows directly, or through a named pending layer.
#[derive(serde::Deserialize, serde::Serialize, specta::Type, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// A map's rows.
    Map {
        /// The map, or this window's map when null.
        #[serde(default)]
        #[specta(optional)]
        id: Option<Id<MapMeta, String>>,
    },
    /// A pending layer, created on first use. Reads include current underlying map data;
    /// edits reach the map when the layer lands.
    Pending { name: String },
}

/// A named layer of pending edits and where it is in its lifecycle.
#[derive(Default)]
pub(crate) struct Pending {
    pub(crate) layer: Layer<Location>,
    records: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    pub(crate) stage: Stage,
}

/// Where a pending layer is in its lifecycle: open, then landed or discarded, and closed.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Stage {
    /// Edits are held in the layer until it lands.
    #[default]
    Open,
    /// The layer landed. Later edits write through.
    Landed(Joins),
    /// The layer landed and its owner closed it; it stays while procedures still write to it.
    Closing(Joins),
    /// Its owner closed the layer before it landed; its edits never reach the map.
    Discarded,
}

/// The undo step a landed layer's later edits join.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Joins {
    /// This step, while it is the newest.
    Step(u64),
    /// No step was recorded yet, so the next edit starts one.
    NewStep,
}

impl From<&Recording> for Joins {
    fn from(recording: &Recording) -> Self {
        match recording {
            Recording::Step(Some(join)) => Joins::Step(*join),
            _ => Joins::NewStep,
        }
    }
}

impl Stage {
    /// What later edits join, when the layer has landed.
    pub(crate) fn landed(self) -> Option<Joins> {
        match self {
            Stage::Landed(joins) | Stage::Closing(joins) => Some(joins),
            Stage::Open | Stage::Discarded => None,
        }
    }

    /// Whether the owner closed the layer.
    pub(crate) fn closed(self) -> bool {
        matches!(self, Stage::Closing(_) | Stage::Discarded)
    }
}

/// What the store has to warn the user about.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[tauri_specta(event_name = "store-warning")]
pub enum StoreWarning {
    /// The uncommitted delta was unreadable; the map opened from its last commit.
    DeltaSetAside,
}

impl Targeted<'_> {
    /// Hold `edits` in this open layer until it lands, each field's records replacing what
    /// the layer held for that field.
    pub(super) fn hold(
        &mut self,
        edits: Vec<Edit<Location>>,
        records: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    ) -> AppResult<EditResult> {
        let name = self.layer.expect("only a layer holds edits");
        let store = &mut *self.store;
        let (edits, keys) = store.next_id.key_all(created(edits))?;
        let pending = store.pending.entry(name.to_string()).or_default();
        let mut layer = mem::take(&mut pending.layer);
        let mut invalidated = BTreeSet::new();
        for edit in edits {
            if let Op::Put(patch) = &edit {
                if let Some(row) = store.through(&layer, patch.id) {
                    invalidated.extend(store.applied(&row, patch).1);
                }
            }
            layer.write([edit]);
        }
        let pending = store.pending.entry(name.to_string()).or_default();
        pending.layer = layer;
        pending.records.extend(records);
        let held = EditResult {
            mutation: store.held(keys),
            invalidated: invalidated.into_iter().collect(),
            ..EditResult::default()
        };
        store.settle_layers();
        Ok(held)
    }
}

impl Write for Vec<Edit<Location>> {
    type Done = EditResult;

    fn route(self, _: &Store) -> Routed {
        Routed::Shared(Intent::Edit {
            edits: self,
            records: HashMap::new(),
        })
    }

    fn done(edited: EditResult) -> EditResult {
        edited
    }
}

impl Write for Entry {
    type Done = Mutation;

    /// A whole change as another store made it applies here: rows keep their stamps, and the
    /// selection list and the map's device-local details stay this store's own.
    fn route(self, _: &Store) -> Routed {
        Routed::Here(self.shared())
    }

    fn done(edited: EditResult) -> Mutation {
        edited.mutation
    }
}

impl Entry {
    /// What this change shares with another store of its map: everything but the map's
    /// device-local details and the selection list.
    pub(crate) fn shared(mut self) -> Self {
        for (old, new) in &mut self.meta.updated {
            let mut shared = MapMeta::between(old, new);
            shared.take_local();
            *new = old.patched(&shared);
        }
        self.meta.updated.retain(|(old, new)| old != new);
        self.selections = Change::default();
        self
    }
}

impl Store {
    /// `around` with the rows `layer` writes, each changed row stamped modified, and field
    /// definitions inferred for extra keys no definition names.
    pub(crate) fn entry(&mut self, layer: &Layer<Location>, around: Entry) -> Entry {
        let locations = layer
            .resolve(
                |id| self.get_loc_by_id(id),
                |old, patch| self.applied(old, patch).0,
            )
            .map(|mut row| {
                if let (Some(before), Some(after)) = (&row.before, &mut row.after) {
                    if after != before {
                        after.touch();
                    }
                }
                row
            })
            .collect();
        let mut entry = Entry {
            locations,
            ..around
        };
        let mut fields = (*self.field_defs).clone();
        entry.defs.apply_to(&mut fields);
        let extras: Vec<&RawExtra> = entry
            .locations
            .after()
            .filter_map(|row| row.extra.as_ref())
            .collect();
        if let Some(inferred) = maps::infer_field_defs(|key| fields.contains_key(key), &extras) {
            fields.extend(inferred);
        }
        entry.defs = Change::between(&*self.field_defs, &fields);
        entry
    }

    /// The records an unlanded layer holds for `field`.
    pub(crate) fn held_records(
        &self,
        name: &str,
        field: &str,
    ) -> HashMap<Id<ValueRecord>, ValueRecord> {
        self.pending
            .get(name)
            .and_then(|pending| pending.records.get(field))
            .cloned()
            .unwrap_or_default()
    }

    /// `layer` with the incoming records its rows reference matched to the map's by name and
    /// the references remapped to them, and what that did to the map's records. A field that
    /// brings no records keeps only the references the map holds a record for.
    pub(super) fn reconcile_incoming(
        &mut self,
        mut layer: Layer<Location>,
        mut incoming: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    ) -> (
        Layer<Location>,
        HashMap<String, Change<(Id<ValueRecord>, ValueRecord)>>,
    ) {
        let mut records = HashMap::new();
        let mut fields: BTreeSet<String> = self.registry().interned().map(str::to_string).collect();
        fields.extend(incoming.keys().cloned());
        for field in fields {
            let remap = match incoming.remove(&field).filter(|held| !held.is_empty()) {
                Some(held) => {
                    let floor = self.fields([field.as_str()])[0].floor();
                    let before = self.records(&field);
                    let mut after = before.clone();
                    let remap = reconcile_values_by_name(held.values(), &mut after, floor);
                    records.insert(
                        field.clone(),
                        Change::at(&before, &after, remap.values().copied()),
                    );
                    remap
                }
                None => self
                    .records
                    .get(&field)
                    .map(|held| held.keys().map(|&id| (id, id)).collect())
                    .unwrap_or_default(),
            };
            let registry = FieldRegistry::new(&self.field_defs);
            let to = registry
                .assign(&field)
                .expect("declared interned fields are writable");
            layer = layer.map_edits(|edit| remap_written(edit, &to, &remap));
        }
        (layer, records)
    }

    /// Remove closed layers nothing still writes to, then announce which layers are being
    /// written if that moved.
    pub(crate) fn settle_layers(&mut self) {
        let writing = runs::pending_writers(&self.meta.id);
        self.pending
            .retain(|name, pending| !pending.stage.closed() || writing.contains(name));
        if writing != *self.writing_layers {
            self.writing_layers.replace(writing);
        }
        self.announce();
    }

    /// Send subscribers the derived state that moved since it last shipped.
    pub(crate) fn announce(&mut self) {
        let patch = self.shipped();
        if !patch.is_empty() {
            self.changes.send(ChangeEvent {
                version: self.version,
                keys: Change::<Location>::default().keys(),
                patch,
                finished: None,
            });
        }
    }

    /// Close the layer. Unlanded work is cancelled; a landed layer stays until its writers finish.
    pub(crate) fn close_layer(&mut self, name: &str) {
        if let Some(pending) = self.pending.get_mut(name) {
            pending.stage = match pending.stage {
                Stage::Open => {
                    runs::cancel_pending_writers(&self.meta.id, name);
                    Stage::Discarded
                }
                Stage::Landed(joins) => Stage::Closing(joins),
                closed => closed,
            };
        }
        self.settle_layers();
    }
    /// Result for a staged edit that did not change the map, at version 0 so nothing waits on it.
    fn held(&self, keys: Vec<Id<Location>>) -> Mutation {
        Mutation {
            version: 0,
            keys,
            history_cleared: false,
        }
    }

    /// Apply row, value-record, and field-definition changes to the store. A change to the
    /// map's details that names field definitions moves them into `field_defs`.
    pub(crate) fn put_entry(&mut self, entry: &Entry) {
        let defs =
            (!entry.meta.is_empty() || !entry.defs.is_empty()).then(|| (*self.field_defs).clone());
        for (old, new) in &entry.meta.updated {
            let patch = MapMeta::between(old, new);
            let mut next = self.meta.patched(&patch);
            let extra = mem::take(&mut next.extra);
            if patch.extra.is_some() && extra.fields != *self.field_defs {
                self.field_defs.replace(extra.fields);
            }
            self.meta.replace(next);
        }
        if !entry.selections.is_empty() {
            self.selections.apply(&entry.selections);
        }
        if !entry.meta.is_empty() || !entry.records.is_empty() || !entry.defs.is_empty() {
            self.meta.edit().updated_at = util::now_iso();
        }
        self.put(&entry.locations);
        for (field, delta) in entry.records.iter().filter(|(_, d)| !d.is_empty()) {
            delta.apply_to(self.records.entry(field.clone()).or_default().edit());
        }
        if !entry.defs.is_empty() {
            entry.defs.apply_to(self.field_defs.edit());
        }
        if let Some(defs) = defs {
            let fields = &self.field_defs;
            self.field_indexes
                .retain(|key, _| defs.get(key) == fields.get(key));
        }
    }

    /// Apply row changes and move the spatial index with their coordinates.
    pub(crate) fn put(&mut self, change: &Change<Location>) {
        if change.is_empty() {
            return;
        }
        if self.spatial.peek().is_some() {
            for transition in change.transitions() {
                let before = transition
                    .before
                    .map(|row| (row.id, self.coords_of(row.id).unwrap_or((row.lat, row.lng))));
                let after = transition.after.map(|row| (row.id, (row.lat, row.lng)));
                if before == after {
                    continue;
                }
                if let Some(index) = self.spatial.if_built_mut() {
                    if let Some((id, (lat, lng))) = before {
                        if !index.remove(id.get(), lat, lng) {
                            log::warn!("[spatial] remove miss for id {}", id);
                        }
                    }
                    if let Some((id, (lat, lng))) = after {
                        index.insert(id.get(), lat, lng);
                    }
                }
            }
        }
        if change.added.len() != change.removed.len() {
            *self.alive_count.edit() =
                *self.alive_count + change.added.len() - change.removed.len();
        }
        self.overlay.edit().apply(change, self.batch.as_ref());
    }
}

wire_str_enum! {
    /// When a move target already holds a value, which side survives.
    derive(serde::Serialize, serde::Deserialize, specta::Type, Clone, Copy, Debug, PartialEq)
    pub enum MergeWinner {
        /// The moved value replaces what the target already holds.
        From = "from",
        /// The target keeps its own value and the moved value is dropped.
        To = "to",
    }
}

/// Operations over the selected locations.
#[derive(Debug, PartialEq, mma_fields::Json, specta::Type)]
#[serde(untagged)]
pub enum Work {
    Locations(LocationOp),
    Sets(SetOp),
}

/// Operations computed independently for each selected location.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocationOp {
    /// Rename `from` into `to`. Merge is the same operation -- rename is just the case
    /// where nothing holds `to` -- so `winner` decides only where a location holds both.
    Move {
        from: String,
        to: String,
        winner: MergeWinner,
    },
    /// Drop `keys` from every location that has them.
    Delete { keys: Vec<String> },
    /// Assign a value to a writable field on each location. Builtins update their stored
    /// fields; other keys update `extra`.
    Set {
        key: String,
        #[specta(type = specta_typescript::Unknown)]
        value: serde_json::Value,
    },
    /// Assign `key = expr(location)` per location. A location where the expression cannot evaluate (a
    /// missing or non-numeric field, a non-finite result) is reported back by id.
    Expr { key: String, expr: String },
    /// Add and remove list members. `add` wins if a value appears in both lists.
    /// Locations already in the requested state keep their member order.
    ListSet {
        key: String,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        add: Vec<serde_json::Value>,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        remove: Vec<serde_json::Value>,
    },
}

impl LocationOp {
    /// The op with its expression parsed and leave granted for every key it writes, so a
    /// key the op cannot write is rejected before any row reports a change.
    fn prepare<'o>(&'o self, fields: FieldRegistry<'_>) -> AppResult<Prepared<'o>> {
        Ok(match self {
            Self::Set { key, value } => {
                let to = fields.assign(key)?;
                if to.is_flag() {
                    selections::flag_assignment(key, value)?;
                }
                Prepared::Set { to, value }
            }
            Self::Expr { key, expr } => {
                let expr = field_expr::parse(expr)?;
                Prepared::Expr {
                    to: fields.assign(key)?,
                    expr,
                }
            }
            Self::ListSet { key, add, remove } => Prepared::ListSet {
                to: fields.assign(key)?,
                add,
                remove,
            },
            Self::Delete { keys } => Prepared::Delete {
                keys: keys
                    .iter()
                    .map(|key| fields.clear(key))
                    .collect::<AppResult<_>>()?,
            },
            Self::Move { from, to, winner } => Prepared::Move {
                from: fields.clear(from)?,
                to: fields.assign(to)?,
                winner: *winner,
            },
        })
    }
}

/// A [`LocationOp`] ready to run: each key it writes holds its writer.
enum Prepared<'o> {
    Set {
        to: FieldWriter<'o>,
        value: &'o serde_json::Value,
    },
    Expr {
        to: FieldWriter<'o>,
        expr: Expr,
    },
    Move {
        from: FieldWriter<'o>,
        to: FieldWriter<'o>,
        winner: MergeWinner,
    },
    Delete {
        keys: Vec<FieldWriter<'o>>,
    },
    ListSet {
        to: FieldWriter<'o>,
        add: &'o [serde_json::Value],
        remove: &'o [serde_json::Value],
    },
}

/// Operations computed over the selected locations as a group.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetOp {
    /// Merge each group into its best-scored location, which keeps its id and takes in the
    /// others' list values and extra fields.
    Merge {
        groups: Vec<Vec<Id<Location>>>,
        score: Option<String>,
    },
    /// Remove duplicates within `distance` metres of each other, keeping the best-scored
    /// survivor per cluster.
    PruneDuplicates {
        distance: f64,
        score: Option<String>,
    },
}

/// Membership test that agrees with [`same_field_value`] on numbers, so an id written as
/// `1` and one arriving as `1.0` are the same member.
fn contains_value(haystack: &[serde_json::Value], needle: &serde_json::Value) -> bool {
    haystack
        .iter()
        .any(|v| same_field_value(Some(v), Some(needle)))
}

/// The mutation and operation-specific results.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkResult {
    pub mutation: Mutation,
    /// Locations the work edited.
    pub changed: u32,
    /// Locations an expression could not evaluate.
    pub failed: Vec<Id<Location>>,
}

/// `edit` with the incoming ids it writes to `to`'s field replaced by their map ids.
/// An edit that writes no ids there, including a patch that leaves the field alone, is unchanged.
fn remap_written(
    edit: Edit<Location>,
    to: &FieldWriter<'_>,
    remap: &HashMap<Id<ValueRecord>, Id<ValueRecord>>,
) -> Edit<Location> {
    let written = |row: &Location| {
        let ids = held_ids(&selections::RowRef::from_loc(row), to.key());
        let mapped: Vec<Id<ValueRecord>> =
            ids.iter().filter_map(|id| remap.get(id).copied()).collect();
        (mapped != ids)
            .then(|| serde_json::Value::Array(mapped.iter().map(|id| id.get().into()).collect()))
    };
    let write = |patch: &mut Patch<Location>, row: &Location, ids: &serde_json::Value| {
        to.write(patch, row.flags, ids)
            .expect("declared interned fields hold id lists");
    };
    match edit {
        Op::Set(row) => match written(&row) {
            Some(ids) => {
                let mut patch = Patch::<Location>::of(row.id);
                write(&mut patch, &row, &ids);
                Op::Set(row.patched(&patch))
            }
            None => Op::Set(row),
        },
        Op::Put(mut patch) => {
            let probe = Location::default().patched(&patch);
            if let Some(ids) = written(&probe) {
                write(&mut patch, &probe, &ids);
            }
            Op::Put(patch)
        }
        remove => remove,
    }
}

impl Targeted<'_> {
    /// Land this pending layer's edits on the map as one undo step. A layer lands once:
    /// landing it again, after it was discarded, or when no such layer exists changes nothing.
    pub(crate) fn land(&mut self) -> Reached<Mutation> {
        let store = &mut *self.store;
        let Some(pending) = self
            .layer
            .and_then(|name| store.pending.get_mut(name))
            .filter(|p| p.stage == Stage::Open)
        else {
            return Reached::ready(Ok(store.held(Vec::new())));
        };
        let landing = Intent::Edit {
            edits: mem::take(&mut pending.layer).into_edits().collect(),
            records: mem::take(&mut pending.records),
        };
        pending.stage = Stage::Landed(Joins::NewStep);
        self.write(landing).map(|edited| edited.mutation)
    }
}

impl Scoped<'_, '_> {
    /// Do `work` on the rows this scope matches. An open layer holds its edits; else the map
    /// plans it against its own rows, through its host when it has one.
    pub(crate) fn write(self, work: Work) -> Reached<WorkResult> {
        let Scoped { at, selector, .. } = self;
        if !at.held() {
            let selector = selector.clone();
            return at
                .write(Intent::Work { selector, work })
                .map(WorkResult::from);
        }
        let (edits, failed) = match work.plan(at, selector) {
            Ok(planned) => planned,
            Err(error) => return Reached::ready(Err(error)),
        };
        let changed = edits.len() as u32;
        at.write(edits).map(move |edited| WorkResult {
            mutation: edited.mutation,
            changed,
            failed,
        })
    }
}

impl From<EditResult> for WorkResult {
    fn from(edited: EditResult) -> Self {
        WorkResult {
            mutation: edited.mutation,
            changed: edited.changed,
            failed: edited.failed,
        }
    }
}

impl Work {
    /// The edits this work makes on the rows `selector` matches where `at` points, and the
    /// locations it could not work out a value for.
    fn plan(
        &self,
        at: &mut Targeted<'_>,
        selector: &Selector,
    ) -> AppResult<(Vec<Edit<Location>>, Vec<Id<Location>>)> {
        match self {
            Work::Locations(op) => op.plan(at, selector),
            Work::Sets(op) => Ok((op.plan(at, selector)?, Vec::new())),
        }
    }

    /// The change this work comes to on `store`'s map, and what it did. Field definitions and listed selections follow a location op's edits:
    /// after a move or delete, a new key inherits its source's definition and a key no row
    /// holds any more loses its own.
    pub(super) fn change(
        self,
        store: &mut Store,
        selector: &Selector,
    ) -> AppResult<(Entry, EditResult)> {
        let map = Target::Map { id: None };
        let (edits, failed) = self.plan(&mut store.at(&map), selector)?;
        let worked = EditResult {
            changed: edits.len() as u32,
            failed,
            ..EditResult::default()
        };
        let Work::Locations(op) = self else {
            let edits = Intent::Edit {
                edits,
                records: HashMap::new(),
            };
            return Ok((edits.change(store)?.0, worked));
        };
        let (vacated, into) = match &op {
            LocationOp::Move { from, to, .. } if from != to && !to.is_empty() => {
                (slice::from_ref(from), Some(to))
            }
            LocationOp::Delete { keys } => (keys.as_slice(), None),
            _ => (&[][..], None),
        };
        let edited: HashSet<Id<Location>> = edits
            .iter()
            .filter_map(|edit| match edit {
                Op::Put(patch) => Some(patch.id),
                _ => None,
            })
            .collect();
        let landing = Intent::Edit {
            edits,
            records: HashMap::new(),
        };
        let (mut entry, _) = landing.change(store)?;
        let before = &*store.field_defs;
        let mut after = before.clone();
        entry.defs.apply_to(&mut after);
        if let (Some(to), Some(def)) = (into, vacated.first().and_then(|key| before.get(key))) {
            if !before.contains_key(to) {
                after.insert(to.clone(), def.clone());
            }
        }
        for key in vacated.iter().filter(|key| before.contains_key(*key)) {
            let held = store
                .all()
                .rows()
                .any(|row| !edited.contains(&row.id()) && row.resolve_field(key).is_some());
            if !held {
                after.remove(key);
            }
        }
        entry.defs = Change::between(before, &after);
        entry.selections = store.selections.change(&Change::default(), |mut rows| {
            for (field, _) in &entry.defs.removed {
                let to = match &op {
                    LocationOp::Move { from, to, .. } if from == field => Some(to.as_str()),
                    _ => None,
                };
                rows = rows
                    .into_iter()
                    .filter_map(|row| {
                        Some(ListedSelection {
                            selection: tree::rewrite(&row.selection, field, to)?,
                            ..row
                        })
                    })
                    .collect();
            }
            rows
        });
        Ok((entry, worked))
    }
}

impl LocationOp {
    /// The edits this op makes on each row `selector` matches where `at` points, and the
    /// locations its expression could not evaluate.
    fn plan(
        &self,
        at: &mut Targeted<'_>,
        selector: &Selector,
    ) -> AppResult<(Vec<Edit<Location>>, Vec<Id<Location>>)> {
        let fields = (*at.store.field_defs).clone();
        at.scope(selector).read(|scope| {
            if let LocationOp::Move { from, to, .. } = self {
                if from == to || to.is_empty() {
                    return Ok((Vec::new(), Vec::new()));
                }
            }
            let op = self.prepare(FieldRegistry::new(&fields))?;
            let (mut edits, mut failed) = (Vec::new(), Vec::new());
            for row in scope.rows() {
                let id = row.id();
                let mut writes: Vec<(FieldWriter<'_>, serde_json::Value)> = Vec::new();
                match &op {
                    Prepared::Set { to, value } => {
                        if !same_field_value(row.resolve_field(to.key()).as_ref(), Some(value)) {
                            writes.push((*to, (*value).clone()));
                        }
                    }
                    Prepared::Expr { to, expr } => {
                        let field = |name: &str| row.resolve_field(name);
                        let value = field_expr::eval(expr, &field).and_then(|v| match v {
                            _ if !to.is_flag() => Some(number_value(v)),
                            0.0 => Some(serde_json::Value::Bool(false)),
                            1.0 => Some(serde_json::Value::Bool(true)),
                            _ => None,
                        });
                        match value {
                            None => failed.push(id),
                            Some(value) => {
                                if !same_field_value(
                                    row.resolve_field(to.key()).as_ref(),
                                    Some(&value),
                                ) {
                                    writes.push((*to, value));
                                }
                            }
                        }
                    }
                    Prepared::Move { from, to, winner } => {
                        if let Some(value) = row.resolve_field(from.key()) {
                            writes.push((*from, serde_json::Value::Null));
                            // Winner decides only where the row already holds `to`.
                            if *winner == MergeWinner::From || row.resolve_field(to.key()).is_none()
                            {
                                writes.push((*to, value));
                            }
                        }
                    }
                    Prepared::Delete { keys } => {
                        for key in keys {
                            if row.resolve_field(key.key()).is_some() {
                                writes.push((*key, serde_json::Value::Null));
                            }
                        }
                    }
                    Prepared::ListSet { to, add, remove } => {
                        let current = match row.resolve_field(to.key()) {
                            Some(serde_json::Value::Array(a)) => a,
                            Some(v) => vec![v],
                            None => Vec::new(),
                        };
                        let mut next: Vec<serde_json::Value> = current
                            .iter()
                            .filter(|v| !contains_value(remove, v) || contains_value(add, v))
                            .cloned()
                            .collect();
                        for v in *add {
                            if !contains_value(&next, v) {
                                next.push(v.clone());
                            }
                        }
                        if next != current {
                            // A builtin column is non-null, so an emptied list is `[]`. An
                            // emptied `extra` key carries nothing, so it is deleted instead.
                            writes.push((
                                *to,
                                if next.is_empty() && to.is_extra() {
                                    serde_json::Value::Null
                                } else {
                                    serde_json::Value::Array(next)
                                },
                            ));
                        }
                    }
                }
                if writes.is_empty() {
                    continue;
                }
                let mut patch = Patch::<Location>::of(id);
                for (to, value) in &writes {
                    to.write(&mut patch, row.flags(), value)?;
                }
                edits.push(Op::Put(patch));
            }
            Ok((edits, failed))
        })
    }
}

impl SetOp {
    /// The edits this op makes on the rows `selector` matches where `at` points, as a whole.
    fn plan(&self, at: &mut Targeted<'_>, selector: &Selector) -> AppResult<Vec<Edit<Location>>> {
        match self {
            SetOp::Merge { groups, score } => selections::parse_duplicate_score(score.as_deref())
                .and_then(|score| {
                    let allowed = at.scope(selector).read(|scope| scope.ids());
                    let mut seen = HashSet::new();
                    let mut edits = Vec::new();
                    for group in groups {
                        let ids: BTreeSet<Id<Location>> = group
                            .iter()
                            .copied()
                            .filter(|id| allowed.contains(*id))
                            .collect();
                        if ids.iter().any(|id| !seen.insert(*id)) {
                            return Err(AppError::from("merge groups must be disjoint"));
                        }
                        let members: Vec<Location> =
                            ids.into_iter().filter_map(|id| at.get(id)).collect();
                        if members.len() < 2 {
                            continue;
                        }
                        let survivor = merge_group(at.store.registry(), &members, &score);
                        edits.extend(
                            members
                                .iter()
                                .filter(|m| m.id != survivor.id)
                                .map(|m| Op::Remove(m.id)),
                        );
                        edits.push(Op::Set(survivor));
                    }
                    Ok(edits)
                }),
            SetOp::PruneDuplicates { distance, score } => {
                selections::parse_duplicate_score(score.as_deref()).map(|score| {
                    selections::prune_duplicates(&at.rows(selector), *distance, &score)
                        .into_iter()
                        .map(Op::Remove)
                        .collect()
                })
            }
        }
    }
}

/// `edits` with each added row created now.
pub(super) fn created(
    edits: impl IntoIterator<Item = Edit<Location>>,
) -> impl Iterator<Item = Edit<Location>> {
    let now = util::now_unix();
    edits.into_iter().map(move |edit| match edit {
        Op::Add(row) => Op::Add(row.created(now)),
        edit => edit,
    })
}

/// Result of copying locations to another map.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyToMapResult {
    pub copied: u32,
    pub skipped: u32,
}

/// A map's rows as the duplicate rule sees them: a location is held when a row has its
/// non-empty pano id, or, for a location without one, its exact coordinates. Fuzzy spatial
/// matching stays the job of the in-map Duplicates selection.
pub(crate) struct HeldRows {
    panos: HashSet<String>,
    coords: HashSet<(u64, u64)>,
}

impl HeldRows {
    pub(crate) fn of(rows: &[Location]) -> Self {
        Self {
            panos: rows
                .iter()
                .filter_map(|row| row.pano_id.as_deref().filter(|p| !p.is_empty()))
                .map(str::to_string)
                .collect(),
            coords: rows.iter().map(|row| coord_key(row.lat, row.lng)).collect(),
        }
    }

    pub(crate) fn holds(&self, row: &Location) -> bool {
        match &row.pano_id {
            Some(p) if !p.is_empty() => self.panos.contains(p.as_str()),
            _ => self.coords.contains(&coord_key(row.lat, row.lng)),
        }
    }
}

/// Merge a non-empty duplicate group into its best-scored survivor.
/// Union interned lists and merge `extra`, with the survivor winning conflicts.
/// Keep the survivor's id and other fields.
pub(crate) fn merge_group(
    fields: FieldRegistry<'_>,
    members: &[Location],
    score: &Expr,
) -> Location {
    let survivor = members
        .iter()
        .max_by(|a, b| selections::better(a, b, score))
        .expect("merge_group requires a non-empty group");

    // Non-survivors in id order first, survivor last so its values win conflicts.
    let mut others: Vec<&Location> = members.iter().filter(|m| m.id != survivor.id).collect();
    others.sort_by_key(|m| m.id);
    let extra = others
        .into_iter()
        .chain([survivor])
        .filter(|m| m.extra.is_some())
        .fold(None, |held, m| held.patched(&m.extra.to_patch()));

    let mut new_survivor = survivor.clone();
    for key in fields.interned() {
        if fields.get(key).map(maps::FieldDef::index_shape) != Some(maps::IndexShape::Multi) {
            continue;
        }
        let values: BTreeSet<Id<Location>> = members
            .iter()
            .flat_map(|row| {
                selections::RowRef::from_loc(row)
                    .resolve_field(key)
                    .into_iter()
                    .flat_map(|value| selections::index_keys(maps::IndexShape::Multi, &value))
                    .filter_map(|key| key.parse::<u32>().ok().map(Id::new))
            })
            .collect();
        let mut patch = Patch::<Location>::of(new_survivor.id);
        fields
            .assign(key)
            .and_then(|to| to.write(&mut patch, new_survivor.flags, &serde_json::json!(values)))
            .expect("interned list values satisfy their field's rules");
        new_survivor = new_survivor.patched(&patch);
    }
    new_survivor.extra = extra;
    new_survivor
}
