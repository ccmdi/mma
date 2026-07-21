import type { Location } from "@/bindings.gen";
import {
	localToNormalized,
	syncHash,
	type NormalizedSyncLocation,
	type TagName,
} from "./normalized";
import type { BaseHashes, IdentityKey, SyncState } from "./diff";
import type { SyncProvider } from "./provider";
import { localKey, type RemoteMappingRow } from "./syncStore";

/**
 * Turns raw local + remote locations + the persisted mapping into the three keyed inputs the
 * diff consumes, and the lookups the apply step needs.
 *
 * Keying rule: a location already in the mapping is keyed by its stable local id (`L:<id>`);
 * an UNmapped location is keyed by its content plus an occurrence counter (`C:<hash>#<n>`).
 * The content key makes first-sync "merge" fall out of the plain diff -- identical unmapped
 * pins on both sides land on the same key and converge instead of duplicating. The counter is
 * what keeps genuine duplicates distinct: two identical unmapped pins are two keys, not one.
 */
export interface KeyedInputs<R> {
	base: BaseHashes;
	local: SyncState;
	remote: SyncState;
	/** key -> original local location (for building push payloads). */
	localById: Map<IdentityKey, Location>;
	/** key -> original remote location (for materializing pulls and addressing updates). */
	remoteById: Map<IdentityKey, R>;
	/** key -> the remote handle as read (`remoteIdOf`). Stale after a positional push. */
	remoteIndex: Map<IdentityKey, number>;
	/** Remote locations in array order, so a whole-document write can preserve it. */
	remoteOrder: [IdentityKey, R][];
}

/** Hands out `C:<hash>#0`, `C:<hash>#1`, ... so duplicate content stays distinct. */
function occurrenceKeyer(): (n: NormalizedSyncLocation) => IdentityKey {
	const seen = new Map<string, number>();
	return (n) => {
		const h = syncHash(n);
		const i = seen.get(h) ?? 0;
		seen.set(h, i + 1);
		return `C:${h}#${i}`;
	};
}

/**
 * Recover which remote location each mapping row refers to.
 *
 * For a `stable` provider this is a plain id lookup. For a `positional` one the persisted
 * "remote id" is the index we last wrote, so it is a hint rather than a handle: we confirm the
 * ones still sitting where we left them, then realign the rest by exact content hash, then by
 * panoId, and only then fall back to the bare index. Every pass is an exact match; nothing here
 * matches on proximity.
 */
function claimRemotes<R>(
	provider: SyncProvider<R>,
	remoteLocs: R[],
	remoteNorm: NormalizedSyncLocation[],
	mapping: RemoteMappingRow[],
	localById: Map<number, Location>,
): Map<number, number> {
	const claimedBy = new Map<number, number>(); // remote index -> localId
	const taken = new Set<number>();

	if (provider.identity === "stable") {
		const byRemoteId = new Map<number, number>();
		remoteLocs.forEach((item, i) => byRemoteId.set(provider.remoteIdOf(item, i), i));
		for (const row of mapping) {
			const i = byRemoteId.get(row.remoteId);
			if (i !== undefined && !taken.has(i)) {
				taken.add(i);
				claimedBy.set(i, row.localId);
			}
		}
		return claimedBy;
	}

	const claim = (i: number, localId: number) => {
		taken.add(i);
		claimedBy.set(i, localId);
	};
	let pending = mapping;
	const remoteHash = remoteNorm.map(syncHash);

	// 1. Unchanged and still at the index we wrote it to.
	pending = pending.filter((row) => {
		const i = row.remoteId;
		if (i >= 0 && i < remoteHash.length && !taken.has(i) && remoteHash[i] === row.hash) {
			claim(i, row.localId);
			return false;
		}
		return true;
	});

	// 2. Unchanged but shifted, because the remote inserted or deleted earlier in the array.
	const byHash = bucketBy(remoteHash, (h, i) => (taken.has(i) ? null : h));
	pending = pending.filter((row) => {
		const bucket = byHash.get(row.hash);
		const i = bucket?.shift();
		if (i !== undefined && !taken.has(i)) {
			claim(i, row.localId);
			return false;
		}
		return true;
	});

	// 3. Edited remotely: content no longer matches, but the pano does. Only usable when the
	//    panoId is unambiguous on both sides, otherwise it would pair the wrong pin.
	const freeByPano = bucketBy(remoteNorm, (n, i) => (taken.has(i) ? null : n.panoId));
	const pendingPanoCount = new Map<string, number>();
	for (const row of pending) {
		const p = localById.get(row.localId)?.panoId;
		if (p) pendingPanoCount.set(p, (pendingPanoCount.get(p) ?? 0) + 1);
	}
	pending = pending.filter((row) => {
		const p = localById.get(row.localId)?.panoId;
		if (!p || pendingPanoCount.get(p) !== 1) return true;
		const bucket = freeByPano.get(p);
		if (bucket?.length !== 1) return true;
		claim(bucket[0]!, row.localId);
		return false;
	});

	// 4. Edited remotely with no pano to match on. The bare index is only trustworthy when the
	//    array did not change length -- any insert or delete invalidates it.
	if (remoteLocs.length === mapping.length) {
		for (const row of pending) {
			const i = row.remoteId;
			if (i >= 0 && i < remoteLocs.length && !taken.has(i)) claim(i, row.localId);
		}
	}

	return claimedBy;
}

