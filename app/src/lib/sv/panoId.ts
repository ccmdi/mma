import type { Pano } from "@/bindings.gen";
import { OFFICIAL_ID_PATTERN } from "@/bindings.consts";

const OFFICIAL_PANO_RE = new RegExp(OFFICIAL_ID_PATTERN);

export function isOfficialPano(panoId: string): boolean {
	if (panoId.startsWith("F:")) return false;
	return OFFICIAL_PANO_RE.test(panoId);
}

/** Newest official pano in a capture timeline, or null if it holds none. Timelines from
 *  `svMetadata` are sorted ascending by date, so "newest" is the last official entry -
 *  scanning backwards rather than indexing keeps that assumption in one place. */
export function newestOfficialPano<T extends { panoId: string }>(time: readonly T[]): T | null {
	return time.findLast((t) => isOfficialPano(t.panoId)) ?? null;
}

/** Heuristic: a user-uploaded pano, by id length or attribution. Both attribution texts are
 *  searched: a user photo can carry a place description as well as its "Photo by" line. */
export function isUnofficial(p: Pano): boolean {
	if (!p.id) return false;
	if (p.id.length > 22) return true;
	return /photo by|user[- ]uploaded/i.test(`${p.shortDescription} ${p.copyright}`);
}

/** A pano's stack merged with another's, for the all-unofficial case where the multi-year
 *  history lives on official coverage nearby. Entries are keyed by pano id and later
 *  sources win, so pass the pano itself last. */
export function mergeTimelines(sources: (Pano | null)[]): Pano["time"] {
	const merged = new Map<string, Pano["time"][number]>();
	for (const p of sources) for (const t of p?.time ?? []) merged.set(t.panoId, t);
	return [...merged.values()];
}

/** True when nothing in the timeline is official coverage, an empty stack included, so
 *  the multi-year history lives on official coverage nearby rather than on these panos. */
export function allUnofficial(time: Pano["time"]): boolean {
	return time.every((t) => !isOfficialPano(t.panoId));
}
