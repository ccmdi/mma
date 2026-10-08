//! Location mutations as the engine applies them: adds, patches, field-wide ops, and the `MutationResult` they report.

use super::*;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::neighborhood::coord_key;
use crate::selections::{self, Selector};
use crate::store::maps;
use crate::types::wire_str_enum;
use crate::types::RawExtra;
use crate::types::{AppError, AppResult};
use crate::types::{Location, LocationFlags};
use crate::util;
use mma_algebra::{number_value, same_field_value, Merge, Op, Patch, Patchable};
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// What one write did to the rows. The render frame, the indexes, the selection sync and
/// undo all read it, and undo writes its inverse.
pub type Change = mma_algebra::Change<Location>;

/// One keyed edit.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Edit {
    /// The row exactly as given; id zero adds it under a fresh id.
    Set(Location),
    /// A patch written over the row it names, stamped when that changes it.
    Put(Patch<Location>),
    /// The row at this id removed.
    Remove(u32),
}

/// How an edit lands.
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct EditOpts {
    /// Fold the pending layer's edits into the map after these land in it.
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
    pub can_undo: Option<bool>,
    pub can_redo: Option<bool>,
    /// Per-value row counts, keyed by field then by index key: one complete map per
    /// indexed field whose postings moved. Fields that did not move are absent.
    pub value_counts: Option<HashMap<String, HashMap<String, usize>>>,
    /// Per-value records (opaque piles), keyed by field then by interned id: one
    /// complete map per interned field whose records changed. JS coerces piles to its
    /// typed views (a tag) at its own boundary.
    #[specta(type = Option<HashMap<String, HashMap<u32, HashMap<String, specta_typescript::Unknown>>>>)]
    pub value_meta: Option<HashMap<String, HashMap<u32, ValueRecord>>>,
    /// The whole extra-field registry, when the map's row changed.
    pub field_defs: Option<HashMap<String, maps::FieldDef>>,
    /// Resolved count per selection node, keyed by `Selection.key` (top-level and nested).
    pub selection_counts: Option<HashMap<String, u32>>,
    /// Ids of each interned field's values this change left on no row or whose record it
    /// removed, keyed by field.
    pub dead_values: Option<HashMap<String, Vec<u32>>>,
}

impl Derived {
    /// Nothing moved.
    pub(crate) fn is_empty(&self) -> bool {
        self.location_count.is_none()
            && self.can_undo.is_none()
            && self.can_redo.is_none()
            && self.value_counts.is_none()
            && self.value_meta.is_none()
            && self.field_defs.is_none()
            && self.selection_counts.is_none()
            && self.dead_values.is_none()
    }
}

/// What one change did to the open map: its version, and the caller's own added rows.
/// Everything else a change moved arrives on the change feed.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    /// The map version this change brought the map to.
    pub version: u64,
    /// The id of each row this edit created, in the order they were written.
    pub added: Vec<u32>,
}

/// One landed change as every watching window hears it: the change by key, and the
/// state it moved.
#[derive(serde::Serialize, serde::Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    /// The map version this change brought the map to.
    pub version: u64,
    /// The change itself, by key.
    #[serde(flatten)]
    pub keys: mma_algebra::Keys<u32>,
    /// State this change moved; an untouched field is absent.
    pub derived: Derived,
}

/// Where an edit lands or a row is read: the map's rows, or a named layer of pending
/// edits held over them.
#[derive(serde::Deserialize, serde::Serialize, specta::Type, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// The map's rows.
    Map,
    /// The named layer of pending edits over the map, made on first use. Its edits read
    /// over the map's rows as they are now, and land when an edit says so.
    Pending { name: String },
}

/// A named layer of pending edits and, once landed, the undo step its edits join.
#[derive(Default)]
pub(crate) struct Pending {
    pub(crate) layer: mma_algebra::Layer<Location>,
    pub(crate) landed: Option<u64>,
    /// Value records the held rows reference, by field: the piles an import arrived
    /// with, reconciled into the map's records when the rows land.
    pub(crate) incoming: HashMap<String, Vec<(u32, ValueRecord)>>,
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
    /// Define every `extra` key the rows a change brought in carry that the map has no
    /// definition for yet, with an inferred one.
    pub(super) fn register_fields(&mut self, changes: &Change) {
        let extras: Vec<&RawExtra> = changes
            .added
            .iter()
            .chain(changes.updated.iter().map(|(_, new)| new))
            .filter_map(|l| l.extra.as_ref())
            .collect();
        if let Some(new_defs) =
            maps::infer_field_defs(|k| self.meta.extra.fields.contains_key(k), &extras)
        {
            self.meta.edit().extra.fields.extend(new_defs);
        }
    }
}