/** Group indices by a key, skipping entries the selector maps to null. */
function bucketBy<T>(
	items: T[],
	keyOf: (item: T, i: number) => string | null | undefined,
): Map<string, number[]> {
	const out = new Map<string, number[]>();
	items.forEach((item, i) => {
		const k = keyOf(item, i);
		if (k == null) return;
		const bucket = out.get(k);
		if (bucket) bucket.push(i);
		else out.set(k, [i]);
	});
	return out;
}

export function buildKeyedInputs<R>(
	provider: SyncProvider<R>,
	localLocs: Location[],
	remoteLocs: R[],
	mapping: RemoteMappingRow[],
	tagName: TagName,
): KeyedInputs<R> {
	const base = new Map<IdentityKey, string>();
	const mappedLocal = new Set<number>();
	for (const row of mapping) {
		mappedLocal.add(row.localId);
		base.set(localKey(row.localId), row.hash);
	}

	const localIndex = new Map<number, Location>();
	for (const loc of localLocs) localIndex.set(loc.id, loc);

	const local = new Map<IdentityKey, NormalizedSyncLocation>();
	const localById = new Map<IdentityKey, Location>();
	const localContentKey = occurrenceKeyer();
	const project = provider.project ?? ((n: NormalizedSyncLocation) => n);
	for (const loc of localLocs) {
		if (provider.includeLocal && !provider.includeLocal(loc)) continue;
		const norm = project(localToNormalized(loc, tagName));
		const key = mappedLocal.has(loc.id) ? localKey(loc.id) : localContentKey(norm);
		local.set(key, norm);
		localById.set(key, loc);
	}

	const remoteNorm = remoteLocs.map((r) => provider.normalize(r));
	const claimedBy = claimRemotes(provider, remoteLocs, remoteNorm, mapping, localIndex);

	const remote = new Map<IdentityKey, NormalizedSyncLocation>();
	const remoteById = new Map<IdentityKey, R>();
	const remoteIndex = new Map<IdentityKey, number>();
	const remoteOrder: [IdentityKey, R][] = [];
	const remoteContentKey = occurrenceKeyer();
	remoteLocs.forEach((item, i) => {
		const norm = remoteNorm[i]!;
		const claimed = claimedBy.get(i);
		const key = claimed !== undefined ? localKey(claimed) : remoteContentKey(norm);
		remote.set(key, norm);
		remoteById.set(key, item);
		remoteIndex.set(key, provider.remoteIdOf(item, i));
		remoteOrder.push([key, item]);
	});

	return { base, local, remote, localById, remoteById, remoteIndex, remoteOrder };
}
