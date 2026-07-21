/**
 * GeoGuessr's user-map draft API. Verified against a live draft, not documented publicly.
 *
 * Two asymmetries to keep in mind, both confirmed empirically:
 *  - a draft READ returns the locations under `coordinates`; a WRITE sends them as
 *    `customCoordinates`.
 *  - a PUT may be partial: `{ mode, version, customCoordinates }` leaves name, description,
 *    avatar and tags untouched.
 */

export interface GgCoordinate {
	lat: number;
	lng: number;
	heading: number;
	pitch: number;
	/** 0 is the default field of view. Never null on read. */
	zoom: number;
	panoId: string | null;
	/** Server-derived by reverse geocoding. Read-only: never send these, never diff on them. */
	countryCode?: string | null;
	stateCode?: string | null;
	cityCode?: string | null;
}

/** `regions` maps are polygonal and have no coordinate list; we cannot sync them. */
export type GgMapMode = "coordinates" | "regions";

export interface GgDraft {
	/** The map id. Present as `slug`, a 24-char hex string. */
	slug: string;
	name: string;
	description: string;
	mode: GgMapMode;
	/** Locations, on READ only. */
	coordinates: GgCoordinate[] | null;
	regions: unknown[] | null;
	/** Optimistic concurrency: a write must send exactly `version + 1`. */
	version: number;
	highlighted: boolean;
	avatar: unknown;
	tags: string[];
	created: string;
	updated: string;
	maxErrorDistance: number;
	hasCustomErrorDistance: boolean;
	image: string | null;
	collaborators: unknown;
}

/** The minimal accepted draft write. */
export interface GgDraftWrite {
	mode: GgMapMode;
	version: number;
	customCoordinates: GgCoordinate[];
}

/**
 * An entry of `GET /api/v4/user-maps/drafts`. Same document as a single draft read, except
 * `coordinates` is always null -- the list carries no location count, so the picker can't show
 * one. Note this lists DRAFTS; `/api/v3/profiles/maps` lists published maps and omits any draft
 * that was never published, which is most of them.
 */
export type GgDraftSummary = Pick<GgDraft, "slug" | "name" | "mode">;

/**
 * An entry of `GET /api/v4/user-maps/maps`: a map as a published entity. Older maps predate the
 * draft system and have no draft at all, so they appear here but not in the drafts list.
 * `coordinateCount` is a display string ("1000+"), not a number -- never rely on it.
 */
export interface GgPublishedSummary {
	slug: string;
	name: string;
	published: boolean;
}

/** GeoGuessr answers a successful draft write with `{ message: "OK" }` and nothing else. */
export interface GgWriteResult {
	message: string;
}
