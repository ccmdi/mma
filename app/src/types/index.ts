import type { FieldDef, Location } from "@/bindings.gen";
import type { FieldType } from "@/bindings.consts";
import { nowUnix } from "@/lib/util/util";
import type { RequireNonNull } from "@/types/util";
import { LocationFlag } from "@/bindings.consts";

/** A field definition with every optional attribute spelled absent. */
export function createFieldDef(
	type: FieldType,
	over: Partial<Omit<FieldDef, "type">> = {},
): FieldDef {
	return { label: null, values: null, comparison: null, ...over, type };
}

/** A tag's display identity: name, color, sidebar order, and document links. */
export interface Tag {
	id: number;
	name: string;
	color: string;
	/** True while at least one location carries the tag. */
	visible: boolean;
	order: number | null;
	doclinks: string[];
}

/** Partial update to a tag's editable display metadata; `null` clears the field. */
/** A change to some of row `id`'s fields. */
export type Patch<T extends { id: unknown }> = Partial<T> & Pick<T, "id">;

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

/** Convert a [south, west, north, east] tuple to a Bounds object. @unstable */
export function scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): Bounds {
	return { south: s, west: w, north: n, east: e };
}

/** Convert a [west, south, east, north] bbox tuple to Bounds, or null. @unstable */
export function bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null {
	if (!t) return null;
	return { south: t[1], west: t[0], north: t[3], east: t[2] };
}

/** Convert a Bounds object to a [south, west, north, east] tuple. @unstable */
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

/** The patch that turns `old` into `next`: each field that changed, a `merged` field as only
 *  its changed keys, and null for a key `next` lacks. */
export function patchBetween<T extends object>(
	old: T,
	next: T,
	merged: readonly string[] = [],
): Partial<T> {
	const [a, b] = [old as Record<string, unknown>, next as Record<string, unknown>];
	const patch: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (merged.includes(key)) {
			const keys = patchBetween((a[key] ?? {}) as object, (b[key] ?? {}) as object);
			if (Object.keys(keys).length > 0) patch[key] = keys;
		} else if (!same(a[key] ?? null, b[key] ?? null)) {
			patch[key] = b[key] ?? null;
		}
	}
	return patch as Partial<T>;
}

/** Whether two values hold the same thing; an object's key order never matters. */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
	const keys = Object.keys(x);
	return keys.length === Object.keys(y).length && keys.every((k) => same(x[k], y[k]));
}

/** The same location on the same pano: what makes one row's answer another row's. @unstable */
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

/** True when the location is an import preview (not yet committed). @unstable */
export function isImportPreview(loc: Location): boolean {
	return (loc.flags & LocationFlag.ImportPreview) !== 0;
}

/** True when the location is a seen-history overlay preview. @unstable */
export function isSeenPreview(loc: Location): boolean {
	return (loc.flags & LocationFlag.SeenOverlay) !== 0;
}

/** Build a new Location from lat/lng plus overrides. Its `id` is 0, whatever the
 *  overrides hold, until `addLocations` writes the real id back into the object. */
export function createLocation(partial: Partial<Location> & LatLng): Location {
	return {
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
		id: 0,
	};
}

/** A new Location at the viewer's live camera, carrying `source`'s flags and the given
 *  tags. `extra` describes the pano it was fetched for, so it only survives a drop that
 *  stayed on that pano. @unstable */
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

/** `row` with `patch` written over it. An absent field is unchanged, and a `merged` field
 *  changes key by key, a null value deleting its key, and is null once empty. */
export function applyPatch<T extends object>(
	row: T,
	patch: { [K in keyof T]?: unknown },
	merged: readonly string[] = [],
): T {
	const next = { ...row } as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (value === null || !merged.includes(key)) {
			next[key] = value;
			continue;
		}
		const keys: Record<string, unknown> = { ...(next[key] as object | null) };
		for (const [k, v] of Object.entries(value)) {
			if (v === null) delete keys[k];
			else keys[k] = v;
		}
		next[key] = Object.keys(keys).length > 0 ? keys : null;
	}
	return next as T;
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
