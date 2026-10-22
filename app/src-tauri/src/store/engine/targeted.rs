use super::*;
use crate::selections::{self, Selector};
use crate::store::id_set::IdSet;
use crate::store::maps::MapMeta;
use crate::types::{AppResult, Location};
use mma_algebra::{Change, Edit, Id, Layer, Patch};
use std::ops::DerefMut;
use std::sync::Arc;

/// The store as one target sees it: the map's own locations, or those under a pending layer,
/// and where its writes file their undo steps.
pub(crate) struct Targeted<'a> {
    pub(super) store: &'a mut Store,
    pub(super) layer: Option<&'a str>,
    pub(super) filing: Filing<'a>,
}

/// Where a handle's writes file their undo steps: a recording of its own, or one its caller
/// keeps across writes.
pub(super) enum Filing<'a> {
    Own(Recording),
    Joining(&'a mut Recording),
}

impl Deref for Filing<'_> {
    type Target = Recording;

    fn deref(&self) -> &Recording {
        match self {
            Filing::Own(recording) => recording,
            Filing::Joining(recording) => recording,
        }
    }
}

impl DerefMut for Filing<'_> {
    fn deref_mut(&mut self) -> &mut Recording {
        match self {
            Filing::Own(recording) => recording,
            Filing::Joining(recording) => recording,
        }
    }
}

impl Store {
    /// Location `id` with `layer`'s held edits applied.
    pub(super) fn through(&self, layer: &Layer<Location>, id: Id<Location>) -> Option<Location> {
        layer.get(id, self.get_loc_by_id(id), |row, patch| {
            self.applied(row, patch).0
        })
    }

    /// The map as `target` sees it, its writes each a new undo step. Which map a target names
    /// is settled before this store is reached.
    pub(crate) fn at<'a>(&'a mut self, target: &'a Target) -> Targeted<'a> {
        let layer = match target {
            Target::Map { .. } => None,
            Target::Pending { name } => Some(name.as_str()),
        };
        Targeted {
            store: self,
            layer,
            filing: Filing::Own(Recording::default()),
        }
    }
}

impl<'a> Targeted<'a> {
    /// This handle with writes that file no undo step.
    pub(crate) fn unrecorded(self) -> Self {
        Self {
            filing: Filing::Own(Recording::Off),
            ..self
        }
    }

    /// This handle with writes filed as `join` says, which keeps the step they make so later
    /// writes join it.
    pub(crate) fn joining(self, join: &'a mut Recording) -> Self {
        Self {
            filing: Filing::Joining(join),
            ..self
        }
    }
}

/// Where a write goes: to the map's shared content, through its host when it has one, or to
/// this device alone as the change it makes here.
pub(crate) enum Routed {
    /// A write to the map's shared content, as its writer meant it.
    Shared(Intent),
    /// A change that applies on this device as it is.
    Here(Entry),
}

/// A request to write to the map: the change it comes to here, or what is sent to the host
/// a map's shared content belongs to.
pub(crate) trait Write: Sized + 'static {
    /// What the write answers once it lands.
    type Done: Send + 'static;

    /// Where this write goes from `store`'s map.
    fn route(self, store: &Store) -> Routed;

    /// What the write answers, from what it did.
    fn done(edited: EditResult) -> Self::Done;
}

impl<'a> Targeted<'a> {
    /// Make `request` here. An open layer holds location edits until it lands. What a map
    /// shares goes to its host when it has one, its device-local details staying here; else
    /// the write applies here as the change it comes to.
    pub(crate) fn write<W: Write>(&mut self, request: W) -> Reached<W::Done> {
        let made = match request.route(self.store) {
            Routed::Shared(Intent::Edit { edits, records }) if self.held() => {
                Reached::ready(self.hold(edits, records))
            }
            Routed::Shared(mut intent) => self.joined(|at| {
                let Some(upstream) = at.store.upstream.clone() else {
                    return Reached::ready(
                        intent
                            .change(at.store)
                            .map(|(entry, edited)| at.make(entry, edited)),
                    );
                };
                if let Intent::Work { selector, .. } = &mut intent {
                    let ids = at.scope(selector).read(|scope| scope.ids());
                    *selector = Selector::Locations {
                        locations: ids.iter().collect(),
                        name: None,
                    };
                }
                if let Intent::Meta(patch) = &mut intent {
                    let here = patch.take_local();
                    let untouched = Patch::<MapMeta>::of(patch.id.clone());
                    if here != untouched {
                        let made = at.make(at.store.patched(&here), EditResult::default());
                        if **patch == untouched {
                            return Reached::ready(Ok(made));
                        }
                    }
                }
                let keys = match intent.keyed(&mut at.store.next_id) {
                    Ok(keys) => keys,
                    Err(exhausted) => return Reached::ready(Err(exhausted.into())),
                };
                if let Recording::Step(join) = &mut *at.filing {
                    join.get_or_insert_with(|| at.store.steps[Timeline::Edits].edit().fresh_join());
                }
                upstream
                    .send(intent, &mut at.filing)
                    .map(|edited| EditResult {
                        mutation: Mutation {
                            keys,
                            ..edited.mutation
                        },
                        ..edited
                    })
            }),
            Routed::Here(entry) => Reached::ready(Ok(self.make(entry, EditResult::default()))),
        };
        made.map(W::done)
    }

