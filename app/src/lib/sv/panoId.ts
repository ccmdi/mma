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
export function newestOfficialPano<T extends { pano: string }>(time: readonly T[]): T | null {
	return time.findLast((t) => isOfficialPano(t.pano)) ?? null;
}

/** Heuristic: a user-uploaded pano, by id length or attribution. Both attribution texts are
 *  searched: a user photo can carry a place description as well as its "Photo by" line. */
export function isUnofficial(p: Pano): boolean {
	if (!p.pano) return false;
	if (p.pano.length > 22) return true;
	return /photo by|user[- ]uploaded/i.test(`${p.shortDescription} ${p.copyright}`);
}

/** The capture history to show for a pano: its own stack merged with the stacks of the panos
 *  beside it, since a partly-official stack carries only part of the history. Entries are
 *  keyed by pano id and later sources win, so pass the pano itself last. */
export function mergeTimelines(sources: (Pano | null)[]): Pano["time"] {
	const merged = new Map<string, Pano["time"][number]>();
	for (const p of sources) for (const t of p?.time ?? []) merged.set(t.pano, t);
	return [...merged.values()];
}

/** True when nothing in the timeline is official coverage, so the multi-year history lives
 *  on official coverage nearby rather than on these panos. */
export function allUnofficial(time: Pano["time"]): boolean {
	return time.length > 0 && time.every((t) => !isOfficialPano(t.pano));
}
