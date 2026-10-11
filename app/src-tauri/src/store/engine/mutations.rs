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
    number_value, same_field_value, Delta, Edit, Id, Keys, Layer, Merge, Op, Patch, Patchable,
};
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// A reversible row change shared by rendering, indexes, selections, and undo.
pub type Change = mma_algebra::Change<Location>;

/// Options for applying an edit.
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct EditOpts {
    /// Apply the pending layer to the map after these edits.
    #[specta(optional)]
    pub land: bool,
}

/// Map state a change affected. Each field is `null` when it did not change.
// The open-time form (`super::StoreStatus`) has every field present. The JS mirror's type
// and merge are derived from this struct.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Derived {
    pub location_count: Option<usize>,
    pub meta: Option<Patch<maps::MapMeta>>,
    pub history: Option<HashMap<EntryKey, History>>,
    /// Changed values, keyed by field and value. Null removes a value with no record or rows.
    pub field_values: Option<HashMap<String, HashMap<String, Option<HeldValue>>>>,
    /// The whole extra-field registry, when the map's row changed.
    pub field_defs: Option<HashMap<String, maps::FieldDef>>,
    /// Resolved count per selection node, keyed by `Selection.key` (top-level and nested).
    pub selection_counts: Option<HashMap<String, u32>>,
    /// The listed selections, when the list changed.
    pub selection_list: Option<Vec<ListedSelection>>,
}

impl Derived {
    /// Nothing moved.
    pub(crate) fn is_empty(&self) -> bool {
        self.location_count.is_none()
            && self.meta.is_none()
            && self.history.is_none()
            && self.field_values.is_none()
            && self.field_defs.is_none()
            && self.selection_counts.is_none()
            && self.selection_list.is_none()
    }
}

/// Whether undo and redo are available.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Default, specta::Type)]
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
    /// How many rows hold the value.
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
    /// edits reach the map when the layer is applied.
    Pending { name: String },
}

/// A named layer of pending edits and, once landed, the undo step its edits join.
#[derive(Default)]
pub(crate) struct Pending {
    pub(crate) layer: Layer<Location>,
    pub(crate) landed: Option<u64>,
    /// Incoming value records to reconcile when the pending rows are applied to the map.
    pub(crate) incoming: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
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
    /// Apply a complete edit, update derived state, and record it for undo.
    /// `join` tracks the newest undo step for grouping later batches.
    pub(crate) fn write(
        &mut self,
        edits: impl IntoIterator<Item = Edit<Location>>,
        join: &mut Option<u64>,
        entry: Entry,
    ) -> Mutation {
        let layer: Layer<Location> = edits.into_iter().collect();
        let rows = layer
            .resolve(
                |id| self.get_loc_by_id(id),
                |old, patch| {
                    let mut new = self.applied(old, patch);
                    if new != *old {
                        new.touch();
                    }
                    new
                },
            )
            .collect();
        let mut entry = Entry { rows, ..entry };
        let mut fields = self.meta.extra.fields.clone();
        entry.defs.apply_to(&mut fields);
        let extras: Vec<&RawExtra> = entry
            .rows
            .after()
            .filter_map(|row| row.extra.as_ref())
            .collect();
        if let Some(inferred) = maps::infer_field_defs(|key| fields.contains_key(key), &extras) {
            fields.extend(inferred);
        }
        entry.defs = DefsDelta::at(
            &self.meta.extra.fields,
            &fields,
            self.meta.extra.fields.keys().chain(fields.keys()).cloned(),
        );
        entry.selections = self.selection_consequences(&entry);
        let entry = Arc::new(entry);
        self.put_entry(&entry);
        self.record(&entry, join);
        self.finish_entry(&entry)
    }

