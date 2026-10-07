//! Location mutations as the engine applies them: adds, patches, field-wide ops, and the `MutationResult` they report.

use super::*;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::neighborhood::coord_key;
use crate::selections::{self, Selector};
use crate::store::maps;
use crate::store::storage;
use crate::types::wire_str_enum;
use crate::types::RawExtra;
use crate::types::{AppError, AppResult};
use crate::types::{Location, LocationFlags};
use crate::util;
use mma_algebra::{number_value, same_field_value, Merge, Patch, Patchable};
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// What one write did to the rows. The render frame, the indexes, the selection sync and
/// undo all read it, and undo writes its inverse.
pub type Change = mma_algebra::Change<Location>;

/// One change a writer asks for.
pub(crate) enum Edit {
    /// The row exactly as given, added when the map lacks it.
    Set(Location),
    /// The row with a patch written over it, stamped when that changes it.
    Put(Patch<Location>),
    Remove(u32),
}

/// Map state a change affected. Each field is `null` when it did not change.
// The open-time form (`super::StoreStatus`) has every field present. The JS mirror's type
// and merge are derived from this struct.
#[derive(serde::Serialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineValues {
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
    /// The whole extra-field registry (`MapMeta.extra.fields` mirror), when a key was
    /// seen for the first time or the user edited a definition.
    pub field_defs: Option<HashMap<String, maps::FieldDef>>,
}

/// What one change did to the open map.
// `values` are merged into the JS state mirror (an untouched slice keeps its reference and its
// subscribers sleep). The markers change through the render frame stamped with `version`.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    /// The map version this change brought the map to.
    pub version: u64,
    pub selection_sync: Option<SelectionSync>,
    pub values: EngineValues,
    /// The newest undo step after this change, for a later change to join while it is
    /// still the newest.
    pub step: Option<u64>,
    /// The active location as this change left it, when the change touched it.
    pub active: Option<Location>,
}

/// What the store has to warn the user about. The sentence is TS's to write.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[tauri_specta(event_name = "store-warning")]
pub enum StoreWarning {
    /// The uncommitted delta was unreadable; the map opened from its last commit.
    DeltaSetAside,
}

/// A change another window made to a map, identified by `mapId`.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "store-external-mutation")]
pub struct ExternalMutation {
    #[serde(flatten)]
    pub result: MutationResult,
    pub map_id: String,
}

impl Store {
    /// Define every `extra` key the rows a change brought in carry that the map has no
    /// definition for yet, with an inferred one, on disk and in memory.
    pub(super) fn register_fields(&mut self, changes: &Change) {
        let new_defs = {
            let extras: Vec<&RawExtra> = changes
                .added
                .iter()
                .chain(changes.updated.iter().map(|(_, new)| new))
                .filter_map(|l| l.extra.as_ref())
                .collect();
            maps::infer_field_defs(|k| self.field_defs.contains_key(k), &extras)
        };
        let Some(new_defs) = new_defs else {
            return;
        };
        if let Some(map_id) = &self.map_id {
            if let Ok(conn) = storage::open_db() {
                let _ = maps::persist_field_defs(&conn, map_id, &new_defs);
            }
        }
        self.field_defs.edit().extend(new_defs);
    }
}

/// A batch of new locations added to the open map.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub mutation: MutationResult,
    /// The id the first location was given; the rest follow it in order.
    pub first_id: u32,
}

/// Allocate IDs for `locations`, insert them, and record the undo entry. The one place a
/// batch of new locations becomes a mutation -- every add path (direct IPC, uploaded chunks)
/// ends here, so they cannot drift in what they record.
pub(crate) fn apply_adds(store: &mut Store, mut locations: Vec<Location>) -> Added {
    let first_id = store.next_id;
    for loc in &mut locations {
        loc.id = store.alloc_id();
    }
    Added {
        mutation: store.write(locations.into_iter().map(Edit::Set), UndoScope::Entry),
        first_id,
    }
}

/// How a patch batch lands in the undo history.
pub(crate) enum UndoScope<'a> {
    /// Not undoable.
    Skip,
    /// An entry of its own.
    Entry,
    /// One entry for a whole run: each batch joins the entry the tracker names while it
    /// is still the newest edit, and points the tracker at the entry it recorded.
    Run(&'a mut Option<u64>),
}

