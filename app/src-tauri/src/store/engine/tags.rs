//! Tag registry and per-tag membership counts.

use super::*;
use crate::types::{Location, Tag};
use crate::util;
use roaring::RoaringBitmap;
use std::collections::{HashMap, HashSet};

pub(crate) struct TagState {
    pub all: Tracked<HashMap<u32, Tag>>,
    /// `tag_id -> number of locations carrying it`. The sole owner of tag counts;
    /// `MutationResult.tag_counts` is their only channel to JS, so nothing on the wire-facing
    /// `Tag` can disagree. Maintained in `update_tag_counts`, rebuilt on map open. The keys
    /// touched since the last `finish_mutation` decide which tags get their visibility
    /// re-derived (scanning all of them would hide any tag merely sitting at zero, including
    /// one just created) and whether the result carries `tag_counts` at all.
    pub counts: Touched<u32, usize>,
    pub next_id: u32,
    /// `tag_id -> set of member location ids`. Lets a `Tag` selection resolve by
    /// cloning a set instead of scanning every row's tag list. Maintained
    /// incrementally in `update_tag_counts` (the single choke point for tag
    /// membership changes) and rebuilt from the batch on map open. Covers committed
    /// base rows + overlay adds; patched/dead rows are reconciled at resolve time.
    pub sets: HashMap<u32, RoaringBitmap>,
}

/// Patchable fields of a `Tag`. Subset by design: id/visible aren't editable here.
#[derive(serde::Deserialize, specta::Type, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TagPatch {
    pub name: Option<String>,
    pub color: Option<String>,
    /// Full replacement for the tag's doclink URLs (empty vec clears).
    pub doclinks: Option<Vec<String>>,
}

/// Apply a TagPatch's set fields in place. Blank names are ignored; `doclinks`
/// is a full-list replacement (empty vec clears).
pub(crate) fn apply_tag_patch(t: &mut Tag, patch: &TagPatch) {
    if let Some(n) = &patch.name {
        let trimmed = n.trim();
        if !trimmed.is_empty() {
            t.name = trimmed.to_string();
        }
    }
    apply_patch!(clone t, patch; color, doclinks);
}

/// Merge `source_tags` into `target_tags` by case-insensitive name matching:
/// matches remap to the existing target id; misses are inserted as a clone of
/// the source tag (count reset) under a fresh id from `next_id`. Returns the
/// `{source_id -> target_id}` remap table and whether `target_tags` changed.
/// Single source of truth for tag reconciliation — used by import and
/// cross-map copy.
///
/// Order semantics: source order values are never stored verbatim. Every
/// ordered source tag whose target has no order yet (newly created, or an
/// existing tag with `order: None`) is appended after the target's max order,
/// dense, sorted by (source order, name). Targets with a concrete order keep
/// it; unordered source tags stay unordered.
///
/// Doclinks follow the same claim-if-empty rule: a matched target with no
/// doclinks adopts the source's list; existing assignments are never
/// overwritten by import.
pub(crate) fn reconcile_tags_by_name(
    source_tags: &[Tag],
    target_tags: &mut HashMap<u32, Tag>,
    next_id: &mut u32,
) -> (HashMap<u32, u32>, bool) {
    let mut name_to_id: HashMap<String, u32> = target_tags
        .values()
        .map(|t| (t.name.to_lowercase(), t.id))
        .collect();
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let mut created = false;
    let mut adopted_doclinks = false;
    let mut claims: Vec<(u32, u32, String)> = Vec::new();
    let mut claimed: HashSet<u32> = HashSet::new();
    for tag in source_tags {
        let lower = tag.name.to_lowercase();
        let target_id = match name_to_id.get(&lower) {
            Some(&id) => id,
            None => {
                let id = *next_id;
                *next_id += 1;
                target_tags.insert(
                    id,
                    Tag {
                        id,
                        order: None,
                        ..tag.clone()
                    },
                );
                name_to_id.insert(lower.clone(), id);
                created = true;
                id
            }
        };
        if let Some(src_order) = tag.order {
            if target_tags[&target_id].order.is_none() && claimed.insert(target_id) {
                claims.push((target_id, src_order, lower));
            }
        }
        if !tag.doclinks.is_empty() {
            let target = target_tags.get_mut(&target_id).unwrap();
            if target.doclinks.is_empty() {
                target.doclinks = tag.doclinks.clone();
                adopted_doclinks = true;
            }
        }
        remap.insert(tag.id, target_id);
    }
    claims.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)));
    let changed = created || adopted_doclinks || !claims.is_empty();
    let mut next_order = target_tags
        .values()
        .filter_map(|t| t.order)
        .max()
        .map_or(1, |m| m + 1);
    for (id, _, _) in claims {
        target_tags.get_mut(&id).unwrap().order = Some(next_order);
        next_order += 1;
    }
    (remap, changed)
}