    /// Add, patch, or remove rows at `target`. Pending edits stay staged until `land`.
    /// After landing, later edits write through and join that undo step while it remains newest.
    pub(crate) fn edit(
        &mut self,
        target: &Target,
        mut edits: Vec<Edit<Location>>,
        land: bool,
        join: &mut Option<u64>,
    ) -> Mutation {
        let mut added = Vec::new();
        for edit in &mut edits {
            if let Op::Set(row) = edit {
                if row.id == Id::UNSET {
                    row.id = self.alloc_id();
                    added.push(row.id);
                }
            }
        }
        let (edits, update_landed, piles) = match target {
            Target::Map => (edits, None, Piles::new()),
            Target::Pending { name } => {
                let entry = self.pending.entry(name.clone()).or_default();
                match entry.landed {
                    Some(seq) => {
                        join.get_or_insert(seq);
                        (edits, Some(name.clone()), Piles::new())
                    }
                    None => {
                        entry.layer.extend(edits);
                        if !land {
                            return self.held(added);
                        }
                        let pending = self.pending.remove(name).expect("entry just touched");
                        let (mut sets, mut removed) = (Vec::new(), Vec::new());
                        for row in pending
                            .layer
                            .resolve(|id| self.get_loc_by_id(id), |r, p| self.applied(r, p))
                        {
                            match (row.before, row.after) {
                                (_, Some(row)) => sets.push(row),
                                (Some(row), None) => removed.push(row.id),
                                (None, None) => {}
                            }
                        }
                        let mut piles = Piles::new();
                        for (field, incoming) in pending.incoming {
                            if incoming.is_empty() {
                                continue;
                            }
                            let floor = self.intern_floor(&field);
                            let before = self.records(&field);
                            let mut after = before.clone();
                            let remap =
                                reconcile_values_by_name(incoming.values(), &mut after, floor);
                            for row in &mut sets {
                                let Some(serde_json::Value::Array(values)) =
                                    selections::RowRef::from_loc(row).resolve_field(&field)
                                else {
                                    continue;
                                };
                                let values = values
                                    .into_iter()
                                    .filter_map(|value| {
                                        let id = Id::new(u32::try_from(value.as_u64()?).ok()?);
                                        remap.get(&id).map(|id| id.get().into())
                                    })
                                    .collect();
                                let mut patch = row_patch(row.id);
                                self.registry()
                                    .assign(&field)
                                    .and_then(|to| {
                                        to.write(
                                            &mut patch,
                                            row.flags,
                                            &serde_json::Value::Array(values),
                                        )
                                    })
                                    .expect("declared interned fields hold id lists");
                                *row = row.patched(&patch);
                            }
                            piles
                                .insert(field, PileDelta::at(&before, &after, remap.into_values()));
                        }
                        let edits = sets
                            .into_iter()
                            .map(Op::Set)
                            .chain(removed.into_iter().map(Op::Remove))
                            .collect();
                        (edits, Some(name.clone()), piles)
                    }
                }
            }
        };
        let result = Mutation {
            keys: added,
            ..self.write(
                edits,
                join,
                Entry {
                    piles,
                    ..Default::default()
                },
            )
        };
        if let Some(name) = update_landed {
            self.pending.insert(
                name,
                Pending {
                    landed: *join,
                    ..Default::default()
                },
            );
        }
        result
    }

    /// Drop the named pending layer and everything it holds.
    pub(crate) fn drop_pending(&mut self, name: &str) {
        self.pending.remove(name);
    }

    /// Result for a staged edit that did not change the map.
    fn held(&self, keys: Vec<Id<Location>>) -> Mutation {
        Mutation {
            version: self.version,
            keys,
        }
    }

