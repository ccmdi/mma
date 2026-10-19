//! Global saved selection rules.
//!
//! A saved rule is one `Selector` tree plus the names its interned-value membership leaves
//! carried at save time. Value ids are map-local, so they resolve through the names at apply
//! time; the tree itself is stored verbatim. Rules are global rather than per-map -- no `map_id`.

use crate::selections::tree::SelectionOp;
use crate::selections::{FilterOp, Selection, Selector};
use crate::store::engine::{Store, StoreState, ValueNames, WindowLabel};
use crate::store::storage;
use crate::types::{AppError, AppResult};
use crate::util::{now_iso, Rgb};
use mma_algebra::Id;
use rusqlite::Connection;
use std::slice::from_ref;

/// A rule's identity and label, with no tree attached. What the UI lists and holds; the
/// body is a separate read because a single `Polygon` leaf can carry a country border's
/// coordinates (~1.7MB of JSON at the heavy border detail).
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedSelectionInfo {
    pub id: Id<SavedSelection, String>,
    pub name: String,
    pub color: Rgb,
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedSelection {
    #[serde(flatten)]
    pub info: SavedSelectionInfo,
    pub selector: Selector,
    /// Each interned field's value ids and the names they carried when saved, which carry a
    /// rule's value tests from one map to another.
    pub value_names: ValueNames,
}

const COLS: &str = "id, name, selector, value_names, color, created_at";

/// Stand-in color for a rule imported without one.
const NO_COLOR: Rgb = Rgb([128, 128, 128]);

// --- Core (testable against any Connection) ---

/// Every rule's identity, oldest first. Reads no tree, so its cost is the rule count.
pub(crate) fn list_info(conn: &Connection) -> AppResult<Vec<SavedSelectionInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, created_at FROM saved_selections ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SavedSelectionInfo {
            id: Id::new(row.get(0)?),
            name: row.get(1)?,
            color: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(NO_COLOR),
            created_at: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Bodies for `ids`, oldest first. A row whose JSON no longer parses (a `Selector` variant
/// this build dropped) is skipped rather than failing the whole read.
pub(crate) fn get(
    conn: &Connection,
    ids: &[Id<SavedSelection, String>],
) -> AppResult<Vec<SavedSelection>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let holes = vec!["?"; ids.len()].join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM saved_selections WHERE id IN ({holes}) ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter().map(Id::raw)), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, selector, value_names, color, created_at) = row?;
        let id = Id::new(id);
        match parse_row(&id, name, &selector, &value_names, &color, created_at) {
            Ok(s) => out.push(s),
            Err(e) => log::warn!("[saved-selections] skipping unreadable rule {id}: {e}"),
        }
    }
    Ok(out)
}

fn parse_row(
    id: &Id<SavedSelection, String>,
    name: String,
    selector: &str,
    value_names: &str,
    color: &str,
    created_at: String,
) -> Result<SavedSelection, serde_json::Error> {
    Ok(SavedSelection {
        info: SavedSelectionInfo {
            id: id.clone(),
            name,
            color: serde_json::from_str(color)?,
            created_at,
        },
        selector: serde_json::from_value(modernize(serde_json::from_str(selector)?))?,
        value_names: serde_json::from_str(value_names)?,
    })
}

