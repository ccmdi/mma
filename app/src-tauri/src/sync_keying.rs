//! Identity keying and positional realignment.
//! Turns raw local + remote locations plus the persisted mapping into the three keyed inputs the
//! diff consumes, and the lookups the apply step needs.
//!
//! Keying rule: a location already in the mapping is keyed by its stable local id (`L:<id>`); an
//! UNmapped one is keyed by content plus a per-side occurrence counter (`C:<hash>#<n>`). The content
//! key makes first-sync "merge" fall out of the plain diff; the counter keeps genuine duplicates
//! distinct: two identical unmapped pins are two keys, not one.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::remote_mapping::RemoteMappingRow;
use crate::sync::SyncLocalPin;
use crate::sync::{
    local_key, local_to_normalized, sync_hash, IdentityKey, IdentityModel, NormalizedSyncLocation,
    SyncProvider,
};

/// The keyed inputs the diff consumes plus the lookups the apply step needs.
/// Raw remote items are referenced by INDEX into the remote_locs slice, not cloned.
pub(crate) struct KeyedInputs {
    pub base: HashMap<IdentityKey, String>,
    pub local: HashMap<IdentityKey, NormalizedSyncLocation>,
    pub remote: HashMap<IdentityKey, NormalizedSyncLocation>,
    /// key -> durable local id.
    pub local_id_of: HashMap<IdentityKey, u32>,
    /// key -> index into the remote_locs slice (for push payloads / update addressing).
    pub remote_item_of: HashMap<IdentityKey, usize>,
    /// key -> the remote handle as read (remote_id_of). Stale after a positional push.
    pub remote_handle_of: HashMap<IdentityKey, i64>,
    /// Remote keys in array order, with their remote_locs index.
    pub remote_order: Vec<(IdentityKey, usize)>,
}

/// Hands out `C:<hash>#0`, `C:<hash>#1`, ... so duplicate content stays distinct.
struct OccurrenceKeyer {
    seen: HashMap<String, u32>,
}

impl OccurrenceKeyer {
    fn new() -> Self {
        Self {
            seen: HashMap::new(),
        }
    }

    fn key(&mut self, n: &NormalizedSyncLocation) -> IdentityKey {
        let h = sync_hash(n);
        let slot = self.seen.entry(h.clone()).or_insert(0);
        let i = *slot;
        *slot += 1;
        format!("C:{h}#{i}")
    }
}

/// Group indices by a key, in array order, skipping entries the selector maps to None.
fn bucket_by<T>(
    items: &[T],
    key_of: impl Fn(usize, &T) -> Option<String>,
) -> HashMap<String, VecDeque<usize>> {
    let mut out: HashMap<String, VecDeque<usize>> = HashMap::new();
    for (i, item) in items.iter().enumerate() {
        if let Some(k) = key_of(i, item) {
            out.entry(k).or_default().push_back(i);
        }
    }
    out
}