    /// Apply row, value-record, and field-definition changes to the store.
    pub(crate) fn put_entry(&mut self, entry: &Entry) {
        for (old, new) in &entry.meta.updated {
            self.meta
                .replace(self.meta.patched(&maps::MapMeta::between(old, new)));
        }
        if !entry.selections.is_empty() {
            self.selections.apply(&entry.selections);
        }
        self.put(&entry.rows);
        for (field, delta) in entry.piles.iter().filter(|(_, d)| !d.is_empty()) {
            delta.apply_to(self.value_meta.entry(field.clone()).or_default().edit());
        }
        if !entry.defs.is_empty() {
            entry.defs.apply_to(&mut self.meta.edit().extra.fields);
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

    /// Join the newest undo step named by `join`, or record a new step.
    fn record(&mut self, entry: &Arc<Entry>, join: &mut Option<u64>) {
        if entry.rows.is_empty() && entry.piles.is_empty() && entry.defs.is_empty() {
            if entry.keys().eq([EntryKey::Selections]) {
                self.histories
                    .edit()
                    .entry(EntryKey::Selections)
                    .or_default()
                    .record(Arc::clone(entry));
            }
            return;
        }
        if entry.rows.len() > MAX_UNDO_ROWS {
            self.edits.edit().clear();
            return;
        }
        let edits = self.edits.edit();
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

/// Operations over selected rows.
#[derive(serde::Deserialize, specta::Type)]
#[serde(untagged)]
pub enum Work {
    Rows(RowOp),
    Sets(SetOp),
}

/// Operations computed independently for each selected row.
#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowOp {
    /// Rename `from` into `to`. Merge is the same operation -- rename is just the case
    /// where nothing holds `to` -- so `winner` decides only where a row holds both.
    Move {
        from: String,
        to: String,
        winner: MergeWinner,
    },
    /// Drop `keys` from every row that has them.
    Delete { keys: Vec<String> },
    /// Assign a value to a writable field on each row. Builtins update their stored
    /// fields; other keys update `extra`.
    Set {
        key: String,
        #[specta(type = specta_typescript::Unknown)]
        value: serde_json::Value,
    },
    /// Assign `key = expr(row)` per row. A row where the expression cannot evaluate (a
    /// missing or non-numeric field, a non-finite result) is reported back by id.
    Expr { key: String, expr: String },
    /// Add and remove list members. `add` wins if a value appears in both lists.
    /// Rows already in the requested state keep their member order.
    ListSet {
        key: String,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        add: Vec<serde_json::Value>,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        remove: Vec<serde_json::Value>,
    },
}

impl RowOp {
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

/// A [`RowOp`] ready to run: each key it writes holds its writer.
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

/// Operations computed over the selected rows as a group.
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
    /// Rows the work edited.
    pub changed: u32,
    /// Rows an expression could not evaluate.
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
    op: &RowOp,
) -> AppResult<WorkPlan> {
    if let RowOp::Move { from, to, .. } = op {
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
        Work::Rows(op) => {
            let defs = store.meta.extra.fields.clone();
            let plan = plan_fields(FieldRegistry::new(&defs), &store.scope(selector), op)?;
            let defs = plan_defs(store, op, &plan.edits);
            (plan, defs)
        }
        Work::Sets(op) => (plan_sets(store, selector, op)?, DefsDelta::default()),
    };
    let selections = if let Work::Rows(op) = work {
        store
            .selections
            .change(&SelectionDelta::default(), |mut rows| {
                for (field, _) in &defs.removed {
                    let to = match op {
                        RowOp::Move { from, to, .. } if from == field => Some(to.as_str()),
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
fn plan_defs(store: &Store, op: &RowOp, edits: &[Edit<Location>]) -> DefsDelta {
    let (vacated, into) = match op {
        RowOp::Move { from, to, .. } if from != to && !to.is_empty() => {
            (std::slice::from_ref(from), Some(to))
        }
        RowOp::Delete { keys } => (keys.as_slice(), None),
        _ => return DefsDelta::default(),
    };
    let before = &store.meta.extra.fields;
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
    DefsDelta::at(&store.meta.extra.fields, &after, keys)
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
        .fold(None, |held, m| {
            Merge::merged(&held, &m.extra.clone().into())
        });

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
    new_survivor.touch();
    new_survivor
}
