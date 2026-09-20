//! Tags-flavored orchestration over the generic interned-value store: the one place
//! rows' typed `tags` column meets value records. Import and cross-map copy reconcile
//! through here. No tag shape lives on this side of the wire - piles ship as piles,
//! and JS coerces them to its `Tag` view at its own boundary.

use super::*;
use crate::util;

impl Store {
    /// Remap incoming tag ids onto this map's records by name (import and cross-map
    /// copy), rewriting `locations` in place; `bulk_tag` is one more incoming name
    /// through the same path, applied to every location. Record changes persist and
    /// ship on the enclosing mutation like any other edit.
    pub(crate) fn reconcile_incoming_tags(
        &mut self,
        source: &[(u32, ValueRecord)],
        bulk_tag: Option<&str>,
        locations: &mut [Location],
    ) {
        let floor = self.intern_floor("tags");
        let meta = self.value_meta.entry("tags".to_string()).or_default();
        let mut staged = (**meta).clone();
        let (remap, changed) = reconcile_values_by_name(source, &mut staged, floor);
        if changed {
            meta.replace(staged);
        }
        let bulk_id = bulk_tag
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|name| {
                let mut seed = ValueRecord::new();
                seed.insert("name".into(), name.into());
                seed.insert("color".into(), util::color_for_name(name).into());
                self.intern("tags", &[seed]).ok().map(|ids| ids[0])
            });
        for loc in locations.iter_mut() {
            loc.tags = loc
                .tags
                .iter()
                .filter_map(|old| remap.get(old).copied())
                .collect();
            if let Some(b) = bulk_id {
                if !loc.tags.contains(&b) {
                    loc.tags.push(b);
                }
            }
        }
        self.persist_value_meta("tags");
    }
}
