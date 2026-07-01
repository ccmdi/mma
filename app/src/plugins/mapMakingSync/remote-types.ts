/**
 * Bitfield. Test bits, never equality: use `flags & LocationFlag.LoadAsPanoId`,
 * not `flags === 1` — the API reserves other bits for future use.
 */
export const LocationFlag = {
	None: 0,
	LoadAsPanoId: 1,
	Informational: 2,
} as const;

export type LocationFlag = (typeof LocationFlag)[keyof typeof LocationFlag];

export interface User {
	id: number;
	username: string;
	/** Observed live; not in the public API docs. */
	createdAt?: string;
}

export type PreferDirection = "north" | "east" | "south" | "west" | "random";

export interface MapSettings {
	pointAlongRoad: boolean;
	preferDirection: PreferDirection | null;
	preferOfficial: boolean;
	/** Observed live; not in the public API docs. */
	onlyOfficial?: boolean;
	/** Observed live; not in the public API docs. */
	cameraTypes?: string[] | null;
	defaultPanoId: boolean;
	exportZoom: boolean;
	exportUnpanned: boolean;
}

export interface TagSettings {
	/** Display order. */
	order: number;
	/** RGB, 3 elements 0-255. */
	color: number[];
}

export interface Collaborator {
	id: number;
	username: string;
	role: string;
	connected?: boolean;
}

export interface Map {
	id: number;
	name: string;
	description: string | null;
	folder?: string | null;
	role: string;
	publicUrl: string | null;
	archivedAt: string | null;
	locationCount: number;
	isPublic?: boolean;
	collaborators?: Collaborator[];
	storage?: string;
	type?: string;
	/** Observed live (e.g. "auto"); the bounds-array form is unverified. Not in the public API docs. */
	scoreBounds?: "auto" | number[];
	settings: MapSettings;
	/**
	 * Tag registry keyed by tag name.
	 */
	tags: Record<string, TagSettings>;
	/** Present on some multi-map records; not documented by the public API page. */
	embedded?: Map[];
}

export interface LatLng {
	lat: number;
	lng: number;
}

export interface Location {
	id: number;
	/** Author user id. Read-only. */
	author?: number;
	location: LatLng;
	/** Populated even for non-pano-id locations, so it can drive update detection. */
	panoId: string | null;
	/**
	 * ISO 8601, month-granular pano capture date (pinned to day 01, 00:00:00Z).
	 * Read-only client-side; MMA fills it in on add. Can be missing.
	 */
	panoDate?: string | null;
	heading: number;
	pitch: number;
	zoom: number | null;
	/** ISO 8601, server-assigned. */
	createdAt: string;
	flags: number;
	/** Tag names (not ids). */
	tags: string[];
}

export interface LocationInput {
	/** New locations should use negative IDs to distinguish them from existing ones. */
	id: number;
	location: LatLng;
	panoId?: string | null;
	heading: number;
	pitch: number;
	zoom: number | null;
	tags: string[];
	flags: number;
}

export const EditActionType = {
	Add: 0,
	Remove: 1,
	RemoveAll: 2,
	Replace: 3,
	Import: 4,
	AddTag: 5,
	DeleteTag: 6,
	RenameTag: 7,
	Bulk: 8,
	Undo: 9,
} as const;

/**
 * `action` is history metadata only — the actual mutation is the edit's `create`/`remove`
 * arrays. Choose the most accurate action for the history UI; correctness comes from
 * create/remove. For `Bulk`, leave `actions` unset when using it as a catch-all.
 */
export type EditAction =
	| { type: typeof EditActionType.Add }
	| { type: typeof EditActionType.Remove }
	| { type: typeof EditActionType.RemoveAll }
	| { type: typeof EditActionType.Replace }
	| { type: typeof EditActionType.Import }
	| { type: typeof EditActionType.AddTag; tagName: string }
	| { type: typeof EditActionType.DeleteTag; tagName: string }
	| { type: typeof EditActionType.RenameTag; oldName: string; newName: string }
	| { type: typeof EditActionType.Bulk; actions?: object[] | null }
	| { type: typeof EditActionType.Undo; undoLength: number };

export interface LocationEdit {
	action: EditAction;
	create: LocationInput[];
	/** IDs of locations to remove; may include negative IDs created earlier in the same request. */
	remove: number[];
}

export interface LocationEditRequest {
	edits: LocationEdit[];
}

/**
 * Response of `POST /maps/{id}/locations`: maps each submitted id (often a negative
 * placeholder) to the id MMA assigned. A location's id changes when it is modified.
 */
export type LocationEditResult = Record<string, number>;

export interface CreateMapRequest {
	name: string;
	description?: string | null;
}

/**
 * `PUT /maps/{id}` is used by the official userscript ({ name, publicUrl, description })
 * but is NOT in the public API docs. `settings` support here is unverified.
 */
export interface UpdateMapRequest {
	name?: string;
	description?: string | null;
	publicUrl?: string | null;
	settings?: Partial<MapSettings>;
}
