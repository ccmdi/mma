//! Writes to the map's shared content as their writer meant them, before the map gives them
//! ids or matches their records to its own.

use super::*;
use crate::selections::Selector;
use futures::future::{self, BoxFuture, FutureExt, TryFutureExt};
use mma_algebra::{
    Constrained, Edit, Encode, Exhausted, IdRange, Layer, Moved, Op, Patch, Patchable, Transition,
};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// A write to the map's shared content, as its writer meant it.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Intent {
    /// Add, patch, or remove rows, whose references to interned values use the ids of
    /// `records`, each matched to the map's record of the same name.
    Edit {
        #[serde(serialize_with = "Encode::encode")]
        edits: Vec<Edit<Location>>,
        records: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    },
    /// Edit one interned field's value records. Renaming onto a name another record holds
    /// merges the two values and remaps their rows.
    Values {
        field: String,
        #[serde(serialize_with = "Encode::encode")]
        edits: Vec<Edit<ValueRecord>>,
    },
    /// Patch the map's details.
    Meta(#[serde(serialize_with = "Encode::encode")] Box<Patch<MapMeta>>),
    /// Apply a whole change, refused unless the map still holds every state it starts from.
    Entry(#[serde(with = "whole")] Box<Entry>),
    /// Do `work` on the rows `selector` matches, planned against the map's own rows.
    Work { selector: Selector, work: Work },
}

/// What a write comes to: at once on a store that applies it here, or once a replica's host
/// answers.
#[must_use = "a write's answer says whether it landed"]
pub(crate) struct Reached<T>(BoxFuture<'static, AppResult<T>>);

impl<T: Send + 'static> Reached<T> {
    /// A write that came to `result` here.
    pub(crate) fn ready(result: AppResult<T>) -> Self {
        Self(future::ready(result).boxed())
    }

    /// A write that comes to what `answer` resolves to.
    pub(crate) fn later(answer: impl Future<Output = AppResult<T>> + Send + 'static) -> Self {
        Self(answer.boxed())
    }

    /// What the write comes to, made into `f` of it.
    pub(crate) fn map<U: Send + 'static>(
        self,
        f: impl FnOnce(T) -> U + Send + 'static,
    ) -> Reached<U> {
        Reached(self.0.map_ok(f).boxed())
    }

    /// The answer a store with no upstream gives at once.
    pub(crate) fn settled(self) -> AppResult<T> {
        self.0
            .now_or_never()
            .expect("a store with no upstream answers at once")
    }
}

impl<T> Future for Reached<T> {
    type Output = AppResult<T>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.0.as_mut().poll(cx)
    }
}

/// Where a replica's writes to the map's shared content are applied.
pub(crate) trait Upstream: Send + Sync {
    /// Send `intent` to be applied, answered once this store has adopted what it did and filed
    /// the step `recording` carries. A write that cannot be sent leaves `recording` here.
    fn send(&self, intent: Intent, recording: &mut Recording) -> Reached<EditResult>;

    /// Ask for a block of `len` ids no row of the map holds, for this store's new rows.
    fn lease(&self, len: u32) -> Reached<IdRange<Location>>;
}

impl Intent {
    /// Key the rows this intent adds from `ids`, each created now, and the keys they took.
    pub(super) fn keyed(
        &mut self,
        ids: &mut Ids<Id<Location>>,
    ) -> Result<Vec<Id<Location>>, Exhausted> {
        let Intent::Edit { edits, .. } = self else {
            return Ok(Vec::new());
        };
        let (keyed, keys) = ids.key_all(created(mem::take(edits)))?;
        *edits = keyed;
        Ok(keys)
    }

