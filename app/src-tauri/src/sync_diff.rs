//! Three-way merge over identity keys.
//! Pure: no IO, no provider knowledge. The engine feeds it base/local/remote and applies the plan.

use crate::sync::{
    sync_hash, sync_key, Conflict, ConflictKind, IdentityKey, NormalizedSyncLocation, SideCounts,
    SidePlan, SyncPlan,
};
use std::collections::{HashMap, HashSet};

#[derive(PartialEq, Eq, Clone, Copy)]
enum Change {
    None,
    Added,
    Removed,
    Modified,
}

fn classify(base_hash: Option<&String>, cur: Option<&NormalizedSyncLocation>) -> Change {
    match (base_hash, cur) {
        (None, None) => Change::None,
        (None, Some(_)) => Change::Added,
        (Some(_), None) => Change::Removed,
        (Some(b), Some(c)) => {
            if sync_hash(c) == *b {
                Change::None
            } else {
                Change::Modified
            }
        }
    }
}

fn record(side: &mut SidePlan, change: Change, key: &IdentityKey) {
    match change {
        Change::Added => side.create.push(key.clone()),
        Change::Modified => side.update.push(key.clone()),
        Change::Removed => side.delete.push(key.clone()),
        Change::None => {}
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

        if lc == Change::None && rc == Change::None {
            continue;
        }
        if rc == Change::None {
            record(&mut plan.push, lc, key); // only local moved
            continue;
        }
        if lc == Change::None {
            record(&mut plan.pull, rc, key); // only remote moved
            continue;
        }

        // Both sides moved since base.
        if lc == Change::Removed && rc == Change::Removed {
            plan.converged.push(key.clone()); // both deleted -> agree
            continue;
        }
        if lc == Change::Removed || rc == Change::Removed {
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
            kind: if lc == Change::Added && rc == Change::Added {
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
    pub conflicts: u32,
    pub converged: u32,
    /// Actionable items (push + pull + conflicts); excludes converged base-only advances.
    pub actionable: u32,
}

pub(crate) fn summarize(plan: &SyncPlan) -> SyncPlanCounts {
    let side = |s: &SidePlan| SideCounts {
        create: s.create.len() as u32,
        update: s.update.len() as u32,
        delete: s.delete.len() as u32,
    };
    let push = side(&plan.push);
    let pull = side(&plan.pull);
    let conflicts = plan.conflicts.len() as u32;
    let actionable = push.create
        + push.update
        + push.delete
        + pull.create
        + pull.update
        + pull.delete
        + conflicts;
    SyncPlanCounts {
        push,
        pull,
        conflicts,
        converged: plan.converged.len() as u32,
        actionable,
    }
}

/// True when there is nothing to push, pull, or resolve (converged base advances are not actionable).
pub(crate) fn is_noop(plan: &SyncPlan) -> bool {
    summarize(plan).actionable == 0
}

#[cfg(test)]
#[path = "sync_diff.test.rs"]
mod tests;
