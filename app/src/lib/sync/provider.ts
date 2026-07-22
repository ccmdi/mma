import type { Location } from "@/bindings.gen";
import type { NormalizedSyncLocation, TagName } from "./normalized";

/**
 * How a provider identifies a location across syncs. This is the one structural difference
 * between the backends we support, and it decides how {@link keying} recovers identity.
 *
 *  - `stable`     the remote id addresses a location authoritatively. It may change when the
 *                 location is edited (map-making.app churns it), but at any instant it is a
 *                 real handle we can update or delete by.
 *  - `positional` there is no remote id; the "id" we persist is the location's index in the
 *                 array we last wrote. Trustworthy only while that array is untouched, so a
 *                 pull re-verifies each index by hash and realigns the ones that moved.
 */
export type IdentityModel = "stable" | "positional";

export interface RemoteMapSummary {
	id: string;
	name: string;
	/** `null` when the provider's listing does not carry a count. */
	locationCount: number | null;
	/** Set when this map exists but cannot be linked, with a user-facing reason. */
	unsupported?: string;
}

/** A pull: the provider's raw locations plus whatever it needs echoed back on the next push. */
export interface RemoteSnapshot<R> {
	locations: R[];
	/**
	 * Opaque concurrency handle passed straight back to {@link SyncProvider.push} (GeoGuessr's
	 * draft `version`). `undefined` for providers without one.
	 */
	token?: unknown;
}

/** One entry of the full desired remote state, tagged with the local id it represents. */
export interface DesiredEntry<R> {
	item: R;
	/** `null` for remote-only locations we are passing through untouched. */
	localId: number | null;
}

/**
 * A push expressed two ways. Both describe the same outcome; a provider uses whichever its API
 * speaks and ignores the other.
 *  - `create`/`update`/`delete` for APIs that take a delta (map-making.app's edit batch).
 *  - `desired` for APIs that replace the whole document (GeoGuessr's draft PUT). Remote-only
 *    locations appear verbatim so provider fields we don't model survive the round trip.
 */
export interface PushBatch<R> {
	create: { localId: number; item: R }[];
	update: { localId: number; item: R; replaces: R }[];
	delete: R[];
	/** Complete desired remote state, in the order it should be written. */
	desired: DesiredEntry<R>[];
}

/**
 * What a push resolved each location to. The engine attaches hashes itself.
 *
 * A `stable` provider returns one entry per location it created or updated. A `positional`
 * provider must return an entry for EVERY `desired` entry with a non-null localId, because
 * rewriting the document reindexes everything -- entries it did not touch included.
 */
export interface PushedId {
	localId: number;
	remoteId: number;
}

export interface PushContext {
	/** The concurrency handle from the matching {@link RemoteSnapshot}. */
	token: unknown;
	signal?: AbortSignal;
	/**
	 * Report ids as they are confirmed, for a provider that writes in more than one request. The
	 * engine persists each report immediately, so a failure part-way through leaves a consistent
	 * partial mapping that the next sync finishes -- rather than orphaned remote locations that
	 * get created again on every subsequent sync.
	 *
	 * Providers that write atomically can ignore this and just return their ids.
	 */
	onProgress?(pushed: PushedId[]): Promise<void>;
}

/**
 * Everything sync needs to know about one remote backend. The engine owns the three-way merge
 * and all persistence; a provider only knows how to talk to its API and how to convert between
 * its own location shape and the normalized contract.
 *
 * `R` is the provider's raw location type, which the engine treats as opaque.
 */
export interface SyncProvider<R> {
	/** Persisted as the `provider` column of `remote_mapping`. Never change it for a shipped provider. */
	readonly id: string;
	readonly label: string;
	readonly identity: IdentityModel;

	/** Whether the provider round-trips per-location tags. When false the engine never pulls tags. */
	readonly supportsTags: boolean;

	/** Maps the signed-in user can link to. */
	listMaps(signal?: AbortSignal): Promise<RemoteMapSummary[]>;

	pull(remoteMapId: string, signal?: AbortSignal): Promise<RemoteSnapshot<R>>;

	push(remoteMapId: string, batch: PushBatch<R>, ctx: PushContext): Promise<PushedId[]>;

	/**
	 * Stable handle for a remote location. Return the provider's own id when `identity` is
	 * `stable`; return `index` when it is `positional`.
	 */
	remoteIdOf(item: R, index: number): number;

	/**
	 * Project a remote location onto the synced contract. Must exclude server-derived fields,
	 * and must return already-{@link project}ed values.
	 */
	normalize(item: R): NormalizedSyncLocation;

	/**
	 * Collapse a normalized location into what this provider can actually store, applied to the
	 * LOCAL side before diffing so that a distinction the remote cannot hold never registers as a
	 * difference. GeoGuessr, for instance, has no equivalent of "keep the panoId but don't load by
	 * it", so both sides must be compared with that distinction erased -- otherwise every such
	 * location reports as modified on every sync, forever.
	 *
	 * Optional; the identity projection is used when omitted. Pulls patch only the fields that
	 * genuinely differ, so a field erased here is never written back over local data.
	 */
	project?(loc: NormalizedSyncLocation): NormalizedSyncLocation;

	/**
	 * Whether a local location participates in sync at all. Excluded locations are invisible to
	 * the diff, so one that was already pushed and then excluded correctly reads as a delete.
	 * Defaults to including everything. GeoGuessr uses this to keep Informational pins -- which
	 * are editor annotations, not places -- out of a playable map.
	 */
	includeLocal?(loc: Location): boolean;

	/**
	 * Build the provider's own location shape from the contract. `tagName` is supplied for
	 * providers that carry tags; ignore it otherwise.
	 */
	materialize(loc: NormalizedSyncLocation, tagName: TagName): R;
}