    /// The rows this intent adds that `store`'s map does not hold yet.
    pub(crate) fn adds_mut<'i>(
        &'i mut self,
        store: &'i Store,
    ) -> impl Iterator<Item = &'i mut Location> + 'i {
        let edits = match self {
            Intent::Edit { edits, .. } => edits.as_mut_slice(),
            _ => &mut [],
        };
        edits.iter_mut().filter_map(|edit| match edit {
            Op::Add(row) => Some(row),
            Op::Set(row) if store.get_loc_by_id(row.id).is_none() => Some(row),
            _ => None,
        })
    }

    /// This intent with no say over the details `here` keeps on its own device: where the map is
    /// filed and what plugins keep there alone, which a write from another app never changes.
    pub(crate) fn keeping_local(&mut self, here: &MapMeta) {
        match self {
            Intent::Meta(patch) => {
                patch.take_local();
            }
            Intent::Entry(entry) => {
                let local = |meta: &MapMeta| MapMeta {
                    folder: here.folder.clone(),
                    local_plugin_data: here.local_plugin_data.clone(),
                    ..meta.clone()
                };
                entry.meta = entry
                    .meta
                    .transitions()
                    .map(|t| Transition::new(t.before.map(local), t.after.map(local)))
                    .collect();
            }
            _ => {}
        }
    }

    /// The entry this intent comes to on `store`'s map, and what it did besides. A whole
    /// change applies only while the map still holds every state it starts from.
    pub(super) fn change(mut self, store: &mut Store) -> AppResult<(Entry, EditResult)> {
        let keys = self.keyed(&mut store.next_id)?;
        let edited = EditResult {
            mutation: Mutation {
                keys,
                ..Mutation::default()
            },
            ..EditResult::default()
        };
        Ok(match self {
            Intent::Edit {
                edits,
                records: incoming,
            } => {
                let mut records = HashMap::new();
                let mut remaps = HashMap::new();
                for (field, held) in incoming.into_iter().filter(|(_, held)| !held.is_empty()) {
                    let floor = store.fields().values([field.as_str()])[0].floor();
                    let before = store.records(&field);
                    let mut after = before.clone();
                    let mut named: Vec<_> = held
                        .values()
                        .filter(|record| record.unique().is_some())
                        .collect();
                    named.sort_by(|a, b| {
                        a.order
                            .unwrap_or(u32::MAX)
                            .cmp(&b.order.unwrap_or(u32::MAX))
                            .then_with(|| a.name.cmp(&b.name))
                    });
                    let adds = named.iter().map(|record| {
                        Op::Add(ValueRecord {
                            order: None,
                            ..(*record).clone()
                        })
                    });
                    let applied = mma_algebra::apply(&mut after, adds, Id::new(floor));
                    let remap: HashMap<_, _> = named
                        .iter()
                        .map(|record| record.id)
                        .zip(applied.keys)
                        .collect();
                    records.insert(
                        field.clone(),
                        Change::at(&before, &after, remap.values().copied()),
                    );
                    remaps.insert(field, remap);
                }
                let registry = store.registry();
                let mut layer = Layer::default();
                layer.write(edits.into_iter().map(|edit| {
                    registry.remap(edit, |field, id| match remaps.get(field) {
                        Some(remap) => remap.get(&id).copied(),
                        None => store
                            .records
                            .get(field)
                            .is_some_and(|records| records.contains_key(&id))
                            .then_some(id),
                    })
                }));
                let entry = Entry {
                    records,
                    ..Entry::default()
                };
                (store.entry(&layer, entry), edited)
            }
            Intent::Values { field, edits } => {
                let edits = edits
                    .into_iter()
                    .map(named)
                    .collect::<AppResult<Vec<_>>>()?;
                let (floor, held) = {
                    let fields = store.fields().values([field.as_str()]);
                    let values = &fields[0];
                    let held: Vec<Id<ValueRecord>> = values
                        .keys()
                        .into_iter()
                        .filter(|key| values.count(key) > 0)
                        .filter_map(|key| key.parse().ok().map(Id::new))
                        .collect();
                    (values.floor(), held)
                };
                let before = store.records(&field);
                let bare = |id: Id<ValueRecord>| ValueRecord {
                    id,
                    ..Default::default()
                };
                let mut after = before.clone();
                for id in held {
                    after.entry(id).or_insert_with(|| bare(id));
                }
                let applied = mma_algebra::apply(&mut after, edits, Id::new(floor));
                after.retain(|&id, rec| before.contains_key(&id) || *rec != bare(id));
                let delta = Change::between(&before, &after);
                let mut settled = (*store.meta).clone();
                let meta = if settled
                    .settings
                    .remap_values(&field, |id| survivor(&applied.redirects, id))
                {
                    Change::from_iter([Transition::new(Some((*store.meta).clone()), Some(settled))])
                } else {
                    Change::default()
                };
                let mut layer = Layer::default();
                if !applied.redirects.is_empty() {
                    let to = store.registry().assign(&field)?;
                    for row in store.all().rows() {
                        let current = row.held_ids(&field);
                        if !current.iter().any(|id| applied.redirects.contains_key(id)) {
                            continue;
                        }
                        let mut patch = Patch::<Location>::of(row.id());
                        to.write(&mut patch, row.flags(), &serde_json::json!(current))?;
                        layer.write([store.registry().remap(Op::Put(patch), |_, id| {
                            Some(survivor(&applied.redirects, id))
                        })]);
                    }
                }
                let entry = Entry {
                    records: HashMap::from_iter((!delta.is_empty()).then_some((field, delta))),
                    meta,
                    ..Default::default()
                };
                let records = applied.keys;
                (store.entry(&layer, entry), EditResult { records, ..edited })
            }
            Intent::Meta(patch) => (store.patched(&patch), edited),
            Intent::Work { selector, work } => work.change(store, &selector)?,

            Intent::Entry(entry) => {
                let mut moved = Vec::new();
                if let Err(Moved(ids)) = entry.locations.standing_on(&store.view()) {
                    let ids: Vec<String> = ids.iter().map(ToString::to_string).collect();
                    moved.push(format!("locations {}", ids.join(", ")));
                }
                for (field, delta) in &entry.records {
                    let held = store.records.get(field).map(|held| &**held);
                    if delta.standing_on(held.unwrap_or(&HashMap::new())).is_err() {
                        moved.push(format!("{field} values"));
                    }
                }
                if !moved.is_empty() {
                    return Err(AppError(format!("edited since: {}", moved.join("; "))));
                }
                let mut entry = *entry;
                if entry
                    .selections
                    .standing_on(&store.selections.table())
                    .is_err()
                {
                    entry.selections = Change::default();
                }
                if entry.defs.standing_on(&*store.field_defs).is_err() {
                    entry.defs = Change::default();
                }
                (entry, edited)
            }
        })
    }
}