/// Each input field's direct outputs: the fields computed from it.
pub type ComputedFrom = Arc<HashMap<String, Vec<String>>>;

impl Store {
    /// `row` as the store keeps it after `patch`: written over, and every field computed
    /// from one the patch changes cleared along with it, unless the patch writes it itself.
    pub(super) fn applied(&self, row: &Location, patch: &Patch<Location>) -> Location {
        let mut new = row.patched(patch);
        let derived = &self.derived;
        let (before, after) = (
            selections::RowRef::from_loc(row),
            selections::RowRef::from_loc(&new),
        );
        let mut queue: Vec<&str> = derived
            .keys()
            .filter(|k| {
                !same_field_value(
                    before.resolve_field(k).as_ref(),
                    after.resolve_field(k).as_ref(),
                )
            })
            .map(String::as_str)
            .collect();
        let writes = |key: &str| {
            <Location as Patchable>::WRITES
                .iter()
                .any(|(k, _)| *k == key)
                || matches!(&patch.extra, Some(Some(e)) if e.get(key).is_some())
        };
        let mut stale = serde_json::Map::new();
        while let Some(key) = queue.pop() {
            for out in derived.get(key).into_iter().flatten() {
                if !writes(out) && stale.insert(out.clone(), serde_json::Value::Null).is_none() {
                    queue.push(out);
                }
            }
        }
        if !stale.is_empty() {
            new.extra = Merge::merged(&new.extra, &RawExtra::from_map(&stale));
        }
        new
    }

    /// `patch` with every extra key dropped whose declared inputs changed between the row
    /// the writer read and the row as it is now: an answer computed from a row that moved
    /// keeps only what still applies.
    pub(crate) fn still_applies(
        &self,
        mut patch: Patch<Location>,
        read: &Location,
        now: &Location,
    ) -> Patch<Location> {
        let Some(Some(extra)) = &patch.extra else {
            return patch;
        };
        let (read, now) = (
            selections::RowRef::from_loc(read),
            selections::RowRef::from_loc(now),
        );
        let moved: Vec<&String> = self
            .derived
            .iter()
            .filter(|(input, _)| {
                !same_field_value(
                    read.resolve_field(input).as_ref(),
                    now.resolve_field(input).as_ref(),
                )
            })
            .flat_map(|(_, outs)| outs)
            .collect();
        if moved.is_empty() {
            return patch;
        }
        let mut m = extra.to_map();
        let before = m.len();
        m.retain(|k, _| !moved.iter().any(|o| *o == k));
        if m.len() != before {
            patch.extra = RawExtra::from_map(&m).map(|r| Some(r));
        }
        patch
    }

    /// The only way rows, records and definitions change: each edit resolved against the
    /// row it touches, put with the rest of `entry`, projected, and recorded for undo.
    /// `join` names the step a run joins while it is still the newest, and is pointed at
    /// the step this write recorded.
    pub(crate) fn write(
        &mut self,
        edits: impl IntoIterator<Item = Edit>,
        join: &mut Option<u64>,
        entry: Entry,
    ) -> MutationResult {
        let mut order: Vec<u32> = Vec::new();
        let mut rows: HashMap<u32, (Option<Location>, Option<Location>)> = HashMap::new();
        for edit in edits {
            let id = match &edit {
                Edit::Set(loc) => loc.id,
                Edit::Put(patch) => patch.id,
                Edit::Remove(id) => *id,
            };
            let held = match rows.get(&id) {
                Some((_, after)) => after.clone(),
                None => self.get_loc_by_id(id),
            };
            let after = match edit {
                Edit::Set(loc) => Some(loc),
                Edit::Remove(_) => None,
                Edit::Put(patch) => held.as_ref().map(|old| {
                    let mut new = self.applied(old, &patch);
                    if new != *old {
                        touch(&mut new);
                    }
                    new
                }),
            };
            match rows.get_mut(&id) {
                Some(row) => row.1 = after,
                None => {
                    order.push(id);
                    rows.insert(id, (held, after));
                }
            }
        }
        let entry = Arc::new(Entry {
            rows: Change::from_rows(order.into_iter().filter_map(|id| rows.remove(&id))),
            ..entry
        });
        self.put_entry(&entry);
        self.record(&entry, join);
        self.finish_entry(&entry)
    }