/// Recover which remote location each mapping row refers to (remote index -> local id).
///
/// For a `Stable` provider this is a plain id lookup. For a `Positional` one the persisted
/// "remote id" is the index we last wrote, so it is a hint rather than a handle: confirm the ones
/// still sitting where we left them, then realign the rest by exact content hash, then by panoId,
/// and only then fall back to the bare index. Every pass is an exact match; nothing matches on
/// proximity.
fn claim_remotes<P: SyncProvider>(
    provider: &P,
    remote_locs: &[P::Raw],
    remote_norm: &[NormalizedSyncLocation],
    mapping: &[RemoteMappingRow],
    local_by_id: &HashMap<u32, &SyncLocalPin>,
) -> HashMap<usize, u32> {
    let mut claimed_by: HashMap<usize, u32> = HashMap::new();
    let mut taken: HashSet<usize> = HashSet::new();

    if provider.identity() == IdentityModel::Stable {
        let mut by_remote_id: HashMap<i64, usize> = HashMap::new();
        for (i, item) in remote_locs.iter().enumerate() {
            by_remote_id.insert(provider.remote_id_of(item, i), i);
        }
        for row in mapping {
            if let Some(&i) = by_remote_id.get(&row.remote_id) {
                if !taken.contains(&i) {
                    taken.insert(i);
                    claimed_by.insert(i, row.local_id);
                }
            }
        }
        return claimed_by;
    }

    let in_range = |i: i64, len: usize| i >= 0 && (i as u64) < len as u64;
    let mut pending: Vec<&RemoteMappingRow> = mapping.iter().collect();
    let remote_hash: Vec<String> = remote_norm.iter().map(sync_hash).collect();

    // 1. Unchanged and still at the index we wrote it to.
    pending.retain(|row| {
        if in_range(row.remote_id, remote_hash.len()) {
            let i = row.remote_id as usize;
            if !taken.contains(&i) && remote_hash[i] == row.hash {
                taken.insert(i);
                claimed_by.insert(i, row.local_id);
                return false;
            }
        }
        true
    });

    // 2. Unchanged but shifted, because the remote inserted or deleted earlier in the array.
    let mut by_hash = bucket_by(&remote_hash, |i, h| {
        if taken.contains(&i) {
            None
        } else {
            Some(h.clone())
        }
    });
    pending.retain(|row| {
        if let Some(bucket) = by_hash.get_mut(&row.hash) {
            if let Some(i) = bucket.pop_front() {
                if !taken.contains(&i) {
                    taken.insert(i);
                    claimed_by.insert(i, row.local_id);
                    return false;
                }
            }
        }
        true
    });

    // 3. Edited remotely: content no longer matches, but the pano does. Only usable when the panoId
    //    is unambiguous on both sides, otherwise it would pair the wrong pin. The local panoId comes
    //    from the ORIGINAL local location, not the normalized form.
    let free_by_pano = bucket_by(remote_norm, |i, n| {
        if taken.contains(&i) {
            None
        } else {
            n.pano_id.clone()
        }
    });
    let mut pending_pano_count: HashMap<String, u32> = HashMap::new();
    for row in &pending {
        if let Some(p) = local_by_id
            .get(&row.local_id)
            .and_then(|l| l.pano_id.clone())
        {
            *pending_pano_count.entry(p).or_insert(0) += 1;
        }
    }
    pending.retain(|row| {
        let p = match local_by_id
            .get(&row.local_id)
            .and_then(|l| l.pano_id.clone())
        {
            Some(p) => p,
            None => return true,
        };
        if pending_pano_count.get(&p) != Some(&1) {
            return true;
        }
        match free_by_pano.get(&p) {
            Some(bucket) if bucket.len() == 1 => {
                let i = bucket[0];
                taken.insert(i);
                claimed_by.insert(i, row.local_id);
                false
            }
            _ => true,
        }
    });

    // 4. Edited remotely with no pano to match on. The bare index is only trustworthy when the array
    //    did not change length -- any insert or delete invalidates it.
    if remote_locs.len() == mapping.len() {
        for row in &pending {
            if in_range(row.remote_id, remote_locs.len()) {
                let i = row.remote_id as usize;
                if !taken.contains(&i) {
                    taken.insert(i);
                    claimed_by.insert(i, row.local_id);
                }
            }
        }
    }

    claimed_by
}

pub(crate) fn build_keyed_inputs<P: SyncProvider>(
    provider: &P,
    local_locs: &[SyncLocalPin],
    remote_locs: &[P::Raw],
    mapping: &[RemoteMappingRow],
    tag_name: &impl Fn(u32) -> Option<String>,
) -> KeyedInputs {
    let mut base: HashMap<IdentityKey, String> = HashMap::new();
    let mut mapped_local: HashSet<u32> = HashSet::new();
    for row in mapping {
        mapped_local.insert(row.local_id);
        base.insert(local_key(row.local_id), row.hash.clone());
    }

    let mut local_index: HashMap<u32, &SyncLocalPin> = HashMap::new();
    for loc in local_locs {
        local_index.insert(loc.id, loc);
    }

    let mut local: HashMap<IdentityKey, NormalizedSyncLocation> = HashMap::new();
    let mut local_id_of: HashMap<IdentityKey, u32> = HashMap::new();
    let mut local_keyer = OccurrenceKeyer::new();
    for loc in local_locs {
        if !provider.include_local(loc) {
            continue;
        }
        let norm = provider.project(local_to_normalized(loc, tag_name));
        let key = if mapped_local.contains(&loc.id) {
            local_key(loc.id)
        } else {
            local_keyer.key(&norm)
        };
        local.insert(key.clone(), norm);
        local_id_of.insert(key, loc.id);
    }

    let remote_norm: Vec<NormalizedSyncLocation> =
        remote_locs.iter().map(|r| provider.normalize(r)).collect();
    let claimed_by = claim_remotes(provider, remote_locs, &remote_norm, mapping, &local_index);

    let mut remote: HashMap<IdentityKey, NormalizedSyncLocation> = HashMap::new();
    let mut remote_item_of: HashMap<IdentityKey, usize> = HashMap::new();
    let mut remote_handle_of: HashMap<IdentityKey, i64> = HashMap::new();
    let mut remote_order: Vec<(IdentityKey, usize)> = Vec::new();
    let mut remote_keyer = OccurrenceKeyer::new();
    // Consumes remote_norm: avoids a second cloned copy of every normalized form.
    for (i, (item, norm)) in remote_locs.iter().zip(remote_norm).enumerate() {
        let key = match claimed_by.get(&i) {
            Some(&local_id) => local_key(local_id),
            None => remote_keyer.key(&norm),
        };
        remote.insert(key.clone(), norm);
        remote_item_of.insert(key.clone(), i);
        remote_handle_of.insert(key.clone(), provider.remote_id_of(item, i));
        remote_order.push((key, i));
    }

    KeyedInputs {
        base,
        local,
        remote,
        local_id_of,
        remote_item_of,
        remote_handle_of,
        remote_order,
    }
}

#[cfg(test)]
#[path = "sync_keying.test.rs"]
mod tests;
