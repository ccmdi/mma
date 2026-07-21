import type { Location } from "@/bindings.gen";
import { VIRTUAL_FLAGS } from "@/types";

/**
 * The syncable contract: the only fields that participate in diffing, in a shape both sides
 * agree on. Everything outside it is deliberately excluded because it is owned by exactly one
 * side and would otherwise register as a phantom change:
 *   - local only:  id, createdAt, modifiedAt, extra
 *   - remote only: server-derived fields (author, capture date, reverse-geocoded country/state)
 *
 * Two locations are "the same" iff their normalized forms are equal.
 */
export interface NormalizedSyncLocation {
	lat: number;
	lng: number;
	heading: number;
	pitch: number;
	/** Unpanned is `0`; a remote `null` normalizes to `0`. */
	zoom: number;
	panoId: string | null;
	/** Remote-meaningful bits only; our JS-only virtual bits are stripped. */
	flags: number;
	/** Tag names, deduped and sorted. Empty for providers with no tag support. */
	tags: string[];
}

/** Local `Location` columns a pull may write. Excludes id/createdAt/modifiedAt/extra. */
export type LocalSyncFields = Pick<
	Location,
	"lat" | "lng" | "heading" | "pitch" | "zoom" | "panoId" | "flags" | "tags"
>;

/** Resolve a local tag id to its name. `undefined` for unknown ids (dropped). */
export type TagName = (tagId: number) => string | undefined;
/** Resolve a remote tag name to a local tag id. `undefined` if not present locally (dropped). */
export type TagId = (tagName: string) => number | undefined;

/** Strip JS-only virtual flags so only bits a remote could understand survive. */
export const remoteFlags = (flags: number): number => flags & ~VIRTUAL_FLAGS;

export const canonTags = (names: string[]): string[] => [...new Set(names)].sort();

export const namesOf = (tagIds: number[], tagName: TagName): string[] =>
	canonTags(tagIds.map(tagName).filter((n): n is string => n != null));

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

/** Project a normalized location onto our local columns, resolving tag names to local ids. */
export function normalizedToLocalFields(n: NormalizedSyncLocation, tagId: TagId): LocalSyncFields {
	return {
		lat: n.lat,
		lng: n.lng,
		heading: n.heading,
		pitch: n.pitch,
		zoom: n.zoom,
		panoId: n.panoId,
		flags: n.flags,
		tags: n.tags.map(tagId).filter((id): id is number => id != null),
	};
}

/**
 * Only the columns where `next` actually differs from `prev`. Pulls patch with this so a field
 * the provider cannot represent (and therefore reports as empty) never overwrites local data.
 */
export function changedLocalFields(
	prev: NormalizedSyncLocation,
	next: NormalizedSyncLocation,
	tagId: TagId,
): Partial<LocalSyncFields> {
	const full = normalizedToLocalFields(next, tagId);
	const patch: Partial<LocalSyncFields> = {};
	if (prev.lat !== next.lat) patch.lat = full.lat;
	if (prev.lng !== next.lng) patch.lng = full.lng;
	if (prev.heading !== next.heading) patch.heading = full.heading;
	if (prev.pitch !== next.pitch) patch.pitch = full.pitch;
	if (prev.zoom !== next.zoom) patch.zoom = full.zoom;
	if (prev.panoId !== next.panoId) patch.panoId = full.panoId;
	if (prev.flags !== next.flags) patch.flags = full.flags;
	if (prev.tags.join("\0") !== next.tags.join("\0")) patch.tags = full.tags;
	return patch;
}

/** Canonical comparable key. Equal keys means the same location on the synced contract. */
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
