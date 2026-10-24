import type { Cmd } from "@/lib/commands";
export type Selector = Parameters<Cmd["storeRead"]>[1][number];
import type { FieldDef, Location, ValueRecord } from "@/bindings.gen";
import type { FieldType } from "@/bindings.consts";
import { nowUnix } from "@/lib/util/util";
import type { RequireNonNull } from "@/types/util";
import { LocationFlag } from "@/bindings.consts";

/** A field definition with every optional attribute spelled absent. @api */
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

/** A change to some fields of row `id`. */
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

/** True when bounds span the entire world. @api */
export function isWorldBounds(b: Bounds): boolean {
	return b.south === -90 && b.west === -180 && b.north === 90 && b.east === 180;
}

/** Convert a [south, west, north, east] tuple to a Bounds object. @api @unstable */
export function scoreTupleToBounds([s, w, n, e]: [number, number, number, number]): Bounds {
	return { south: s, west: w, north: n, east: e };
}

/** Convert a [west, south, east, north] bbox tuple to Bounds, or null. @api @unstable */
export function bboxTupleToBounds(t: [number, number, number, number] | null): Bounds | null {
	if (!t) return null;
	return { south: t[1], west: t[0], north: t[3], east: t[2] };
}

/** Convert a Bounds object to a [south, west, north, east] tuple. @api @unstable */
export function boundsToScoreTuple(b: Bounds): [number, number, number, number] {
	return [b.south, b.west, b.north, b.east];
}

/** Pinned: the location always opens this exact pano. @api */
export function isPinned(loc: Location): loc is Location & { panoId: string } {
	return (loc.flags & LocationFlag.LoadAsPanoId) !== 0 && loc.panoId != null && loc.panoId !== "";
}

/** The location pinned to the pano it carries, or unpinned to float on default coverage. @api */
export function setPinned(loc: Location, on: boolean): Location {
	return {
		...loc,
		flags: on ? loc.flags | LocationFlag.LoadAsPanoId : loc.flags & ~LocationFlag.LoadAsPanoId,
	};
}

/** A full location or just its id (to be fetched on demand). */
export type MaybeLocation = Location | number;

/** Extract the id from a MaybeLocation. @api */
export function locId(m: MaybeLocation): number {
	return typeof m === "number" ? m : m.id;
}

/** Build a new Location from lat/lng plus overrides. Its `id` is 0, whatever the
 *  overrides hold; adding it to the map returns its real id. @api */
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

/** A new Location at the viewer's live camera, carrying `source`'s flags, tagged `tagNames`
 *  through `records`, which the map it lands in matches to its own tags by name. `extra`
 *  describes the pano it was fetched for, so it only survives a drop that stayed on that
 *  pano. @api @unstable */
export function dropLocation(
	source: Location,
	live: PanoCapture,
	panoId: string | null,
	tagNames: string[],
): { location: Location; records: { tags: Record<number, ValueRecord> } } {
	const tags = tagNames.map((name, i) => ({ id: i + 1, name }));
	return {
		location: createLocation({
			...live,
			panoId,
			flags: source.flags,
			tags: tags.map((tag) => tag.id),
			extra: panoId === source.panoId ? source.extra : null,
		}),
		records: { tags: Object.fromEntries(tags.map((tag) => [tag.id, tag])) },
	};
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
