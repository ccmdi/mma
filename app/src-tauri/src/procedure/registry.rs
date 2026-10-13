//! The providers the app has registered, and the field dependencies they declare.

use super::engine::{BatchMode, ProcedureDecl, ProviderDecl, Sink};
use crate::selections::Selector;
use crate::store::engine::StoreState;
use crate::types::{AppError, AppResult};
use mma_algebra::Dependents;
use std::collections::HashMap;
use std::sync::Arc;

/// A provider as registered: the procedure it runs, the fields it writes and the fields it reads.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDef {
    pub id: String,
    /// Name shown while it runs.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(flatten)]
    pub procedure: ProcedureDecl,
    /// Extra-field keys it produces.
    #[serde(default)]
    pub fields: Vec<String>,
    /// Core columns it writes, such as `panoId`.
    #[serde(default)]
    pub provides: Vec<String>,
    /// Fields it reads. Changing one clears what this provider wrote.
    #[serde(default)]
    pub requires: Vec<String>,
    pub batch: BatchMode,
    /// Instances it may run at once, when it cannot run beside itself.
    #[serde(default)]
    pub instances: Option<u32>,
}

/// One item of a run: a registered provider, or a procedure that is not one.
#[derive(Clone, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunItem {
    /// A registered provider, with what this run sets on it.
    #[serde(rename_all = "camelCase")]
    Provider {
        id: String,
        /// Extra-field keys to produce. When absent, every key the provider declares.
        #[serde(default)]
        fields: Option<Vec<String>>,
        #[specta(type = Selector<crate::selections::tree::SelectionInput>)]
        select: Selector,
        /// Replaces the registered configuration, as JSON text.
        #[serde(default)]
        config: Option<String>,
        /// Re-derive its fields even on a run that is not forced.
        #[serde(default)]
        force: Option<bool>,
    },
    /// A procedure declared in full by the caller.
    Procedure(ProviderDecl),
}

#[derive(Default)]
pub struct Providers {
    defs: HashMap<String, ProviderDef>,
    dependents: Arc<Dependents<String>>,
}

impl Providers {
    /// Add or replace a provider.
    pub fn register(&mut self, def: ProviderDef) {
        self.defs.insert(def.id.clone(), def);
        self.rebuild();
    }

    pub fn unregister(&mut self, id: &str) {
        if self.defs.remove(id).is_some() {
            self.rebuild();
        }
    }

    /// For each field, the fields computed from it.
    pub fn dependents(&self) -> Arc<Dependents<String>> {
        self.dependents.clone()
    }

    /// The declarations a run executes, in order.
    pub fn resolve(&self, items: Vec<RunItem>) -> AppResult<Vec<ProviderDecl>> {
        let mut decls = Vec::with_capacity(items.len());
        for item in items {
            match item {
                RunItem::Procedure(decl) => decls.push(decl),
                RunItem::Provider {
                    id,
                    fields,
                    select,
                    config,
                    force,
                } => {
                    let def = self
                        .defs
                        .get(&id)
                        .ok_or_else(|| AppError(format!("no provider '{id}' is registered")))?;
                    let wanted = fields.unwrap_or_else(|| def.fields.clone());
                    let mut procedure = def.procedure.clone();
                    if config.is_some() {
                        procedure.config = config;
                    }
                    decls.push(ProviderDecl {
                        id,
                        label: def.label.clone(),
                        procedure,
                        fields: wanted.into_iter().chain(def.provides.clone()).collect(),
                        requires: def.requires.clone(),
                        select,
                        batch: def.batch.clone(),
                        sink: Sink::Patch,
                        force,
                        instances: def.instances,
                    });
                }
            }
        }
        Ok(decls)
    }

    fn rebuild(&mut self) {
        let mut edges: HashMap<String, Vec<String>> = HashMap::new();
        for def in self.defs.values() {
            let outputs = def.fields.iter().chain(&def.provides);
            for input in &def.requires {
                edges
                    .entry(input.clone())
                    .or_default()
                    .extend(outputs.clone().cloned());
            }
        }
        self.dependents = Arc::new(Dependents::new(edges));
    }
}

fn publish(state: &StoreState, change: impl FnOnce(&mut Providers)) -> AppResult<()> {
    let mut mgr = state.lock()?;
    change(&mut mgr.providers);
    let dependents = mgr.providers.dependents();
    for store in mgr.stores.values_mut() {
        store.dependents = dependents.clone();
    }
    Ok(())
}

/// Register a provider, replacing one with the same id.
#[tauri::command]
#[specta::specta]
pub fn provider_register(
    state: tauri::State<'_, StoreState>,
    provider: ProviderDef,
) -> AppResult<()> {
    publish(state.inner(), |providers| providers.register(provider))
}

/// Remove a registered provider.
#[tauri::command]
#[specta::specta]
pub fn provider_unregister(state: tauri::State<'_, StoreState>, id: String) -> AppResult<()> {
    publish(state.inner(), |providers| providers.unregister(&id))
}

#[cfg(test)]
#[path = "registry.test.rs"]
mod tests;
