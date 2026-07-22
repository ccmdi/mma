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
