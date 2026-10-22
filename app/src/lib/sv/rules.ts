import type { Pano } from "@/bindings.gen";
import { CapturePick, OFFICIAL_ID_PATTERN, type KNOWN_FIELDS } from "@/bindings.consts";

export const SV_SEARCH_RADIUS = 50;

/** The `extra` fields the svMeta provider produces. Keys of the Rust field table, so
 *  the filter, the enrichment picker and the provider's derivation agree by
 *  construction. */
export const SVMETA_FIELDS = [
	"altitude",
	"countryCode",
	"cameraType",
	"panoType",
	"drivingDirection",
	"uploaderName",
	"imageDate",
	"coverageDates",
] as const satisfies readonly (typeof KNOWN_FIELDS)[number]["key"][];

const OFFICIAL_PANO_RE = new RegExp(OFFICIAL_ID_PATTERN);

export function isOfficialPano(panoId: string): boolean {
	if (panoId.startsWith("F:")) return false;
	// Bare user-contribution keys can be exactly 22 characters, colliding with the
	// official shape; the prefix is the tell.
	if (panoId.startsWith("CIHM")) return false;
	return OFFICIAL_PANO_RE.test(panoId);
}

/** The official capture `pick` names in a timeline, or null if it holds none. Timelines
 *  are sorted ascending by date. */
export function pickCapture<T extends { panoId: string }>(
	time: readonly T[],
	pick: CapturePick,
): T | null {
	const official = (t: T) => isOfficialPano(t.panoId);
	return (pick === CapturePick.Newest ? time.findLast(official) : time.find(official)) ?? null;
}

/** `a`'s capture month is strictly after `b`'s. Undated coverage never counts as newer. */
export function capturedAfter(a: Pano, b: Pano): boolean {
	return a.imageDate !== "" && a.imageDate > b.imageDate;
}

/** Heuristic: a user-uploaded pano, by id length or attribution. Both attribution texts are
 *  searched: a user photo can carry a place description as well as its "Photo by" line. */
export function isUnofficial(p: Pano): boolean {
	if (!p.id) return false;
	if (p.id.length > 22) return true;
	return /photo by|user[- ]uploaded/i.test(`${p.shortDescription} ${p.copyright}`);
}
