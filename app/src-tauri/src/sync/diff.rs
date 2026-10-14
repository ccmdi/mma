//! Three-way merge over identity keys.
//! Pure: no IO, no provider knowledge. The engine feeds it base/local/remote and applies the plan.

use crate::sync::{
    sync_hash, sync_key, Conflict, ConflictKind, IdentityKey, NormalizedSyncLocation, SideCounts,
    SidePlan, SyncPlan,
};
use std::collections::{HashMap, HashSet};

#[derive(PartialEq, Eq, Clone, Copy)]
enum RowDiff {
    Unchanged,
    Added,
    Removed,
    Updated,
}

fn classify(base_hash: Option<&String>, cur: Option<&NormalizedSyncLocation>) -> RowDiff {
    match (base_hash, cur) {
        (None, None) => RowDiff::Unchanged,
        (None, Some(_)) => RowDiff::Added,
        (Some(_), None) => RowDiff::Removed,
        (Some(b), Some(c)) => {
            if sync_hash(c) == *b {
                RowDiff::Unchanged
            } else {
                RowDiff::Updated
            }
        }
    }
}

fn record(side: &mut SidePlan, change: RowDiff, key: &IdentityKey) {
    match change {
        RowDiff::Added => side.create.push(key.clone()),
        RowDiff::Updated => side.update.push(key.clone()),
        RowDiff::Removed => side.delete.push(key.clone()),
        RowDiff::Unchanged => {}
    }
}

/// Three-way merge over identity keys. For each key in base ∪ local ∪ remote, compares each side
/// against the base snapshot and routes it: only-local-changed -> push, only-remote-changed -> pull,
/// both-changed-and-equal -> converged, both-changed-and-different -> conflict.
pub(crate) fn compute_sync_plan(
    base: &HashMap<IdentityKey, String>,
    local: &HashMap<IdentityKey, NormalizedSyncLocation>,
    remote: &HashMap<IdentityKey, NormalizedSyncLocation>,
) -> SyncPlan {
    let mut plan = SyncPlan::default();

    let keys: HashSet<&IdentityKey> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();

    for key in keys {
        let b = base.get(key);
        let l = local.get(key);
        let r = remote.get(key);
        let lc = classify(b, l);
        let rc = classify(b, r);

        if lc == RowDiff::Unchanged && rc == RowDiff::Unchanged {
            continue;
        }
        if rc == RowDiff::Unchanged {
            record(&mut plan.push, lc, key); // only local moved
            continue;
        }
        if lc == RowDiff::Unchanged {
            record(&mut plan.pull, rc, key); // only remote moved
            continue;
        }

        // Both sides moved since base.
        if lc == RowDiff::Removed && rc == RowDiff::Removed {
            plan.converged.push(key.clone()); // both deleted -> agree
            continue;
        }
        if lc == RowDiff::Removed || rc == RowDiff::Removed {
            plan.conflicts.push(Conflict {
                key: key.clone(),
                kind: ConflictKind::DeleteUpdate,
                local: l.cloned(),
                remote: r.cloned(),
            });
            continue;
        }
        if let (Some(lv), Some(rv)) = (l, r) {
            if sync_key(lv) == sync_key(rv) {
                plan.converged.push(key.clone()); // both moved to the same value
                continue;
            }
        }
        plan.conflicts.push(Conflict {
            key: key.clone(),
            kind: if lc == RowDiff::Added && rc == RowDiff::Added {
                ConflictKind::AddAdd
            } else {
                ConflictKind::UpdateUpdate
            },
            local: l.cloned(),
            remote: r.cloned(),
        });
    }
    plan
}

pub(crate) struct SyncPlanCounts {
    pub push: SideCounts,
    pub pull: SideCounts,
}

pub(crate) fn summarize(plan: &SyncPlan) -> SyncPlanCounts {
    let side = |s: &SidePlan| SideCounts {
        create: s.create.len() as u32,
        update: s.update.len() as u32,
        delete: s.delete.len() as u32,
    };
    SyncPlanCounts {
        push: side(&plan.push),
        pull: side(&plan.pull),
    }
}

#[cfg(test)]
#[path = "diff.test.rs"]
mod tests;
