import type { Location } from "@/bindings.gen";
import { VIRTUAL_FLAGS } from "@/types";
import * as Remote from "./remote-types";

/**
 * The syncable contract.
 *   - local only:   id, createdAt, modifiedAt, extra
 *   - remote only: author, panoDate, createdAt (server ISO)
 *   - NOTE: tag color/order/visibility registry is web-app-managed, not known to be API-writable
 *
 * Two locations are "the same" iff their normalized forms are equal (see {@link syncKey}).
 */
export interface NormalizedSyncLocation {
	lat: number;
	lng: number;
	heading: number;
	pitch: number;
	/** Unpanned is `0`; remote `null` normalizes to `0`. */
	zoom: number;
	panoId: string | null;
	/** Remote-meaningful bits only; our JS-only virtual bits are stripped. */
	flags: number;
	/** Tag names, deduped and sorted. */
	tags: string[];
}

/** Resolve a local tag id to its name. `undefined` for unknown ids (dropped). */
export type TagName = (tagId: number) => string | undefined;
/** Resolve a remote tag name to a local tag id. `undefined` if not present locally (dropped). */
export type TagId = (tagName: string) => number | undefined;

/** Strip JS-only virtual flags so only bits the remote understands survive. */
const remoteFlags = (flags: number): number => flags & ~VIRTUAL_FLAGS;

const canonTags = (names: string[]): string[] => [...new Set(names)].sort();

const namesOf = (tagIds: number[], tagName: TagName): string[] =>
	canonTags(tagIds.map(tagName).filter((n): n is string => n != null));

// --- Normalization contract ---

export function localToNormalized(loc: Location, tagName: TagName): NormalizedSyncLocation {
	return {
		lat: loc.lat,
		lng: loc.lng,
		heading: loc.heading,
		pitch: loc.pitch,
		zoom: loc.zoom,
		panoId: loc.panoId,
		flags: remoteFlags(loc.flags),
		tags: namesOf(loc.tags, tagName),
	};
}

export function remoteToNormalized(loc: Remote.Location): NormalizedSyncLocation {
	return {
		lat: loc.location.lat,
		lng: loc.location.lng,
		heading: loc.heading,
		pitch: loc.pitch,
		zoom: loc.zoom ?? 0,
		panoId: loc.panoId,
		flags: remoteFlags(loc.flags),
		tags: canonTags(loc.tags),
	};
}

/** Canonical comparable key. Equal keys == same location on the synced contract. */
export function syncKey(n: NormalizedSyncLocation): string {
	return JSON.stringify([n.lat, n.lng, n.heading, n.pitch, n.zoom, n.panoId, n.flags, n.tags]);
}

export const syncEqual = (a: NormalizedSyncLocation, b: NormalizedSyncLocation): boolean =>
	syncKey(a) === syncKey(b);

// cyrb53: fast, non-cryptographic 53-bit string hash (collision odds are ~1e-6 at 40k locations) - ~11 chars persisted.
function cyrb53(str: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Compact fingerprint of the synced contract -- what the base snapshot persists (ids + this). */
export const syncHash = (n: NormalizedSyncLocation): string => cyrb53(syncKey(n)).toString(36);

// --- Materialization (crossing the boundary) ---

/**
 * Build a push payload from a local location. `remoteId` is the id to send: the mapped
 * remote id for an existing location, or a negative placeholder for a new one.
 */
export function localToRemoteInput(
	loc: Location,
	remoteId: number,
	tagName: TagName,
): Remote.LocationInput {
	return {
		id: remoteId,
		location: { lat: loc.lat, lng: loc.lng },
		panoId: loc.panoId,
		heading: loc.heading,
		pitch: loc.pitch,
		zoom: loc.zoom,
		flags: remoteFlags(loc.flags),
		tags: namesOf(loc.tags, tagName),
	};
}

/** Local Location columns we accept from the remote. Excludes id/createdAt/modifiedAt/extra (local-only). */
export type LocalSyncFields = Pick<
	Location,
	"lat" | "lng" | "heading" | "pitch" | "zoom" | "panoId" | "flags" | "tags"
>;

/**
 * Project a remote location onto our local columns. Tag names are resolved to local ids;
 * names with no local tag are dropped, so the caller must create any missing tags first.
 */
export function remoteToLocalFields(loc: Remote.Location, tagId: TagId): LocalSyncFields {
	return {
		lat: loc.location.lat,
		lng: loc.location.lng,
		heading: loc.heading,
		pitch: loc.pitch,
		zoom: loc.zoom ?? 0,
		panoId: loc.panoId,
		flags: remoteFlags(loc.flags),
		tags: loc.tags.map(tagId).filter((id): id is number => id != null),
	};
}