impl Store {
    /// Adjust tag counts by `delta` (+1 for adds, -1 for removes). O(L * T) where L = locs, T = avg tags per loc.
    pub(crate) fn update_tag_counts<'a>(
        &mut self,
        locs: impl IntoIterator<Item = &'a Location>,
        delta: isize,
    ) {
        // Pre-aggregate membership changes per tag for bulk bitmap operations.
        let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
        for loc in locs {
            for &tag_id in &loc.tags {
                if delta > 0 && !self.tags.all.contains_key(&tag_id) {
                    self.tags.all.edit().insert(
                        tag_id,
                        Tag {
                            id: tag_id,
                            name: format!("Tag {tag_id}"),
                            color: util::color_for_name(&format!("Tag {tag_id}")),
                            visible: true,
                            order: None,
                            doclinks: Vec::new(),
                        },
                    );
                }
                let count = self.tags.counts.edit(tag_id);
                if delta < 0 {
                    *count = count.saturating_sub((-delta) as usize);
                } else {
                    *count += delta as usize;
                }
                members.entry(tag_id).or_default().push(loc.id);
            }
        }
        for (tag_id, mut ids) in members {
            if delta > 0 {
                ids.sort_unstable();
                self.tags.sets.entry(tag_id).or_default().extend(ids);
            } else if let Some(set) = self.tags.sets.get_mut(&tag_id) {
                for id in ids {
                    set.remove(id);
                }
            }
        }
    }

    /// Rebuild the `tag_id -> member ids` index from scratch over the live data
    /// (alive base rows + overlay adds, with patches applied). O(N * tags/loc). Called
    /// on map open; incremental edits maintain it via `update_tag_counts`.
    pub(crate) fn rebuild_tag_sets(&mut self) {
        let view = self.loc_view();
        let mut sets: HashMap<u32, RoaringBitmap> = HashMap::new();
        view.for_each(|row| {
            let id = row.id();
            row.for_each_tag(|tid| {
                sets.entry(tid).or_default().insert(id);
            });
        });
        self.tags.sets = sets;
    }

    /// Locations currently carrying `tag_id`.
    pub(crate) fn tag_count(&self, tag_id: u32) -> usize {
        self.tags.counts.get(&tag_id).copied().unwrap_or(0)
    }

    /// Increment tag counts for all tags referenced by `locs`.
    pub(crate) fn add_tag_counts<'a>(&mut self, locs: impl IntoIterator<Item = &'a Location>) {
        self.update_tag_counts(locs, 1);
    }

    /// Decrement tag counts for all tags referenced by `locs` (saturating at zero).
    pub(crate) fn remove_tag_counts<'a>(&mut self, locs: impl IntoIterator<Item = &'a Location>) {
        self.update_tag_counts(locs, -1);
    }

    /// Apply a tags-only update: adjust tag counts, write the tags patch into the
    /// overlay, and record undo for the changed pairs. Returns the ChangeSet.
    pub(crate) fn commit_tag_update(&mut self, updated: Vec<(Location, Location)>) -> ChangeSet {
        self.remove_tag_counts(updated.iter().map(|(o, _)| o));
        let updated: Vec<(Location, Location)> = updated
            .into_iter()
            .map(|(old, new_loc)| {
                let new_loc = self.overlay_write(new_loc.id, new_loc, &old);
                (old, new_loc)
            })
            .collect();
        self.add_tag_counts(updated.iter().map(|(_, n)| n));
        self.record_update_undo(updated.iter().cloned());
        ChangeSet {
            updated,
            ..Default::default()
        }
    }

    /// Ensure `names` exist as tags and are on `location_ids`, in one mutation. Names match
    /// case-insensitively, so an existing tag is reused (and un-hidden) rather than
    /// duplicated. An empty `location_ids` just creates them.
    pub(crate) fn create_tags(&mut self, names: &[String], location_ids: &[u32]) -> MutationResult {
        let mut name_to_id: HashMap<String, u32> = HashMap::new();
        for (&id, entry) in self.tags.all.iter() {
            name_to_id.insert(entry.name.to_lowercase(), id);
        }

        let mut tag_ids: Vec<u32> = Vec::with_capacity(names.len());
        for name in names {
            if let Some(&id) = name_to_id.get(&name.to_lowercase()) {
                self.tags.all.edit().get_mut(&id).unwrap().visible = true;
                tag_ids.push(id);
            } else {
                let id = self.alloc_tag_id();
                let order = self.tags.all.values().filter_map(|t| t.order).max();
                self.tags.all.edit().insert(
                    id,
                    Tag {
                        id,
                        name: name.clone(),
                        color: util::color_for_name(name),
                        visible: true,
                        order: Some(order.map_or(1, |m| m + 1)),
                        doclinks: Vec::new(),
                    },
                );
                name_to_id.insert(name.to_lowercase(), id);
                tag_ids.push(id);
            }
        }

        let mut updated: Vec<(Location, Location)> = Vec::new();
        for &id in location_ids {
            let Some(old) = self.get_loc_by_id(id) else {
                continue;
            };
            let mut tags = old.tags.clone();
            for &t in &tag_ids {
                if !tags.contains(&t) {
                    tags.push(t);
                }
            }
            if tags.len() == old.tags.len() {
                continue; // already had all of them
            }
            let mut new_loc = old.clone();
            new_loc.tags = tags;
            updated.push((old, new_loc));
        }

        let changeset = self.commit_tag_update(updated);
        self.finish_mutation(&changeset)
    }

    /// Allocate the next monotonically increasing tag ID.
    pub(crate) fn alloc_tag_id(&mut self) -> u32 {
        let id = self.tags.next_id;
        self.tags.next_id += 1;
        id
    }
}