    /// The one edit: whole rows added, flat patches written, ids removed, where `target`
    /// says. Edits at an unlanded pending layer are held there until one says `land`;
    /// edits at a landed layer write through and join its step while it is the newest.
    /// `join` is a run's tracker: the step recorded here is written back for the next
    /// batch to join while it is still the newest.
    pub(crate) fn edit(
        &mut self,
        target: &Target,
        mut edits: Vec<Edit>,
        land: bool,
        join: &mut Option<u64>,
    ) -> MutationResult {
        let mut added = Vec::new();
        for edit in &mut edits {
            if let Edit::Set(row) = edit {
                if row.id == 0 {
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
                        for edit in edits {
                            match edit {
                                Edit::Set(row) => entry.layer.push(row.id, Op::Set(row)),
                                Edit::Put(p) => entry.layer.push(p.id, Op::Put(p)),
                                Edit::Remove(id) => entry.layer.push(id, Op::Remove),
                            }
                        }
                        if !land {
                            return self.held(added);
                        }
                        let pending = self.pending.remove(name).expect("entry just touched");
                        let (mut sets, mut removed) = (Vec::new(), Vec::new());
                        for (id, _, after) in pending
                            .layer
                            .resolve(|id| self.get_loc_by_id(id), |r, p| self.applied(r, p))
                        {
                            match after {
                                Some(row) => sets.push(row),
                                None => removed.push(id),
                            }
                        }
                        let piles = match pending.incoming.get("tags") {
                            Some(incoming) if !incoming.is_empty() => {
                                let floor = self.intern_floor("tags");
                                let before = self.records("tags");
                                let mut after = before.clone();
                                let remap = reconcile_values_by_name(incoming, &mut after, floor);
                                for row in &mut sets {
                                    row.tags.retain(|old| remap.contains_key(old));
                                    row.tags.iter_mut().for_each(|old| *old = remap[old]);
                                }
                                let delta = PileDelta::at(&before, &after, remap.into_values());
                                Piles::from([("tags".to_string(), delta)])
                            }
                            _ => Piles::new(),
                        };
                        let edits = sets
                            .into_iter()
                            .map(Edit::Set)
                            .chain(removed.into_iter().map(Edit::Remove))
                            .collect();
                        (edits, Some(name.clone()), piles)
                    }
                }
            }
        };
        let result = self.write(
            edits,
            join,
            Entry {
                piles,
                ..Default::default()
            },
        );
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

    /// The row at `id` as `target` sees it.
    pub(crate) fn row_at(&self, target: &Target, id: u32) -> Option<Location> {
        let below = self.get_loc_by_id(id);
        match target {
            Target::Map => below,
            Target::Pending { name } => match self.pending.get(name) {
                Some(p) => p.layer.get(id, below, |r, patch| self.applied(r, patch)),
                None => below,
            },
        }
    }

    /// The rows `target` holds, read through its layer: every one, or just `ids`.
    pub(crate) fn rows_at(&self, target: &Target, ids: Option<&[u32]>) -> Vec<Location> {
        let keys: Vec<u32> = match (ids, target) {
            (Some(ids), _) => ids.to_vec(),
            (None, Target::Map) => return Vec::new(),
            (None, Target::Pending { name }) => self
                .pending
                .get(name)
                .map(|p| p.layer.keys().collect())
                .unwrap_or_default(),
        };
        keys.iter()
            .filter_map(|&id| self.row_at(target, id))
            .collect()
    }

    /// Drop the named pending layer and everything it holds.
    pub(crate) fn drop_pending(&mut self, name: &str) {
        self.pending.remove(name);
    }

    /// The result of an edit a pending layer held: nothing on the map moved.
    fn held(&self, added: Vec<u32>) -> MutationResult {
        MutationResult {
            version: self.version,
            added,
        }
    }