impl UndoScope<'_> {
    /// `Entry` or `Skip`, from the wire's boolean.
    pub(crate) fn entry_if(record_undo: bool) -> Self {
        if record_undo {
            UndoScope::Entry
        } else {
            UndoScope::Skip
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

    /// The only way rows change: each edit resolved against the row it touches, put,
    /// projected, and recorded for undo as `undo` says.
    pub(crate) fn write(
        &mut self,
        edits: impl IntoIterator<Item = Edit>,
        undo: UndoScope,
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
        let change = Change::from_rows(order.into_iter().filter_map(|id| rows.remove(&id)));
        self.put(&change);
        let mut result = self.finish_mutation(&change);
        if self.record(change, undo) {
            self.report(&mut result);
        }
        result
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

    /// Record `change` for undo as `undo` says: an entry of its own, or folded into the
    /// entry of a run while that is still the newest. Whether anything was recorded.
    fn record(&mut self, change: Change, undo: UndoScope) -> bool {
        if change.is_empty() {
            return false;
        }
        let edits = self.edits.edit();
        match undo {
            UndoScope::Skip => false,
            UndoScope::Entry => {
                edits.record(change);
                true
            }
            UndoScope::Run(group) => {
                let change = match *group {
                    Some(seq) => match edits.fold_into_newest(seq, change) {
                        Ok(seq) => {
                            *group = Some(seq);
                            return true;
                        }
                        Err(change) => change,
                    },
                    None => change,
                };
                *group = Some(edits.record(change));
                true
            }
        }
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

/// A rewrite of one `extra` field across every location, computed per row.
#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FieldOp {
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
pub(super) struct FieldPlan {
    pub(super) updates: Vec<Patch<Location>>,
    pub(super) failed: Vec<u32>,
}

/// The op's outcome for the caller: the mutation plus what its message needs.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldOpResult {
    pub mutation: MutationResult,
    /// Rows the op patched.
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
/// when it is declared writable, and clearable when its column is nullable -- writing
/// null to a column that cannot hold it reads as "unchanged", which is the silent no-op
/// this guards.
fn check_target(key: &str, assigning: bool) -> AppResult<()> {
    if !selections::is_builtin_field(key) {
        return Ok(());
    }
    let ok = if assigning {
        selections::is_writable_builtin(key)
    } else {
        clearable_builtins().contains(&key)
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
/// nothing, so the patch list is the changed set. Pure.
pub(super) fn plan_field_op(scope: &selections::Scope, op: &FieldOp) -> AppResult<FieldPlan> {
    if let FieldOp::Move { from, to, .. } = op {
        if from == to || to.is_empty() {
            return Ok(FieldPlan::default());
        }
    }
    let expr = match op {
        FieldOp::Expr { expr, .. } => Some(field_expr::parse(expr)?),
        _ => None,
    };
    match op {
        FieldOp::Set { key, value } => {
            check_target(key, true)?;
            if selections::flag_field(key).is_some() {
                flag_assignment(key, value)?;
            }
        }
        FieldOp::Expr { key, .. } | FieldOp::ListSet { key, .. } => check_target(key, true)?,
        FieldOp::Delete { keys } => keys.iter().try_for_each(|k| check_target(k, false))?,
        FieldOp::Move { from, to, .. } => {
            check_target(from, false)?;
            check_target(to, true)?;
        }
    }
    let mut plan = FieldPlan::default();
    let mut err: Option<AppError> = None;
    for row in scope.rows() {
        let id = row.id();
        let mut merge = serde_json::Map::new();
        match op {
            FieldOp::Set { key, value } => {
                if !same_field_value(row.resolve_field(key).as_ref(), Some(value)) {
                    merge.insert(key.clone(), value.clone());
                }
            }
            FieldOp::Expr { key, .. } => {
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
            FieldOp::Move { from, to, winner } => {
                if let Some(value) = row.resolve_field(from) {
                    merge.insert(from.clone(), serde_json::Value::Null);
                    // Winner decides only where the row already holds `to`.
                    if *winner == MergeWinner::From || row.resolve_field(to).is_none() {
                        merge.insert(to.clone(), value);
                    }
                }
            }
            FieldOp::Delete { keys } => {
                for key in keys {
                    if row.resolve_field(key).is_some() {
                        merge.insert(key.clone(), serde_json::Value::Null);
                    }
                }
            }
            FieldOp::ListSet { key, add, remove } => {
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
                Ok(patch) => plan.updates.push(patch),
                Err(e) => err = Some(e),
            }
        }
    }
    if let Some(e) = err {
        return Err(e);
    }
    Ok(plan)
}

/// Rewrite a field across the selected set in one pass. Replaces fetching every location
/// into JS to derive patches and shipping them all back.
pub(crate) fn apply_field_op(
    store: &mut Store,
    selector: &Selector,
    op: &FieldOp,
    record_undo: bool,
) -> AppResult<FieldOpResult> {
    let plan = { plan_field_op(&store.scope(selector), op)? };
    Ok(FieldOpResult {
        changed: plan.updates.len() as u32,
        failed: plan.failed,
        mutation: store.write(
            plan.updates.into_iter().map(Edit::Put),
            UndoScope::entry_if(record_undo),
        ),
    })
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
