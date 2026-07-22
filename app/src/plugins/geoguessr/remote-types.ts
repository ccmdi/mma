/**
 * GeoGuessr's user-map draft API listing types. Verified against a live account, not documented
 * publicly. The full draft read/write shapes live in Rust now; JS only lists maps for the picker.
 */

/** `regions` maps are polygonal and have no coordinate list; we cannot sync them. */
export type GgMapMode = "coordinates" | "regions";

/**
 * An entry of `GET /api/v4/user-maps/drafts`. The list carries no location count, so the picker
 * can't show one. Note this lists DRAFTS; `/api/v4/user-maps/maps` lists published maps and omits
 * any draft that was never published, which is most of them.
 */
export interface GgDraftSummary {
	/** The map id: a 24-char hex string. */
	slug: string;
	name: string;
	mode: GgMapMode;
}

/**
 * An entry of `GET /api/v4/user-maps/maps`: a map as a published entity. Older maps predate the
 * draft system and have no draft at all, so they appear here but not in the drafts list.
 */
export interface GgPublishedSummary {
	slug: string;
	name: string;
	published: boolean;
}
