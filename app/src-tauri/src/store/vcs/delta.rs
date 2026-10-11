//! Delta-chain version control core.
//!
//! Each commit's payload is a single Arrow delta file on disk
//! (`arrow/commits/<map_id>/<commit_id>.arrow`); SQL only tracks the commit graph.
//! A commit's full state is materialized by replaying its ancestor delta files
//! from genesis forward. `diff_states` produces the delta between two states.

use crate::store::maps::MapMeta;
use crate::store::vcs::CommitInfo;
use crate::types::{AppResult, Location};
use mma_algebra::{Id, Transition};
use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};

use crate::store::{engine, vcs};

/// Ordered chain of commit ids from genesis (first) to `commit_id` (last),
/// walked via `parent_id` links.
fn commit_chain(
    conn: &Connection,
    commit_id: &Id<CommitInfo, String>,
) -> AppResult<Vec<Id<CommitInfo, String>>> {
    let mut chain = Vec::new();
    let mut current = Some(commit_id.clone());
    while let Some(id) = current {
        let parent: Option<Id<CommitInfo, String>> = conn.query_row(
            "SELECT parent_id FROM commits WHERE id = ?1",
            params![id.raw()],
            |r| r.get::<_, Option<String>>(0).map(|id| id.map(Id::new)),
        )?;
        chain.push(id);
        current = parent;
    }
    chain.reverse();
    Ok(chain)
}

/// Fold delta `(created, removed)` pairs in genesis-first order into a final state.
/// `removed` ids are dropped, then `created` (which includes updated rows) inserted,
/// so an in-place update (same id in both) resolves to the created value.
pub(crate) fn replay_deltas(
    deltas: &[(Vec<Location>, Vec<Location>)],
) -> BTreeMap<Id<Location>, Location> {
    let mut state: BTreeMap<Id<Location>, Location> = BTreeMap::new();
    for (created, removed) in deltas {
        for loc in removed {
            state.remove(&loc.id);
        }
        for loc in created {
            state.insert(loc.id, loc.clone());
        }
    }
    state
}

/// Materialize the full location set captured by `commit_id` by replaying its
/// ancestor delta files from genesis forward. Locations are keyed (and thus
/// returned sorted) by id.
pub(crate) fn materialize_commit(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
    commit_id: &Id<CommitInfo, String>,
) -> AppResult<BTreeMap<Id<Location>, Location>> {
    let chain = commit_chain(conn, commit_id)?;
    let mut deltas = Vec::with_capacity(chain.len());
    for id in &chain {
        deltas.push(vcs::read_commit_delta(map_id, id)?);
    }
    Ok(replay_deltas(&deltas))
}

/// The change from `parent` state to `current` state.
pub(crate) fn diff_states(
    parent: &BTreeMap<Id<Location>, Location>,
    current: &[Location],
) -> engine::Change {
    let current: BTreeMap<Id<Location>, &Location> = current.iter().map(|l| (l.id, l)).collect();
    let ids: BTreeSet<Id<Location>> = parent.keys().chain(current.keys()).copied().collect();
    ids.into_iter()
        .map(|id| {
            Transition::new(
                parent.get(&id).cloned(),
                current.get(&id).map(|l| (*l).clone()),
            )
        })
        .collect()
}

#[cfg(test)]
#[path = "delta.test.rs"]
mod tests;