impl Write for Intent {
    type Done = EditResult;

    fn route(self, _: &Store) -> Routed {
        Routed::Shared(self)
    }

    fn done(edited: EditResult) -> EditResult {
        edited
    }
}

impl Write for Patch<MapMeta> {
    type Done = Mutation;

    fn route(self, _: &Store) -> Routed {
        Routed::Shared(Intent::Meta(Box::new(self)))
    }

    fn done(edited: EditResult) -> Mutation {
        edited.mutation
    }
}

impl Store {
    /// The entry patching the map's details with `patch` comes to.
    pub(super) fn patched(&self, patch: &Patch<MapMeta>) -> Entry {
        let current = MapMeta {
            extra: maps::MapExtra {
                fields: (*self.field_defs).clone(),
            },
            ..(*self.meta).clone()
        };
        let next = current.patched(patch);
        Entry {
            meta: Change::from_iter([Transition::new(Some(current), Some(next))]),
            ..Entry::default()
        }
    }

    /// Make this store a replica whose writes go to `host`.
    pub(crate) fn replicate(&mut self, host: Arc<dyn Upstream>) {
        self.next_id.lease(IdRange::default());
        self.upstream = Some(host);
    }

    /// Stop being a replica and keep the map as this store's own, its new rows taking ids above
    /// every row it holds.
    pub(crate) fn detach(&mut self) {
        if self.upstream.take().is_some() {
            let above = Ids::above(self.all().rows().map(|row| row.id()));
            self.next_id = above;
            self.announce();
        }
    }

    /// Hand out `len` ids no row of this map holds, one after another, for rows to come here or
    /// for a replica to allocate from.
    pub(crate) fn take_run(&mut self, len: u32) -> AppResult<IdRange<Location>> {
        self.next_id
            .take_run(len)
            .map_err(|_| AppError::from("every id this map can give is taken"))
    }

    /// A run of `len` ids for new rows: this store's own, or a block its host lends a replica.
    pub(crate) fn fresh_ids(&mut self, len: u32) -> Reached<IdRange<Location>> {
        match &self.upstream {
            Some(host) => host.lease(len),
            None => Reached::ready(self.take_run(len)),
        }
    }

    /// This store, when it owns its map's content rather than following a host's.
    pub(crate) fn owned(&mut self) -> AppResult<&mut Self> {
        match self.upstream {
            Some(_) => Err("this map's content belongs to the app hosting it".into()),
            None => Ok(self),
        }
    }
}

#[cfg(test)]
#[path = "intent.test.rs"]
mod tests;
