import type { Location_Serialize, EditorImportResult_Serialize, EditorImportPreview } from "@/bindings.gen";
// Relative (not "@/") so the e2e runner's tsx loader can resolve this runtime value import
// when it pulls in this module via test helpers; the `@/` alias isn't applied there.
import { nowUnix } from "../lib/util/format";

export type Location = Location_Serialize;
export type ImportResult = EditorImportResult_Serialize;
export type ImportPreview = EditorImportPreview;

/** Street View camera orientation (POV). */
export type LocationPOV = Pick<Location, "heading" | "pitch" | "zoom">;

export const enum LocationFlag {
	None = 0,
	LoadAsPanoId = 1,
	Informational = 2,
}

/** Panorama source type from Google's internal metadata. */
export const enum PanoType {
	Official = 2,
	Unknown = 3,
	UserUploaded = 10,
}

export const LOCATION_CORE_KEYS = new Set([
	"lat",
	"lng",
	"heading",
	"pitch",
	"zoom",
	"panoId",
	"flags",
	"tags",
	"extra",
]);

export function hasLoadAsPanoId(loc: Location): boolean {
	return (loc.flags & LocationFlag.LoadAsPanoId) !== 0;
}

export function isInformational(loc: Location): boolean {
	return (loc.flags & LocationFlag.Informational) !== 0;
}

export function isPinnedToPano(loc: Location): boolean {
	return hasLoadAsPanoId(loc) && loc.panoId != null;
}

/** Virtual locations (negative id) exist only ephemerally — e.g. staged imports
 *  previewed before commit. They display like real locations but every mutate
 *  path no-ops, and UI hides affordances that cannot apply. */
export function isVirtualLocation(loc: { id: number }): boolean {
	return loc.id < 0;
}

/** Encoding between a staged-import preview index and its virtual location id.
 *  Single source for the `-(index + 1)` scheme. */
export function stagedIndexToVirtualId(index: number): number {
	return -(index + 1);
}

export function virtualIdToStagedIndex(id: number): number {
	return -id - 1;
}

export function createLocation(
	partial: Partial<Location> & { lat: number; lng: number },
): Location {
	return {
		id: 0, // placeholder; Rust assigns the real ID
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: LocationFlag.None,
		tags: [],
		createdAt: nowUnix(),
		...partial,
	};
}

export type SortMode = "name" | "created" | "opened" | "amount";
export type TagSortMode = "default" | "name" | "amount";

export type WorkArea = "overview" | "location" | "duplicates" | "import" | "plugin" | "diff";

export interface DuplicateGroup {
	distance: number;
	locations: Location[];
}
