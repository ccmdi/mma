//! Delta-chain version control core.
//!
//! Each commit's payload is a single Arrow delta file on disk
//! (`arrow/commits/<map_id>/<commit_id>.arrow`); SQL only tracks the commit graph.
//! A commit's full state is materialized by replaying its ancestor delta files
//! from genesis forward.

use crate::store::maps::MapMeta;
use crate::store::vcs::CommitInfo;
use crate::types::{AppResult, Location};
use mma_algebra::{Change, Id};
use std::collections::BTreeMap;

use rusqlite::{params, Connection};

use crate::store::vcs;

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
/// An id on both sides of a delta is an in-place update to its created value.
pub(crate) fn replay_deltas(
    deltas: impl IntoIterator<Item = (Vec<Location>, Vec<Location>)>,
) -> BTreeMap<Id<Location>, Location> {
    let mut state = BTreeMap::new();
    for (created, removed) in deltas {
        Change::from_sides(created, removed).apply_to(&mut state);
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
    Ok(replay_deltas(deltas))
}

#[cfg(test)]
#[path = "delta.test.rs"]
mod tests;
