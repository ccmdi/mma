use super::*;
use crate::types::{Location, RawExtra};
use mma_algebra::{same_field_value, Dependencies, Field, Merge, Patch, Patchable};
use std::sync::Arc;

pub type ComputedFrom = Arc<HashMap<String, Vec<String>>>;

impl Store {
    pub(super) fn applied(&self, row: &Location, patch: &Patch<Location>) -> Location {
        let mut new = row.patched(patch);
        let inputs = self
            .derived
            .inputs_changed_by(|key| field_changed(row, &new, key));
        let stale = self.derived.invalidated(inputs, |key| {
            <Location as Patchable>::WRITES
                .iter()
                .any(|(k, _)| *k == key)
                || matches!(&patch.extra, Field::Set(extra) if extra.get(key).is_some())
        });
        if !stale.is_empty() {
            let clears = stale
                .into_iter()
                .map(|key| (key, serde_json::Value::Null))
                .collect();
            new.extra = Merge::merged(&new.extra, &RawExtra::from_map(&clears).into());
        }
        new
    }

    pub(crate) fn retain_valid_outputs(
        &self,
        mut patch: Patch<Location>,
        read: &Location,
        now: &Location,
    ) -> Patch<Location> {
        let Field::Set(extra) = &patch.extra else {
            return patch;
        };
        let inputs = self
            .derived
            .inputs_changed_by(|key| field_changed(read, now, key));
        let stale = self.derived.outputs_of(&inputs);
        if stale.is_empty() {
            return patch;
        }
        let mut values = extra.to_map();
        let before = values.len();
        values.retain(|key, _| !stale.contains(key));
        if values.len() != before {
            patch.extra = RawExtra::from_map(&values).map_or(Field::Keep, Field::Set);
        }
        patch
    }
}

fn field_changed(before: &Location, after: &Location, key: &str) -> bool {
    !same_field_value(
        selections::RowRef::from_loc(before)
            .resolve_field(key)
            .as_ref(),
        selections::RowRef::from_loc(after)
            .resolve_field(key)
            .as_ref(),
    )
}
