//! Location mutations as the engine applies them: adds, patches, field-wide ops, and the `Mutation` they report.

use super::*;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::neighborhood::coord_key;
use crate::selections::{self, Selector};
use crate::selections::{FieldRegistry, FieldWriter};
use crate::store::maps;
use crate::types::{wire_str_enum, AppError, AppResult, Location, RawExtra};
use mma_algebra::{
    number_value, same_field_value, Counts, Delta, Edit, Id, Ids, Keys, Layer, Op, Patch, Patchable,
};
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// A reversible row change shared by rendering, indexes, selections, and undo.
pub type Change = mma_algebra::Change<Location>;

/// Map state a change affected. Each field is `null` when it did not change.
// The open-time form (`super::StoreStatus`) has every field present. The JS mirror's type
// and merge are derived from this struct.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub location_count: Option<usize>,
    /// Location changes since the last commit.
    pub pending: Option<Counts>,
    /// The map's own details, when they changed.
    pub meta: Option<maps::MapDetails>,
    pub history: Option<HashMap<Timeline, History>>,
    /// Changed values, keyed by field and value. Null removes a value with no record or locations.
    pub field_values: Option<HashMap<String, HashMap<String, Option<HeldValue>>>>,
    /// The whole extra-field registry, when it changed.
    pub field_defs: Option<HashMap<String, maps::FieldDef>>,
    /// Resolved count per selection node, keyed by `Selection.key` (top-level and nested).
    pub selection_counts: Option<HashMap<String, u32>>,
    /// The listed selections, when the list changed.
    pub selection_list: Option<Vec<ListedSelection>>,
    /// Pending layers that procedure work is currently writing to.
    pub writing_layers: Option<BTreeSet<String>>,
}

impl Derived {
    /// Nothing moved.
    pub(crate) fn is_empty(&self) -> bool {
        let Derived {
            location_count,
            pending,
            meta,
            history,
            field_values,
            field_defs,
            selection_counts,
            selection_list,
            writing_layers,
        } = self;
        location_count.is_none()
            && pending.is_none()
            && meta.is_none()
            && history.is_none()
            && field_values.is_none()
            && field_defs.is_none()
            && selection_counts.is_none()
            && selection_list.is_none()
            && writing_layers.is_none()
    }
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
#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type)]
pub struct HeldValue {
    /// Optional metadata for an interned value.
    #[specta(type = Option<HashMap<String, specta_typescript::Unknown>>)]
    pub record: Option<ValueRecord>,
    /// How many locations hold the value.
    pub count: usize,
}

/// The version a write reached and the keys it assigned. Other updates arrive on the change feed.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Mutation<_T = Location> {
    /// The map version this change brought the map to.
    pub version: u64,
    /// The key the store gave each keyless set, in the order they were written.
    pub keys: Vec<Id<_T>>,
}

#[derive(serde::Serialize, specta::Type)]
pub struct MutationResult<T = Location> {
    pub mutation: Mutation<T>,
}

/// A map change broadcast to subscribers, with affected ids and derived state.
#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    /// The map version this change brought the map to.
    pub version: u64,
    /// The change itself, by key.
    #[serde(flatten)]
    pub keys: Keys<Id<Location>>,
    /// Changed derived state. Null fields are unchanged.
    pub derived: Derived,
}

/// Read or edit map rows directly, or through a named pending layer.
#[derive(serde::Deserialize, serde::Serialize, specta::Type, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// The map's rows.
    Map,
    /// A pending layer, created on first use. Reads include current underlying map data;
    /// edits reach the map when the layer lands.
    Pending { name: String },
}