/// Rows written before 0.10.2 spell a filter flat (`op`, `value`, `value2`, `tzLocal`
/// beside `field`); since then the predicate is one `test` object. Rows written before
/// `Ranked` spell it `TopK`, which ranked a bare field and dropped rows lacking it -- the
/// drop is now the child selection's job, so the rewrite wraps the field in a `has` filter.
/// Older rows also name selector types that were only ever field filters wearing a costume
/// (`Tag`, `Untagged`, `Unpanned`, `PanoIds`, `NotPanoIds`), and spell a flag field's value
/// as 0 or 1 rather than a boolean. All are rewritten on read, so the row itself is never
/// touched.
pub(crate) fn modernize(mut selector: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    let Some(obj) = selector.as_object_mut() else {
        return selector;
    };
    if let Some(ty) = obj.get("type").and_then(Value::as_str) {
        let folded = match ty {
            "Tag" => obj
                .get("tagId")
                .and_then(Value::as_u64)
                .map(|id| Selector::tag(id as u32)),
            "Untagged" => Some(Selector::untagged()),
            "Unpanned" => Some(Selector::unpanned()),
            "PanoIds" => Some(Selector::pinned()),
            "NotPanoIds" => Some(Selector::pinned().not()),
            _ => None,
        };
        if let Some(f) = folded {
            return serde_json::to_value(f).unwrap_or(Value::Null);
        }
    }
    if obj.get("type").and_then(Value::as_str) == Some("Filter") {
        if let Some(Value::String(op)) = obj.remove("op") {
            let value = obj.remove("value").unwrap_or(Value::Null);
            let value2 = obj.remove("value2").unwrap_or(Value::Null);
            let tz_local = obj.remove("tzLocal").unwrap_or(Value::Bool(false));
            let mut test = serde_json::Map::new();
            test.insert("op".into(), Value::String(op.clone()));
            match op.as_str() {
                "has" | "nothas" => {}
                "between" | "between_anyyear" | "between_anytime" => {
                    test.insert("lo".into(), value);
                    test.insert("hi".into(), value2);
                    test.insert("tzLocal".into(), tz_local);
                }
                "gt" | "lt" | "gte" | "lte" => {
                    test.insert("value".into(), value);
                    test.insert("tzLocal".into(), tz_local);
                }
                _ => {
                    test.insert("value".into(), value);
                }
            }
            obj.insert("test".into(), Value::Object(test));
        }
        let on_flag = obj
            .get("field")
            .and_then(Value::as_str)
            .and_then(|f| super::FieldRegistry::builtins().get(f))
            .is_some_and(|def| def.flag().is_some());
        if let Some(test) = obj
            .get_mut("test")
            .and_then(Value::as_object_mut)
            .filter(|_| on_flag)
        {
            let op = test.get("op").and_then(Value::as_str).unwrap_or_default();
            if let Some(v) = test.get("value").and_then(Value::as_f64) {
                let holds = |x: f64| match op {
                    "eq" => Some(x == v),
                    "neq" => Some(x != v),
                    "gt" => Some(x > v),
                    "lt" => Some(x < v),
                    "gte" => Some(x >= v),
                    "lte" => Some(x <= v),
                    _ => None,
                };
                if let (Some(off), Some(on)) = (holds(0.0), holds(1.0)) {
                    if off != on {
                        *test = serde_json::Map::from_iter([
                            ("op".to_string(), Value::from("eq")),
                            ("value".to_string(), Value::Bool(on)),
                        ]);
                    }
                }
            }
        }
    }
    if obj.get("type").and_then(Value::as_str) == Some("TopK") {
        if let Some(Value::String(field)) = obj.remove("field") {
            let k = obj.remove("k").unwrap_or(Value::Null);
            obj.insert("type".into(), Value::String("Ranked".into()));
            obj.insert("expr".into(), Value::String(field.clone()));
            obj.insert("k".into(), k);
            obj.insert(
                "selection".into(),
                serde_json::json!({
                    "color": NO_COLOR,
                    "selector": { "type": "Filter", "field": field, "test": { "op": "has" } },
                }),
            );
        }
    }
    if let Some(child) = obj.get_mut("selection").and_then(Value::as_object_mut) {
        if let Some(inner) = child.get_mut("selector") {
            *inner = modernize(inner.take());
        }
    }
    if let Some(Value::Array(children)) = obj.get_mut("selections") {
        for child in children {
            if let Some(inner) = child.get_mut("selector") {
                *inner = modernize(inner.take());
            }
        }
    }
    selector
}

pub(crate) fn create(
    conn: &Connection,
    name: String,
    selector: Selector,
    value_names: ValueNames,
    color: Rgb,
) -> AppResult<SavedSelection> {
    let saved = SavedSelection {
        info: SavedSelectionInfo {
            id: Id::new(uuid::Uuid::new_v4().to_string()),
            name,
            color,
            created_at: now_iso(),
        },
        selector,
        value_names,
    };
    insert(conn, &saved)?;
    Ok(saved)
}

fn insert(conn: &Connection, s: &SavedSelection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO saved_selections (id, name, selector, value_names, color, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            s.info.id.raw(),
            s.info.name,
            serde_json::to_string(&s.selector)?,
            serde_json::to_string(&s.value_names)?,
            serde_json::to_string(&s.info.color)?,
            s.info.created_at,
        ],
    )?;
    Ok(())
}

pub(crate) fn delete(conn: &Connection, id: &Id<SavedSelection, String>) -> AppResult<()> {
    conn.execute(
        "DELETE FROM saved_selections WHERE id = ?",
        rusqlite::params![id.raw()],
    )?;
    Ok(())
}

// --- Command wrappers ---

/// List every saved selection rule (name, color, date), without their selector trees.
#[tauri::command]
#[specta::specta]
pub async fn store_list_saved_selections() -> AppResult<Vec<SavedSelectionInfo>> {
    storage::with_db(|conn| list_info(conn)).await
}

