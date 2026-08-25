//! One-time import of the pre-0.9.3 localStorage `savedSelections` array.
//!
//! Self-contained and disposable: nothing outside this file knows the old shape, and the
//! parent module reaches in only through [`store_import_legacy_saved_selections`]. When
//! every install has upgraded, delete this file, its test file, its `mod legacy;` line,
//! the command's entry in `lib.rs`, and `importLegacySavedSelections` in
//! `store/migrations.ts` -- nothing else refers to any of it.

use super::{insert, SavedSelection, SavedSelectionInfo, NO_COLOR};
use crate::selections::{Selection, Selector};
use crate::storage;
use crate::types::AppResult;
use crate::util::{now_iso, unix_ms_to_iso};
use rusqlite::Connection;
use std::collections::HashMap;

/// A rule in the pre-SQLite shape: a list of items, each a props tree whose tag leaves
/// were `{ type: "TagName", tagName }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRule {
    #[serde(default)]
    name: String,
    #[serde(default)]
    items: Vec<LegacyItem>,
    #[serde(default)]
    created_at: Option<i64>,
}

#[derive(serde::Deserialize)]
struct LegacyItem {
    props: serde_json::Value,
    #[serde(default)]
    color: Option<[u8; 3]>,
}

/// Rewrites `TagName` leaves to `Tag` leaves carrying a synthetic id, recording each
/// distinct name in `names`. The id is a placeholder: apply time resolves a saved rule's
/// tags through `tag_names`, never through the stored id.
fn convert(value: &mut serde_json::Value, names: &mut HashMap<u32, String>) {
    if value.get("type").and_then(|t| t.as_str()) == Some("TagName") {
        let name = value
            .get("tagName")
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_string();
        let id = match names.iter().find(|(_, n)| **n == name) {
            Some((id, _)) => *id,
            None => {
                let id = names.len() as u32;
                names.insert(id, name);
                id
            }
        };
        *value = serde_json::json!({ "type": "Tag", "tagId": id });
        return;
    }
    // Legacy composites nest bare props; a `Selector` nests `Selection`s. The key is left
    // empty because JS rebuilds every composite's keys when it resolves the rule.
    if let Some(children) = value.get_mut("selections").and_then(|s| s.as_array_mut()) {
        for child in children.iter_mut() {
            convert(child, names);
            *child = serde_json::json!({ "key": "", "color": NO_COLOR, "selector": child });
        }
    }
}

fn props_to_selector(props: &serde_json::Value, names: &mut HashMap<u32, String>) -> Selector {
    let mut value = props.clone();
    convert(&mut value, names);
    serde_json::from_value(value).unwrap_or(Selector::Everything)
}

/// One legacy rule as a `SavedSelection`: the items become a single `Selector`, unioned
/// when there is more than one. `None` for a rule with no items.
fn legacy_to_saved(rule: LegacyRule) -> Option<SavedSelection> {
    if rule.items.is_empty() {
        return None;
    }
    let mut tag_names = HashMap::new();
    let color = rule.items[0].color.unwrap_or(NO_COLOR);
    let mut parts: Vec<Selection> = rule
        .items
        .iter()
        .map(|item| Selection {
            key: String::new(),
            color: item.color.unwrap_or(NO_COLOR),
            selector: props_to_selector(&item.props, &mut tag_names),
        })
        .collect();
    let selector = if parts.len() == 1 {
        parts.remove(0).selector
    } else {
        Selector::Union { selections: parts }
    };
    Some(SavedSelection {
        info: SavedSelectionInfo {
            id: uuid::Uuid::new_v4().to_string(),
            name: rule.name,
            color,
            created_at: rule
                .created_at
                .and_then(unix_ms_to_iso)
                .unwrap_or_else(now_iso),
        },
        selector,
        tag_names,
    })
}

/// Imports the localStorage `savedSelections` array, once. A table that already holds
/// rules is left alone, so every window can call this at boot.
pub(crate) fn import(conn: &mut Connection, json: &str) -> AppResult<u32> {
    let rules: Vec<LegacyRule> = serde_json::from_str(json)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: u32 = tx.query_row("SELECT COUNT(*) FROM saved_selections", [], |r| r.get(0))?;
    if existing > 0 {
        return Ok(0);
    }
    let mut imported = 0;
    for rule in rules {
        if let Some(saved) = legacy_to_saved(rule) {
            insert(&tx, &saved)?;
            imported += 1;
        }
    }
    tx.commit()?;
    log::info!("[saved-selections] imported {imported} rule(s) from localStorage");
    Ok(imported)
}

#[tauri::command]
#[specta::specta]
pub async fn store_import_legacy_saved_selections(json: String) -> AppResult<u32> {
    storage::with_db(move |conn| import(conn, &json)).await
}

#[cfg(test)]
#[path = "saved_selections.legacy.test.rs"]
mod tests;
