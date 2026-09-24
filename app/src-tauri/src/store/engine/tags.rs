//! Tags-flavored orchestration over the generic interned-value store: the one place
//! rows' typed `tags` column meets value records. Import and cross-map copy reconcile
//! through here. No tag shape lives on this side of the wire - piles ship as piles,
//! and JS coerces them to its `Tag` view at its own boundary.

use super::*;
use crate::util;

impl Store {
    /// Remap incoming tag ids onto this map's records by name (import and cross-map
    /// copy), rewriting `locations` in place; `bulk_tags` are more incoming names
    /// through the same path, applied to every location. Record changes persist and
    /// ship on the enclosing mutation like any other edit.
    pub(crate) fn reconcile_incoming_tags(
        &mut self,
        source: &[(u32, ValueRecord)],
        bulk_tags: &[String],
        locations: &mut [Location],
    ) {
        let floor = self.intern_floor("tags");
        let meta = self.value_meta.entry("tags".to_string()).or_default();
        let mut staged = (**meta).clone();
        let (remap, changed) = reconcile_values_by_name(source, &mut staged, floor);
        if changed {
            meta.replace(staged);
        }
        let seeds: Vec<ValueRecord> = bulk_tags
            .iter()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .map(|name| {
                let mut seed = ValueRecord::new();
                seed.insert("name".into(), name.into());
                seed.insert("color".into(), util::color_for_name(name).into());
                seed
            })
            .collect();
        let bulk_ids = if seeds.is_empty() {
            Vec::new()
        } else {
            self.intern("tags", &seeds).unwrap_or_default()
        };
        for loc in locations.iter_mut() {
            loc.tags = loc
                .tags
                .iter()
                .filter_map(|old| remap.get(old).copied())
                .collect();
            for &b in &bulk_ids {
                if !loc.tags.contains(&b) {
                    loc.tags.push(b);
                }
            }
        }
        self.persist_value_meta("tags");
    }
}