/// Fetch the full saved selection rules for the given `ids`, including their selector trees.
#[tauri::command]
#[specta::specta]
pub async fn store_get_saved_selections(
    ids: Vec<Id<SavedSelection, String>>,
) -> AppResult<Vec<SavedSelection>> {
    storage::with_db(move |conn| get(conn, &ids)).await
}

/// Save a new selection rule.
#[tauri::command]
#[specta::specta]
pub async fn store_save_selection(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    name: String,
    selector: Selector<super::tree::SelectionInput>,
    color: Rgb,
) -> AppResult<SavedSelection> {
    let selector = selector.map_children(super::tree::SelectionInput::compile);
    // A rule saved with no map open keeps an empty side table: names resolve per map.
    let value_names = match state.lock()?.store_for_window(&label) {
        Ok(store) => capture_names(&selector, store),
        Err(_) => ValueNames::default(),
    };
    storage::with_db(move |conn| create(conn, name, selector, value_names, color)).await
}

/// The names of the values `selector` tests membership in, by field.
fn capture_names(selector: &Selector, store: &Store) -> ValueNames {
    let mut names = ValueNames::default();
    selector.walk(&mut |selector| {
        if let Some((field, id)) = selector.member_test() {
            let id = Id::new(id);
            if let Some(name) = store
                .value_record(field, id)
                .and_then(|record| record.name.as_deref())
            {
                names
                    .0
                    .entry(field.to_string())
                    .or_default()
                    .insert(id, name.to_string());
            }
        }
    });
    names
}

/// An edit of the selection tree as asked for: a saved selection to add, or a plain edit.
#[derive(Clone, Debug, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SelectionEdit {
    /// Add a saved selection's parts, with its value names resolved against the open map.
    AddSaved { id: Id<SavedSelection, String> },
    /// Any other edit of the selection tree.
    #[serde(untagged)]
    Op(SelectionOp),
}

impl SelectionEdit {
    /// The tree edit this asks for, reading a named saved selection from disk.
    pub(crate) fn resolved(self, store: &mut Store) -> AppResult<SelectionOp> {
        let id = match self {
            Self::Op(op) => return Ok(op),
            Self::AddSaved { id } => id,
        };
        let conn = storage::open_db()?;
        let saved = get(&conn, from_ref(&id))?
            .into_iter()
            .next()
            .ok_or_else(|| AppError("saved selection not found".into()))?;
        let selections = match saved.resolved(store) {
            Selector::Union { selections } => selections.into_iter().map(input).collect(),
            selector => vec![super::tree::SelectionInput {
                selector: selector.map_children(input),
                color: Some(saved.info.color),
            }],
        };
        Ok(SelectionOp::Add { selections })
    }
}

impl SavedSelection {
    fn resolved(&self, store: &mut Store) -> Selector {
        let mut interned = Vec::new();
        self.selector.walk(&mut |selector| {
            if let Some((field, _)) = selector.member_test() {
                if !interned.iter().any(|known| known == field)
                    && store.registry().get(field).is_some_and(|def| def.interned)
                {
                    interned.push(field.to_string());
                }
            }
        });
        let fields = store.fields(interned.iter().map(String::as_str));
        let edit = |selector: Selector| {
            let Some((field, raw)) = selector.member_test() else {
                return selector;
            };
            let Some(values) = fields.iter().find(|values| values.field() == field) else {
                return selector;
            };
            let id = Id::new(raw);
            let moved = match self
                .value_names
                .0
                .get(field)
                .and_then(|names| names.get(&id))
            {
                None => values.record(id).map(|_| raw),
                Some(name) => values.named(name).map(Id::get),
            };
            match moved {
                None => Selector::Locations {
                    locations: vec![],
                    name: None,
                },
                Some(id) => Selector::Filter {
                    field: field.to_string(),
                    test: FilterOp::Contains { value: id.into() },
                },
            }
        };
        edit(self.selector.map_children_ref(|child| {
            child.fold(&mut |node, children| {
                node.rebuilt(edit(node.selector.with_children_ref(children)))
            })
        }))
    }
}

fn input(selection: Selection) -> super::tree::SelectionInput {
    super::tree::SelectionInput {
        selector: selection.selector.map_children(input),
        color: Some(selection.color),
    }
}

/// Delete a saved selection rule by `id`.
#[tauri::command]
#[specta::specta]
pub async fn store_delete_saved_selection(id: Id<SavedSelection, String>) -> AppResult<()> {
    storage::with_db(move |conn| delete(conn, &id)).await
}

/// The pre-0.9.3 localStorage import, kept in its own file so it can be deleted whole.
#[path = "saved_legacy.rs"]
pub(crate) mod legacy;

#[cfg(test)]
#[path = "saved.test.rs"]
mod tests;
