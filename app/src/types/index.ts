import type {
	ExtraFieldDef,
	ExtraFieldType,
	Location,
	LocationPatch_Deserialize as LocationPatch,
} from "@/bindings.gen";
import { nowUnix } from "@/lib/util/util";
import type { RequireNonNull } from "@/types/util";
import { LocationFlag } from "@/bindings.consts";

/** A field definition with every optional attribute spelled absent. */
export function createFieldDef(
	type: ExtraFieldType,
	over: Partial<Omit<ExtraFieldDef, "type">> = {},
): ExtraFieldDef {
	return { label: null, values: null, labels: null, comparison: null, ...over, type };
}

/** Street View camera orientation (POV). */
export type LocationPOV = Pick<Location, "heading" | "pitch" | "zoom">;
/** A view on a specific panorama. */
export type PanoView = LocationPOV & RequireNonNull<Pick<Location, "panoId">>;
/** The camera fields a Location and the live Street View viewer share. */
export type PanoCapture = LocationPOV & Pick<Location, "lat" | "lng" | "panoId">;

/** A {lat, lng} coordinate pair. */
export type LatLng = google.maps.LatLngLiteral;
/** A {west, south, east, north} bounding box. */
export type Bounds = google.maps.LatLngBoundsLiteral;

/** True when bounds span the entire world. */
export function isWorldBounds(b: Bounds): boolean {
	return b.south === -90 && b.west === -180 && b.north === 90 && b.east === 180;
}

/** Convert a [south, west, north, east] tuple to a Bounds object. */
export function scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): Bounds {
	return { south: s, west: w, north: n, east: e };
}

/** Convert a [west, south, east, north] bbox tuple to Bounds, or null. */
export function bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null {
	if (!t) return null;
	return { south: t[1], west: t[0], north: t[3], east: t[2] };
}

/** Convert a Bounds object to a [south, west, north, east] tuple. */
export function boundsToScoreTuple(b: Bounds): [number, number, number, number] {
	return [b.south, b.west, b.north, b.east];
}

/** Pinned: the location always opens this exact pano. */
export function isPinned(loc: Location): loc is Location & { panoId: string } {
	return (loc.flags & LocationFlag.LoadAsPanoId) !== 0 && loc.panoId != null && loc.panoId !== "";
}

/** The location pinned to the pano it carries, or unpinned to float on default coverage. */
export function setPinned(loc: Location, on: boolean): Location {
	return {
		...loc,
		flags: on ? loc.flags | LocationFlag.LoadAsPanoId : loc.flags & ~LocationFlag.LoadAsPanoId,
	};
}

/** The `extra` merge patch that turns `before` into `after`: changed keys carry their
 *  new value, keys `after` lacks carry null. */
export function extraPatch(
	before: Record<string, unknown> | null,
	after: Record<string, unknown> | null,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(after ?? {})) {
		if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(value ?? null)) patch[key] = value;
	}
	for (const key of Object.keys(before ?? {})) {
		if (!(key in (after ?? {}))) patch[key] = null;
	}
	return patch;
}

/** The same location on the same pano: what makes one row's answer another row's. */
export function sameRow(a: Location, b: Location): boolean {
	return a.id === b.id && a.panoId === b.panoId;
}

/** True for virtual (preview-only) locations, which have negative ids and are not
 *  part of the map. */
export function isVirtualLocation(loc: { id: number }): boolean {
	return loc.id < 0;
}

/** A full location or just its id (to be fetched on demand). */
export type MaybeLocation = Location | number;

/** Extract the id from a MaybeLocation. */
export function locId(m: MaybeLocation): number {
	return typeof m === "number" ? m : m.id;
}

/** True when the location is an import preview (not yet committed). */
export function isImportPreview(loc: Location): boolean {
	return (loc.flags & LocationFlag.ImportPreview) !== 0;
}

/** True when the location is a seen-history overlay preview. */
export function isSeenPreview(loc: Location): boolean {
	return (loc.flags & LocationFlag.SeenOverlay) !== 0;
}

/** Build a Location from lat/lng plus overrides. `id` stays 0 until `addLocations`
 *  writes the real id back into the object. */
export function createLocation(partial: Partial<Location> & LatLng): Location {
	return {
		id: 0, // placeholder; Rust assigns the real ID
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: LocationFlag.None,
		tags: [],
		extra: null,
		createdAt: nowUnix(),
		modifiedAt: null,
		...partial,
	};
}

/** A new Location at the viewer's live camera, carrying `source`'s flags and the given
 *  tags. `extra` describes the pano it was fetched for, so it only survives a drop that
 *  stayed on that pano. */
export function dropLocation(
	source: Location,
	live: PanoCapture,
	panoId: string | null,
	tags: number[],
): Location {
	return createLocation({
		...live,
		panoId,
		flags: source.flags,
		tags,
		extra: panoId === source.panoId ? source.extra : null,
	});
}

/** Apply a LocationPatch to a location. `extra` follows JSON Merge Patch (RFC 7386):
 *  keys shallow-merge, a null value deletes its key, and a null patch clears extra. */
export function applyLocationPatch(loc: Location, patch: LocationPatch): Location {
	const { extra: extraPatch, ...rest } = patch;
	const next = { ...loc, ...rest } as Location;
	if (extraPatch !== undefined) {
		if (extraPatch === null) {
			next.extra = null;
		} else {
			const merged: Record<string, unknown> = { ...loc.extra };
			for (const [k, v] of Object.entries(extraPatch as Record<string, unknown>)) {
				if (v === null) delete merged[k];
				else merged[k] = v;
			}
			next.extra = Object.keys(merged).length > 0 ? merged : null;
		}
	}
	return next;
}

export type SortMode = "name" | "created" | "opened" | "amount";
export type TagSortMode = "default" | "name" | "amount";

export type WorkArea = "overview" | "location" | "duplicates" | "import" | "plugin" | "diff";

/** Hex like "#1098ad"; legacy stored prefs may hold an Open Props ramp name. */
export type SvColor = string;

export type MapTypeKey = "map" | "satellite" | "osm" | "vector";
export type SvCoverageType = "official" | "unofficial" | "default";
export type SvThickness = "default" | "high";
export type MarkerStyle = "pin" | "circle" | "arrow";
