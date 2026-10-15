use super::*;
use crate::selections::{self, Selector};
use crate::store::id_set::IdSet;
use crate::types::Location;
use mma_algebra::{Id, Layer};

/// The store as one target sees it: the map's own locations, or those under a pending layer.
pub(crate) struct Targeted<'a> {
    pub(super) store: &'a mut Store,
    pub(super) layer: Option<&'a str>,
}

impl Store {
    /// Location `id` with `layer`'s held edits applied.
    pub(super) fn through(&self, layer: &Layer<Location>, id: Id<Location>) -> Option<Location> {
        layer.get(id, self.get_loc_by_id(id), |row, patch| {
            self.applied(row, patch).0
        })
    }

    /// The map as `target` sees it. Which map a target names is settled before this store
    /// is reached.
    pub(crate) fn at<'a>(&'a mut self, target: &'a Target) -> Targeted<'a> {
        let layer = match target {
            Target::Map { .. } => None,
            Target::Pending { name } => Some(name.as_str()),
        };
        Targeted { store: self, layer }
    }
}

impl Targeted<'_> {
    /// Location `id` as this target holds it.
    pub(crate) fn get(&self, id: Id<Location>) -> Option<Location> {
        match self.layer.and_then(|name| self.store.pending.get(name)) {
            Some(pending) => self.store.through(&pending.layer, id),
            None => self.store.get_loc_by_id(id),
        }
    }

    /// Whether edits here are held in a layer that has not landed.
    pub(crate) fn held(&self) -> bool {
        self.layer.is_some_and(|name| {
            self.store
                .pending
                .get(name)
                .is_none_or(|pending| pending.stage.landed().is_none())
        })
    }

    /// Matching locations. Explicit map ids keep request order and duplicates; other reads
    /// return unique locations sorted by id.
    pub(crate) fn rows(&mut self, selector: &Selector) -> Vec<Location> {
        if let (None, Selector::Locations { locations, .. }) = (self.layer, selector) {
            return locations
                .iter()
                .filter_map(|&id| self.store.get_loc_by_id(id))
                .collect();
        }
        self.scope(selector, None, |scope| {
            scope.rows().map(|row| row.to_location()).collect()
        })
    }

    /// Run `read` over what `selector` matches here, with the indexes `selector` and `ask` use.
    pub(crate) fn scope<R>(
        &mut self,
        selector: &Selector,
        ask: Option<&Ask>,
        read: impl FnOnce(selections::Scope<'_, '_>) -> R,
    ) -> R {
        let Some(name) = self.layer else {
            let store = &mut *self.store;
            let mut indexes = selector.indexes();
            if let Some(ask) = ask {
                indexes.extend(ask.indexes(store.optional_fields()));
            }
            store.prepare(indexes);
            return read(
                store
                    .view()
                    .indexed(&store.field_indexes, store.spatial.peek())
                    .select(selector),
            );
        };
        let keys: Vec<Id<Location>> = match selector {
            Selector::Locations { locations, .. } => locations.clone(),
            _ => self
                .store
                .pending
                .get(name)
                .map(|pending| pending.layer.keys().collect())
                .unwrap_or_default(),
        };
        let mut rows: Vec<Location> = keys.into_iter().filter_map(|id| self.get(id)).collect();
        rows.sort_unstable_by_key(|row| row.id);
        rows.dedup_by_key(|row| row.id);
        let dead = IdSet::new();
        let patches = HashMap::new();
        let view = selections::LocView::new(
            None,
            &dead,
            &patches,
            &rows,
            Some(&self.store.selections.ids),
        );
        read(view.select(selector))
    }
}
