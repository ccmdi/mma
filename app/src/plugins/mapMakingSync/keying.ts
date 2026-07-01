import type { Location } from "@/bindings.gen";
import {
	localToNormalized,
	remoteToNormalized,
	syncHash,
	type NormalizedSyncLocation,
	type TagName,
} from "./adapter";
import type * as Remote from "./remote-types";
import type { BaseHashes, IdentityKey, SyncState } from "./diff";
import { localKey, type RemoteMappingRow } from "./syncStore";

/**
 * Turns raw local + remote locations + the persisted mapping into the three keyed inputs the
 * diff consumes, and the lookups the apply step needs.
 *
 * Keying rule: a location already in the mapping is keyed by its stable local id (`L:<id>`);
 * an UNmapped location is keyed by its content (`C:<hash>`). That content key makes first-sync
 * "merge" fall out of the plain diff -- identical unmapped pins on both sides land on the same
 * key and converge (adopt) instead of duplicating; genuinely one-sided pins get their own key.
 */
export interface KeyedInputs {
	base: BaseHashes;
	local: SyncState;
	remote: SyncState;
	/** key -> original local location (for building push payloads). */
	localById: Map<IdentityKey, Location>;
	/** key -> original remote location (for materializing pulls). */
	remoteById: Map<IdentityKey, Remote.Location>;
}

const contentKey = (n: NormalizedSyncLocation): IdentityKey => `C:${syncHash(n)}`;

export function buildKeyedInputs(
	localLocs: Location[],
	remoteLocs: Remote.Location[],
	mapping: RemoteMappingRow[],
	tagName: TagName,
): KeyedInputs {
	const base = new Map<IdentityKey, string>();
	const mappedLocal = new Set<number>();
	const remoteToLocal = new Map<number, number>();
	for (const row of mapping) {
		mappedLocal.add(row.localId);
		remoteToLocal.set(row.remoteId, row.localId);
		base.set(localKey(row.localId), row.hash);
	}

	const local = new Map<IdentityKey, NormalizedSyncLocation>();
	const localById = new Map<IdentityKey, Location>();
	for (const loc of localLocs) {
		const norm = localToNormalized(loc, tagName);
		const key = mappedLocal.has(loc.id) ? localKey(loc.id) : contentKey(norm);
		local.set(key, norm);
		localById.set(key, loc);
	}

	const remote = new Map<IdentityKey, NormalizedSyncLocation>();
	const remoteById = new Map<IdentityKey, Remote.Location>();
	for (const loc of remoteLocs) {
		const norm = remoteToNormalized(loc);
		const mappedId = remoteToLocal.get(loc.id);
		const key = mappedId !== undefined ? localKey(mappedId) : contentKey(norm);
		remote.set(key, norm);
		remoteById.set(key, loc);
	}

	return { base, local, remote, localById, remoteById };
}