    /// Apply `entry` here, answering what `edited` says the write did. The listed selections
    /// follow it, unless it replays an undo or redo, which brings the selection changes it made.
    fn make(&mut self, mut entry: Entry, edited: EditResult) -> EditResult {
        if !matches!(*self.filing, Recording::Moving { .. }) {
            let store = &mut *self.store;
            let gone = store.emptied_values(&entry.locations, |field| {
                entry
                    .records
                    .get(field)
                    .into_iter()
                    .flat_map(Change::keys_iter)
                    .map(|id| id.to_string())
                    .collect()
            });
            entry.selections = store.selections.follow(&entry, &gone, &store.records);
        }
        let mutation = self.apply(entry);
        EditResult {
            mutation: Mutation {
                keys: edited.mutation.keys,
                ..mutation
            },
            ..edited
        }
    }

    /// Apply a whole change, file its undo step as this handle says, and finish it. New rows
    /// take ids above every row it brings.
    pub(super) fn apply(&mut self, entry: Entry) -> Mutation {
        for row in entry.locations.after() {
            self.store.next_id.saw(&row.id);
        }
        let entry = Arc::new(entry);
        self.store.put_entry(&entry);
        let history_cleared = self.store.record(&entry, &mut self.filing);
        Mutation {
            history_cleared,
            ..self.store.finish(Finished::Entry(entry))
        }
    }

    /// Make `write` here, where a landed layer's writes join its undo step while it is the
    /// newest and the layer keeps the step they made.
    pub(super) fn joined<T>(&mut self, write: impl FnOnce(&mut Self) -> Reached<T>) -> Reached<T> {
        let Some(name) = self.layer else {
            return write(self);
        };
        let landed = self
            .store
            .pending
            .get(name)
            .and_then(|pending| pending.stage.landed());
        if let (Some(Joins::Step(step)), Recording::Step(join)) = (landed, &mut *self.filing) {
            join.get_or_insert(step);
        }
        let written = write(self);
        if let Some(pending) = self.store.pending.get_mut(name) {
            pending.stage = match pending.stage {
                Stage::Closing(_) => Stage::Closing(Joins::from(&*self.filing)),
                _ => Stage::Landed(Joins::from(&*self.filing)),
            };
        }
        self.store.settle_layers();
        written
    }

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
        self.scope(selector)
            .read(|scope| scope.rows().map(|row| row.to_location()).collect())
    }

    /// This handle for rows from another map, whose references to interned values use the
    /// ids of `records`.
    pub(crate) fn from<'h>(
        &'h mut self,
        records: &'h HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    ) -> Foreign<'h, 'a> {
        Foreign { at: self, records }
    }

    /// `field`'s value records here, refused unless the map interns the field's values.
    pub(crate) fn field(&mut self, field: &str) -> AppResult<Values<'_, 'a>> {
        self.store.check_interned([field])?;
        Ok(Values {
            at: self,
            field: field.to_string(),
        })
    }

    /// The rows `selector` matches here, to read or work on.
    pub(crate) fn scope<'s>(&'s mut self, selector: &'s Selector) -> Scoped<'s, 'a> {
        Scoped {
            at: self,
            selector,
            ask: None,
        }
    }
}

/// Rows from another map where a handle points, whose references to interned values use
/// that map's records.
pub(crate) struct Foreign<'h, 'a> {
    at: &'h mut Targeted<'a>,
    records: &'h HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
}

impl Foreign<'_, '_> {
    /// Make `edits` here, each record their rows refer to matched to the map's record of the
    /// same name, created when missing.
    pub(crate) fn write(self, edits: Vec<Edit<Location>>) -> Reached<EditResult> {
        self.at.write(Intent::Edit {
            edits,
            records: self.records.clone(),
        })
    }
}

/// One interned field's value records where a handle points.
pub(crate) struct Values<'h, 'a> {
    at: &'h mut Targeted<'a>,
    field: String,
}

impl Values<'_, '_> {
    /// Make `edits` to the field's records, answering the keys the records they add take.
    pub(crate) fn write(self, edits: Vec<Edit<ValueRecord>>) -> Reached<Mutation<ValueRecord>> {
        let field = self.field;
        self.at
            .write(Intent::Values { field, edits })
            .map(|edited| Mutation {
                keys: edited.records,
                version: edited.mutation.version,
                history_cleared: edited.mutation.history_cleared,
            })
    }
}

/// The rows a selector matches where a handle points.
pub(crate) struct Scoped<'s, 'a> {
    pub(super) at: &'s mut Targeted<'a>,
    pub(super) selector: &'s Selector,
    ask: Option<&'s Ask>,
}

impl<'s> Scoped<'s, '_> {
    /// This scope with the indexes `ask` uses built too.
    pub(crate) fn asking(self, ask: &'s Ask) -> Self {
        Self {
            ask: Some(ask),
            ..self
        }
    }

    /// Run `read` over the rows this scope matches.
    pub(crate) fn read<R>(self, read: impl FnOnce(selections::Scope<'_, '_>) -> R) -> R {
        let Scoped { at, selector, ask } = self;
        let Some(name) = at.layer else {
            let store = &mut *at.store;
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
            _ => at
                .store
                .pending
                .get(name)
                .map(|pending| pending.layer.keys().collect())
                .unwrap_or_default(),
        };
        let mut rows: Vec<Location> = keys.into_iter().filter_map(|id| at.get(id)).collect();
        rows.sort_unstable_by_key(|row| row.id);
        rows.dedup_by_key(|row| row.id);
        let dead = IdSet::new();
        let patches = HashMap::new();
        let view =
            selections::LocView::new(None, &dead, &patches, &rows, Some(&at.store.selections.ids));
        read(view.select(selector))
    }
}
