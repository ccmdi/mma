import { cmd } from "@/lib/commands";

/** Stable identity for a synced location across runs (e.g. `"L:<localId>"`). */
export type IdentityKey = string;

/**
 * Durable sync metadata for one linked map. The bulk -- the per-location `localId <-> remoteId`
 * mapping plus a content fingerprint -- lives in SQLite via the `remote_mapping` table
 * (row-oriented, so only changed rows write per sync).
 *
 * Identity is anchored on the LOCAL id: a remote id changes whenever its location is modified
 * (verified), so `remoteId`/`hash` are rewritten from each push's id-remap response while the
 * local id stays put.
 */

export interface SyncLink {
	/** Fresh for every link, so relinking reads as a different link even to the same remote at the same instant. */
	id: string;
	localMapId: string;
	/** String because providers differ: map-making.app uses an integer, GeoGuessr a hex slug. */
	remoteMapId: string;
	/** Display name captured at link time, so the UI doesn't need a fetch to say what it's linked to. */
	remoteMapName: string;
	remoteUserId: string | null;
	linkedAt: string;
	lastSyncedAt: string | null;
}

/** Tiny KV surface for the link singleton (matches `MMA.storage(pluginId)`). */
export interface KeyValueStore {
	get<T = unknown>(key: string, fallback?: T): T;
	set(key: string, value: unknown): void;
	remove(key: string): void;
	keys(): string[];
}

/** Sole owner of the link key format. `listLinks` depends on it being prefix-scannable. */
const linkKey = (provider: string, localMapId: string): string => `link:${provider}:${localMapId}`;

/** Every map this provider holds a link for. Includes links to since-deleted maps. */
export function listLinks(kv: KeyValueStore, provider: string): SyncLink[] {
	const prefix = linkKey(provider, "");
	return kv
		.keys()
		.filter((k) => k.startsWith(prefix))
		.map((k) => kv.get<SyncLink | null>(k, null))
		.filter((l): l is SyncLink => l !== null);
}

export interface SyncStore {
	getLink(): SyncLink | null;
	setLink(link: SyncLink | null): void;
	/** Drop all sync metadata for this map (unlink): the link and every mapping row. */
	clear(): Promise<void>;
}

/**
 * SyncStore for one `(provider, localMapId)`. The link is namespaced in the KV store; the mapping
 * rows live in the backend, already scoped by provider + map.
 */
export function createSyncStore(
	kv: KeyValueStore,
	provider: string,
	localMapId: string,
): SyncStore {
	const key = linkKey(provider, localMapId);

	return {
		getLink: () => kv.get<SyncLink | null>(key, null),
		setLink: (link) => (link === null ? kv.remove(key) : kv.set(key, link)),
		clear: async () => {
			kv.remove(key);
			await cmd.remoteMappingClear(provider, localMapId);
		},
	};
}