    /// Make the store hold every row, record and definition as `entry` leaves them.
    pub(crate) fn put_entry(&mut self, entry: &Entry) {
        self.put(&entry.rows);
        for (field, delta) in entry.piles.iter().filter(|(_, d)| !d.is_empty()) {
            delta.apply_to(self.value_meta.entry(field.clone()).or_default().edit());
        }
        if !entry.defs.is_empty() {
            entry.defs.apply_to(&mut self.meta.edit().extra.fields);
        }
    }

    /// Make the store hold every row as `change` leaves it.
    pub(crate) fn put(&mut self, change: &Change) {
        if change.is_empty() {
            return;
        }
        let old = change.updated.iter().map(|(o, _)| o);
        self.overlay_remove(change.removed.iter().chain(old));
        let new = change.updated.iter().map(|(_, n)| n);
        self.overlay_add(change.added.iter().chain(new).cloned().collect());
    }

    /// Record `entry` for undo: folded into the step `join` names while that is still the
    /// newest, else a step of its own.
    fn record(&mut self, entry: &Arc<Entry>, join: &mut Option<u64>) {
        if entry.is_empty() {
            return;
        }
        if entry.rows.len() > MAX_UNDO_ROWS {
            self.edits.edit().clear_redo();
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

/// Work the store runs over the selected rows to derive their edits.
#[derive(serde::Deserialize, specta::Type)]
#[serde(untagged)]
pub enum Work {
    Rows(RowOp),
    Sets(SetOp),
}

/// Work that derives each selected row's edit from that row alone.
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
    /// Assign `value` to `key` on every row where it differs. A writable built-in key
    /// (`heading`, `pitch`, `zoom`) patches its column; anything else writes `extra`.
    Set {
        key: String,
        #[specta(type = specta_typescript::Unknown)]
        value: serde_json::Value,
    },
    /// Assign `key = expr(row)` per row. A row where the expression cannot evaluate (a
    /// missing or non-numeric field, a non-finite result) is reported back by id.
    Expr { key: String, expr: String },
    /// Add `add` and strip `remove` from a list-valued field, per row. The only op that
    /// reads the row's current value as a set rather than replacing it, which is what
    /// membership needs: `tags` is this op's first caller, `array` extras its second.
    /// `add` wins for a value named in both lists, and a row already in the requested
    /// state keeps its member order.
    ListSet {
        key: String,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        add: Vec<serde_json::Value>,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        remove: Vec<serde_json::Value>,
    },
}

/// Work that derives its edits from the selected rows as a set.
#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetOp {
    /// Merge each duplicate group within `distance` metres into one survivor, unioning
    /// tags and extra fields. `score` ranks which survives; absent uses the default
    /// ranking.
    MergeDuplicates {
        distance: f64,
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
    pub(super) edits: Vec<Edit>,
    pub(super) failed: Vec<u32>,
}

/// The work's outcome for the caller: the mutation plus what its message needs.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkResult {
    pub mutation: MutationResult,
    /// Rows the work edited.
    pub changed: u32,
    /// Rows an expression could not evaluate.
    pub failed: Vec<u32>,
}

/// A flag field's assigned value as the bit it sets: a boolean, nothing else.
fn flag_assignment(key: &str, value: &serde_json::Value) -> AppResult<bool> {
    value
        .as_bool()
        .ok_or_else(|| AppError(format!("'{key}' takes true or false, not {value}")))
}

fn expr_value(key: &str, v: f64) -> Option<serde_json::Value> {
    if selections::flag_field(key).is_none() {
        return Some(number_value(v));
    }
    match v {
        0.0 => Some(serde_json::Value::Bool(false)),
        1.0 => Some(serde_json::Value::Bool(true)),
        _ => None,
    }
}

/// The patch applying row `id`'s assignments: a built-in column is set directly, a flag
/// field toggles its bit in the row's `flags`, anything else merges into `extra` (null
/// deletes). Every field op writes through here, so what `set` targets and what `delete`
/// targets cannot drift apart.
pub(super) fn assign_patch(
    id: u32,
    assignments: &serde_json::Map<String, serde_json::Value>,
    flags: LocationFlags,
) -> AppResult<Patch<Location>> {
    let mut columns = serde_json::Map::new();
    columns.insert("id".into(), id.into());
    let mut extra = serde_json::Map::new();
    let mut next_flags = flags;
    for (key, value) in assignments {
        if let Some(bit) = selections::flag_field(key) {
            next_flags.set(bit, flag_assignment(key, value)?);
            columns.insert("flags".into(), next_flags.bits().into());
            continue;
        }
        let dest = if selections::is_builtin_field(key) {
            &mut columns
        } else {
            &mut extra
        };
        dest.insert(key.clone(), value.clone());
    }
    let mut patch: Patch<Location> = serde_json::from_value(columns.into())?;
    if !extra.is_empty() {
        patch.extra = Some(RawExtra::from_map(&extra));
    }
    Ok(patch)
}

/// Reject a key an op cannot actually write, rather than reporting rows changed and
/// leaving the column standing. An `extra` key is always both. A built-in is assignable
/// when it is declared writable, and clearable when a null in its patch empties it.
fn check_target(key: &str, assigning: bool) -> AppResult<()> {
    if !selections::is_builtin_field(key) {
        return Ok(());
    }
    let ok = if assigning {
        selections::BUILTIN_FIELDS
            .iter()
            .any(|f| f.key == key && matches!(f.kind, Some(selections::BuiltinFieldKind::Writable)))
    } else {
        <Location as Patchable>::CLEARS.contains(&key)
    };
    if ok {
        return Ok(());
    }
    Err(AppError(format!(
        "'{key}' cannot be {}",
        if assigning { "assigned" } else { "removed" }
    )))
}

/// Derive the patch each selected row needs for `op`. Rows the op wouldn't change yield
/// nothing, so the edit list is the changed set. Pure.
pub(super) fn plan_fields(scope: &selections::Scope, op: &RowOp) -> AppResult<WorkPlan> {
    if let RowOp::Move { from, to, .. } = op {
        if from == to || to.is_empty() {
            return Ok(WorkPlan::default());
        }
    }
    let expr = match op {
        RowOp::Expr { expr, .. } => Some(field_expr::parse(expr)?),
        _ => None,
    };
    match op {
        RowOp::Set { key, value } => {
            check_target(key, true)?;
            if selections::flag_field(key).is_some() {
                flag_assignment(key, value)?;
            }
        }
        RowOp::Expr { key, .. } | RowOp::ListSet { key, .. } => check_target(key, true)?,
        RowOp::Delete { keys } => keys.iter().try_for_each(|k| check_target(k, false))?,
        RowOp::Move { from, to, .. } => {
            check_target(from, false)?;
            check_target(to, true)?;
        }
    }
    let mut plan = WorkPlan::default();
    let mut err: Option<AppError> = None;
    for row in scope.rows() {
        let id = row.id();
        let mut merge = serde_json::Map::new();
        match op {
            RowOp::Set { key, value } => {
                if !same_field_value(row.resolve_field(key).as_ref(), Some(value)) {
                    merge.insert(key.clone(), value.clone());
                }
            }
            RowOp::Expr { key, .. } => {
                let expr = expr.as_ref().expect("parsed above");
                let field = |name: &str| row.resolve_field(name);
                match field_expr::eval(expr, &field).and_then(|v| expr_value(key, v)) {
                    None => plan.failed.push(id),
                    Some(value) => {
                        if !same_field_value(row.resolve_field(key).as_ref(), Some(&value)) {
                            merge.insert(key.clone(), value);
                        }
                    }
                }
            }
            RowOp::Move { from, to, winner } => {
                if let Some(value) = row.resolve_field(from) {
                    merge.insert(from.clone(), serde_json::Value::Null);
                    // Winner decides only where the row already holds `to`.
                    if *winner == MergeWinner::From || row.resolve_field(to).is_none() {
                        merge.insert(to.clone(), value);
                    }
                }
            }
            RowOp::Delete { keys } => {
                for key in keys {
                    if row.resolve_field(key).is_some() {
                        merge.insert(key.clone(), serde_json::Value::Null);
                    }
                }
            }
            RowOp::ListSet { key, add, remove } => {
                let current = match row.resolve_field(key) {
                    Some(serde_json::Value::Array(a)) => a,
                    Some(v) => vec![v],
                    None => Vec::new(),
                };
                let mut next: Vec<serde_json::Value> = current
                    .iter()
                    .filter(|v| !contains_value(remove, v) || contains_value(add, v))
                    .cloned()
                    .collect();
                for v in add {
                    if !contains_value(&next, v) {
                        next.push(v.clone());
                    }
                }
                if next != current {
                    // A builtin column is non-null, so an emptied list is `[]`. An
                    // emptied `extra` key carries nothing, so it is deleted instead.
                    merge.insert(
                        key.clone(),
                        if next.is_empty() && !selections::is_builtin_field(key) {
                            serde_json::Value::Null
                        } else {
                            serde_json::Value::Array(next)
                        },
                    );
                }
            }
        }
        if !merge.is_empty() {
            match assign_patch(id, &merge, row.flags()) {
                Ok(patch) => plan.edits.push(Edit::Put(patch)),
                Err(e) => err = Some(e),
            }
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
        SetOp::MergeDuplicates { distance, score } => {
            let score = selections::parse_duplicate_score(score.as_deref())?;
            let mut plan = WorkPlan::default();
            for group in store.scope(selector).duplicate_groups(*distance) {
                let members: Vec<Location> = group
                    .iter()
                    .filter_map(|&id| store.get_loc_by_id(id))
                    .collect();
                if members.len() < 2 {
                    continue;
                }
                let survivor = merge_group(&members, &score);
                plan.edits
                    .extend(members.iter().map(|m| Edit::Remove(m.id)));
                plan.edits.push(Edit::Set(survivor));
            }
            plan
        }
        SetOp::PruneDuplicates { distance, score } => {
            let score = selections::parse_duplicate_score(score.as_deref())?;
            let locs: Vec<Location> = store.collect(selector);
            WorkPlan {
                edits: selections::prune_duplicates(&locs, *distance, &score)
                    .into_iter()
                    .map(Edit::Remove)
                    .collect(),
                failed: Vec::new(),
            }
        }
    })
}

/// Run `work` over the selected rows in one pass, deriving and landing their edits.
pub(crate) fn apply_work(
    store: &mut Store,
    selector: &Selector,
    work: &Work,
) -> AppResult<WorkResult> {
    let (plan, defs) = match work {
        Work::Rows(op) => {
            let plan = plan_fields(&store.scope(selector), op)?;
            let defs = plan_defs(store, op, &plan.edits);
            (plan, defs)
        }
        Work::Sets(op) => (plan_sets(store, selector, op)?, DefsDelta::default()),
    };
    Ok(WorkResult {
        changed: plan.edits.len() as u32,
        failed: plan.failed,
        mutation: store.write(
            plan.edits,
            &mut None,
            Entry {
                defs,
                ..Default::default()
            },
        ),
    })
}

/// What a field move or delete does to the definitions: a move target without one takes
/// the source's, and a key no row still holds after `edits` loses its own.
fn plan_defs(store: &Store, op: &RowOp, edits: &[Edit]) -> DefsDelta {
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
    let edited: HashSet<u32> = edits
        .iter()
        .filter_map(|e| match e {
            Edit::Put(p) => Some(p.id),
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
    pub target_name: String,
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

/// Fold a duplicate group into one survivor, picked by [`selections::better`]. Tags are
/// set-unioned; `extra` is merged with the survivor winning key conflicts; all other
/// survivor fields are kept. `members` must be non-empty. The returned survivor keeps
/// its original id (so callers represent the merge as an update of the survivor plus
/// removal of the rest).
pub(crate) fn merge_group(members: &[Location], score: &Expr) -> Location {
    let survivor = members
        .iter()
        .max_by(|a, b| selections::better(a, b, score))
        .expect("merge_group requires a non-empty group");

    let mut tagset: BTreeSet<u32> = BTreeSet::new();
    for m in members {
        tagset.extend(m.tags.iter().copied());
    }

    // Non-survivors in id order first, survivor last so its values win conflicts.
    let mut others: Vec<&Location> = members.iter().filter(|m| m.id != survivor.id).collect();
    others.sort_by_key(|m| m.id);
    let extra = others
        .into_iter()
        .chain([survivor])
        .filter(|m| m.extra.is_some())
        .fold(None, |held, m| Merge::merged(&held, &m.extra));

    let mut new_survivor = survivor.clone();
    new_survivor.tags = tagset.into_iter().collect();
    new_survivor.extra = extra;
    new_survivor.modified_at = Some(util::now_unix());
    new_survivor
}
