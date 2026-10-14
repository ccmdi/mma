use super::*;
use crate::types::Location;
use mma_algebra::{same_field_value, Field, JsonWrite, Patch, Patchable};

impl Store {
    /// `row` with `patch` applied, and the derived fields the patch made stale, which it clears.
    pub(super) fn applied(
        &self,
        row: &Location,
        patch: &Patch<Location>,
    ) -> (Location, HashSet<String>) {
        let mut new = row.patched(patch);
        let inputs = self
            .dependents
            .inputs_changed_by(|key| field_changed(row, &new, key));
        let stale = self.dependents.invalidated(inputs, |key| {
            <Location as Patchable>::WRITES
                .iter()
                .any(|(k, _)| *k == key)
                || matches!(&patch.extra, Field::Set(extra) if extra.value().get(key).is_some())
        });
        if !stale.is_empty() {
            let clears = stale
                .iter()
                .map(|key| (key.clone(), serde_json::Value::Null))
                .collect();
            new.extra =
                new.extra
                    .patched(&Field::Set(JsonWrite::Merge(serde_json::Value::Object(
                        clears,
                    ))));
        }
        (new, stale)
    }

    pub(crate) fn retain_valid_outputs(
        &self,
        mut patch: Patch<Location>,
        read: &Location,
        now: &Location,
    ) -> Patch<Location> {
        let Field::Set(JsonWrite::Merge(extra)) = &patch.extra else {
            return patch;
        };
        let inputs = self
            .dependents
            .inputs_changed_by(|key| field_changed(read, now, key));
        let stale = self.dependents.outputs_of(&inputs);
        if stale.is_empty() {
            return patch;
        }
        let Some(mut values) = extra.as_object().cloned() else {
            return patch;
        };
        let before = values.len();
        values.retain(|key, _| !stale.contains(key));
        if values.len() != before {
            patch.extra = if values.is_empty() {
                Field::Keep
            } else {
                Field::Set(JsonWrite::Merge(serde_json::Value::Object(values)))
            };
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