/// A named layer of pending edits and where it is in its lifecycle.
#[derive(Default)]
pub(crate) struct Pending {
    pub(crate) layer: Layer<Location>,
    /// Incoming value records to reconcile when the layer lands.
    pub(crate) incoming: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
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

impl From<Option<u64>> for Joins {
    fn from(step: Option<u64>) -> Self {
        step.map_or(Joins::NewStep, Joins::Step)
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

/// What the store has to warn the user about. The sentence is TS's to write.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[tauri_specta(event_name = "store-warning")]
pub enum StoreWarning {
    /// The uncommitted delta was unreadable; the map opened from its last commit.
    DeltaSetAside,
}

impl Store {
    /// Apply a complete edit, update derived state, and record it for undo. A row that changes
    /// is stamped modified now.
    /// `join` tracks the newest undo step for grouping later batches.
    pub(crate) fn write(
        &mut self,
        edits: impl IntoIterator<Item = Edit<Location>>,
        join: &mut Option<u64>,
        entry: Entry,
    ) -> Mutation {
        let mut layer = Layer::default();
        let keys = layered(&mut layer, edits, &mut self.next_id);
        let locations = layer
            .resolve(
                |id| self.get_loc_by_id(id),
                |old, patch| self.applied(old, patch),
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
        let mut entry = Entry { locations, ..entry };
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
        entry.defs = DefsDelta::at(
            &self.field_defs,
            &fields,
            self.field_defs.keys().chain(fields.keys()).cloned(),
        );
        entry.selections = self.selection_consequences(&entry);
        let entry = Arc::new(entry);
        self.put_entry(&entry);
        self.record(&entry, join);
        Mutation {
            keys,
            ..self.finish(Finished::Entry(&entry))
        }
    }

    /// Add, patch, or remove rows at `target`. An open layer holds its edits until it lands;
    /// a landed layer writes them through, joining its undo step while that remains newest.
    pub(crate) fn edit(
        &mut self,
        target: &Target,
        edits: Vec<Edit<Location>>,
        join: &mut Option<u64>,
    ) -> Mutation {
        let Target::Pending { name } = target else {
            return self.write(edits, join, Entry::default());
        };
        let pending = self.pending.entry(name.clone()).or_default();
        let result = if let Some(joins) = pending.stage.landed() {
            if let Joins::Step(step) = joins {
                join.get_or_insert(step);
            }
            let result = self.write(edits, join, Entry::default());
            if let Some(pending) = self.pending.get_mut(name) {
                pending.stage = match pending.stage {
                    Stage::Closing(_) => Stage::Closing(Joins::from(*join)),
                    _ => Stage::Landed(Joins::from(*join)),
                };
            }
            result
        } else {
            let keys = layered(&mut pending.layer, edits, &mut self.next_id);
            self.held(keys)
        };
        self.settle_layers();
        result
    }

    /// Land an open layer's edits on the map as one undo step. A layer lands once: landing it
    /// again, after it was discarded, or when no such layer exists changes nothing.
    pub(crate) fn land(&mut self, name: &str, join: &mut Option<u64>) -> Mutation {
        if self
            .pending
            .get(name)
            .is_none_or(|p| p.stage != Stage::Open)
        {
            return self.held(Vec::new());
        }
        let (layer, piles) = self.reconcile_incoming(name);
        let result = self.write(
            layer.into_edits(),
            join,
            Entry {
                piles,
                ..Default::default()
            },
        );
        if let Some(pending) = self.pending.get_mut(name) {
            pending.stage = Stage::Landed(Joins::from(*join));
        }
        self.settle_layers();
        result
    }

    /// Take `name`'s staged rows for landing, with incoming value records matched to the map's
    /// by name and the rows' references remapped to them.
    fn reconcile_incoming(&mut self, name: &str) -> (Layer<Location>, Piles) {
        let pending = self.pending.entry(name.to_string()).or_default();
        let mut layer = mem::take(&mut pending.layer);
        let incoming = mem::take(&mut pending.incoming);
        let mut piles = Piles::new();
        for (field, incoming) in incoming {
            if incoming.is_empty() {
                continue;
            }
            let floor = self.intern_floor(&field);
            let before = self.records(&field);
            let mut after = before.clone();
            let remap = reconcile_values_by_name(incoming.values(), &mut after, floor);
            let registry = FieldRegistry::new(&self.field_defs);
            let to = registry
                .assign(&field)
                .expect("declared interned fields are writable");
            layer = layer.map_edits(|edit| remap_written(edit, &to, &remap), &mut self.next_id);
            piles.insert(field, PileDelta::at(&before, &after, remap.into_values()));
        }
        (layer, piles)
    }

    /// Remove closed layers nothing still writes to, then announce which layers are being
    /// written if that moved.
    pub(crate) fn settle_layers(&mut self) {
        let writing = crate::procedure::engine::pending_writers(&self.meta.id);
        self.pending
            .retain(|name, pending| !pending.stage.closed() || writing.contains(name));
        if writing != *self.writing_layers {
            self.writing_layers.replace(writing);
        }
        let derived = self.shipped();
        if !derived.is_empty() {
            self.changes.send(ChangeEvent {
                version: self.version,
                keys: Change::default().keys(),
                derived,
            });
        }
    }

    /// Close the layer. Unlanded work is cancelled; a landed layer stays until its writers finish.
    pub(crate) fn close_layer(&mut self, name: &str) {
        if let Some(pending) = self.pending.get_mut(name) {
            pending.stage = match pending.stage {
                Stage::Open => {
                    crate::procedure::engine::cancel_pending_writers(&self.meta.id, name);
                    Stage::Discarded
                }
                Stage::Landed(joins) => Stage::Closing(joins),
                closed => closed,
            };
        }
        self.settle_layers();
    }
    /// Result for a staged edit that did not change the map.
    fn held(&self, keys: Vec<Id<Location>>) -> Mutation {
        Mutation {
            version: self.version,
            keys,
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
        if !entry.meta.is_empty() || !entry.piles.is_empty() || !entry.defs.is_empty() {
            self.meta.edit().updated_at = crate::util::now_iso();
        }
        self.put(&entry.locations);
        for (field, delta) in entry.piles.iter().filter(|(_, d)| !d.is_empty()) {
            delta.apply_to(self.value_meta.entry(field.clone()).or_default().edit());
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

    /// Apply row changes to the store.
    pub(crate) fn put(&mut self, change: &Change) {
        if change.is_empty() {
            return;
        }
        self.overlay_remove(change.before());
        self.overlay_add(change.after().cloned().collect());
    }

    /// Join the newest undo step named by `join`, or record a new step in the entry's timeline.
    fn record(&mut self, entry: &Arc<Entry>, join: &mut Option<u64>) {
        let Some(timeline) = entry.timeline() else {
            return;
        };
        let edits = self.timeline(timeline).edit();
        if entry.locations.len() > MAX_UNDO_LOCATIONS {
            edits.clear();
            return;
        }
        if let Some(seq) = *join {
            if let Ok(seq) = edits.fold_into_newest(seq, (**entry).clone()) {
                *join = Some(seq);
                return;
            }
        }
        *join = Some(edits.record(Arc::clone(entry)));
    }
}

wire_str_enum! {
    /// When a move target already holds a value, which side survives.
    derive(serde::Deserialize, specta::Type, Clone, Copy, PartialEq)
    pub enum MergeWinner {
        /// The moved value replaces what the target already holds.
        From = "from",
        /// The target keeps its own value and the moved value is dropped.
        To = "to",
    }
}

/// Operations over the selected locations.
#[derive(serde::Deserialize, specta::Type)]
#[serde(untagged)]
pub enum Work {
    Locations(LocationOp),
    Sets(SetOp),
}

/// Operations computed independently for each selected location.
#[derive(serde::Deserialize, specta::Type)]
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
#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetOp {
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

/// What a field op planned: the patches for the rows it changes, the removed keys that
/// no longer exist on any row, and the rows an expression could not evaluate.
#[derive(Default)]
pub(super) struct WorkPlan {
    pub(super) edits: Vec<Edit<Location>>,
    pub(super) failed: Vec<Id<Location>>,
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

fn expr_value(to: FieldWriter<'_>, v: f64) -> Option<serde_json::Value> {
    if !to.is_flag() {
        return Some(number_value(v));
    }
    match v {
        0.0 => Some(serde_json::Value::Bool(false)),
        1.0 => Some(serde_json::Value::Bool(true)),
        _ => None,
    }
}

/// `edit` with the incoming ids it writes to `to`'s field replaced by their map ids.
/// An edit that writes no ids there, including a patch that leaves the field alone, is unchanged.
fn remap_written(
    edit: Edit<Location>,
    to: &FieldWriter<'_>,
    remap: &HashMap<Id<ValueRecord>, Id<ValueRecord>>,
) -> Edit<Location> {
    let written = |row: &Location| match selections::RowRef::from_loc(row).resolve_field(to.key()) {
        Some(serde_json::Value::Array(ids)) if !ids.is_empty() => Some(serde_json::Value::Array(
            ids.into_iter()
                .filter_map(|id| {
                    let id = Id::new(u32::try_from(id.as_u64()?).ok()?);
                    remap.get(&id).map(|id| id.get().into())
                })
                .collect(),
        )),
        _ => None,
    };
    let write = |patch: &mut Patch<Location>, row: &Location, ids: &serde_json::Value| {
        to.write(patch, row.flags, ids)
            .expect("declared interned fields hold id lists");
    };
    match edit {
        Op::Set(row) => match written(&row) {
            Some(ids) => {
                let mut patch = row_patch(row.id);
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

/// Layer `edits` as the store writes them: each added row takes a key from `ids` and is created now.
fn layered(
    layer: &mut Layer<Location>,
    edits: impl IntoIterator<Item = Edit<Location>>,
    ids: &mut Ids<Id<Location>>,
) -> Vec<Id<Location>> {
    let now = crate::util::now_unix();
    let edits = edits.into_iter().map(|edit| match edit {
        Op::Add(row) => Op::Add(row.created(now)),
        edit => edit,
    });
    layer.write(edits, ids)
}

/// A patch naming row `id` and changing nothing yet.
pub(super) fn row_patch(id: Id<Location>) -> Patch<Location> {
    Patch::<Location> {
        id,
        ..Default::default()
    }
}

/// Compute patches for rows changed by `op`, without applying them.
pub(super) fn plan_fields(
    fields: FieldRegistry<'_>,
    scope: &selections::Scope,
    op: &LocationOp,
) -> AppResult<WorkPlan> {
    if let LocationOp::Move { from, to, .. } = op {
        if from == to || to.is_empty() {
            return Ok(WorkPlan::default());
        }
    }
    let op = op.prepare(fields)?;
    let mut plan = WorkPlan::default();
    let mut err: Option<AppError> = None;
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
                match field_expr::eval(expr, &field).and_then(|v| expr_value(*to, v)) {
                    None => plan.failed.push(id),
                    Some(value) => {
                        if !same_field_value(row.resolve_field(to.key()).as_ref(), Some(&value)) {
                            writes.push((*to, value));
                        }
                    }
                }
            }
            Prepared::Move { from, to, winner } => {
                if let Some(value) = row.resolve_field(from.key()) {
                    writes.push((*from, serde_json::Value::Null));
                    // Winner decides only where the row already holds `to`.
                    if *winner == MergeWinner::From || row.resolve_field(to.key()).is_none() {
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
        let mut patch = row_patch(id);
        match writes
            .iter()
            .try_for_each(|(to, value)| to.write(&mut patch, row.flags(), value))
        {
            Ok(()) => plan.edits.push(Op::Put(patch)),
            Err(e) => err = Some(e),
        }
    }
    if let Some(e) = err {
        return Err(e);
    }
    Ok(plan)
}

/// Plan set-level work over the selected rows as a whole.
fn plan_sets(store: &mut Store, selector: &Selector, op: &SetOp) -> AppResult<WorkPlan> {
    Ok(match op {
        SetOp::Merge { groups, score } => {
            let score = selections::parse_duplicate_score(score.as_deref())?;
            let allowed = store.scope(selector).ids();
            let mut seen = HashSet::new();
            let mut plan = WorkPlan::default();
            for group in groups {
                let ids: BTreeSet<Id<Location>> = group
                    .iter()
                    .copied()
                    .filter(|id| allowed.contains(*id))
                    .collect();
                if ids.iter().any(|id| !seen.insert(*id)) {
                    return Err(AppError::from("merge groups must be disjoint"));
                }
                let members: Vec<Location> = ids
                    .into_iter()
                    .filter_map(|id| store.get_loc_by_id(id))
                    .collect();
                if members.len() < 2 {
                    continue;
                }
                let survivor = merge_group(store.registry(), &members, &score);
                plan.edits.extend(
                    members
                        .iter()
                        .filter(|m| m.id != survivor.id)
                        .map(|m| Op::Remove(m.id)),
                );
                plan.edits.push(Op::Set(survivor));
            }
            plan
        }
        SetOp::PruneDuplicates { distance, score } => {
            let score = selections::parse_duplicate_score(score.as_deref())?;
            let locs: Vec<Location> = store.collect(&crate::store::engine::Target::Map, selector);
            WorkPlan {
                edits: selections::prune_duplicates(&locs, *distance, &score)
                    .into_iter()
                    .map(Op::Remove)
                    .collect(),
                failed: Vec::new(),
            }
        }
    })
}

/// Compute and apply edits for `work` over selected rows.
pub(crate) fn apply_work(
    store: &mut Store,
    selector: &Selector,
    work: &Work,
) -> AppResult<WorkResult> {
    let (plan, defs) = match work {
        Work::Locations(op) => {
            let defs = (*store.field_defs).clone();
            let plan = plan_fields(FieldRegistry::new(&defs), &store.scope(selector), op)?;
            let defs = plan_defs(store, op, &plan.edits);
            (plan, defs)
        }
        Work::Sets(op) => (plan_sets(store, selector, op)?, DefsDelta::default()),
    };
    let selections = if let Work::Locations(op) = work {
        store
            .selections
            .change(&SelectionDelta::default(), |mut rows| {
                for (field, _) in &defs.removed {
                    let to = match op {
                        LocationOp::Move { from, to, .. } if from == field => Some(to.as_str()),
                        _ => None,
                    };
                    rows = rows
                        .into_iter()
                        .filter_map(|row| {
                            Some(ListedSelection {
                                selection: crate::selections::tree::rewrite(
                                    &row.selection,
                                    field,
                                    to,
                                )?,
                                ..row
                            })
                        })
                        .collect();
                }
                rows
            })
    } else {
        Default::default()
    };
    Ok(WorkResult {
        changed: plan.edits.len() as u32,
        failed: plan.failed,
        mutation: store.write(
            plan.edits,
            &mut None,
            Entry {
                defs,
                selections,
                ..Default::default()
            },
        ),
    })
}

/// Update definitions after a move or delete. A new target inherits the source definition;
/// fields no longer held by any row lose their definitions.
fn plan_defs(store: &Store, op: &LocationOp, edits: &[Edit<Location>]) -> DefsDelta {
    let (vacated, into) = match op {
        LocationOp::Move { from, to, .. } if from != to && !to.is_empty() => {
            (std::slice::from_ref(from), Some(to))
        }
        LocationOp::Delete { keys } => (keys.as_slice(), None),
        _ => return DefsDelta::default(),
    };
    let before = &*store.field_defs;
    if !vacated.iter().any(|k| before.contains_key(k)) {
        return DefsDelta::default();
    }
    let mut after = before.clone();
    if let (Some(to), Some(def)) = (into, before.get(&vacated[0])) {
        after.entry(to.clone()).or_insert_with(|| def.clone());
    }
    let edited: HashSet<Id<Location>> = edits
        .iter()
        .filter_map(|e| match e {
            Op::Put(p) => Some(p.id),
            _ => None,
        })
        .collect();
    for key in vacated.iter().filter(|k| before.contains_key(*k)) {
        let held = store
            .all()
            .rows()
            .any(|r| !edited.contains(&r.id()) && r.resolve_field(key).is_some());
        if !held {
            after.remove(key);
        }
    }
    let keys = vacated.iter().chain(into).cloned();
    DefsDelta::at(&store.field_defs, &after, keys)
}

/// Result of copying locations to another map.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyToMapResult {
    pub copied: u32,
    pub skipped: u32,
}

/// Cross-map dedup: a source is a duplicate of a target location if they share a
/// panoId (when the source has one) or exact lat/lng bits (pano-less sources).
/// Makes the copy hotkey idempotent; fuzzy spatial matching stays the job of the
/// in-map Duplicates selection.
pub(crate) fn split_new_locations(
    sources: Vec<Location>,
    existing: &[Location],
) -> (Vec<Location>, u32) {
    let mut panos: HashSet<&str> = HashSet::new();
    let mut coords: HashSet<(u64, u64)> = HashSet::new();
    for l in existing {
        if let Some(p) = &l.pano_id {
            if !p.is_empty() {
                panos.insert(p.as_str());
            }
        }
        coords.insert(coord_key(l.lat, l.lng));
    }
    let mut fresh = Vec::new();
    let mut skipped = 0u32;
    for l in sources {
        let dup = match &l.pano_id {
            Some(p) if !p.is_empty() => panos.contains(p.as_str()),
            _ => coords.contains(&coord_key(l.lat, l.lng)),
        };
        if dup {
            skipped += 1;
        } else {
            fresh.push(l);
        }
    }
    (fresh, skipped)
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
        let mut patch = row_patch(new_survivor.id);
        fields
            .assign(key)
            .and_then(|to| to.write(&mut patch, new_survivor.flags, &serde_json::json!(values)))
            .expect("interned list values satisfy their field's rules");
        new_survivor = new_survivor.patched(&patch);
    }
    new_survivor.extra = extra;
    new_survivor
}
