import { SCRATCH_MAP_ID } from "@/bindings.consts";
import { type MapMeta } from "@/bindings.gen";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import { cmd } from "@/lib/commands";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { openWindow } from "@/lib/window";

let cachedMapList: MapMeta[] = [];

/** Reactive list of all maps (metadata only). */
export function useMapList(): MapMeta[] {
	return useEventValue("map-list:changed", () => cachedMapList);
}

/** The list of all maps (metadata only). */
export function getMapList() {
	return cachedMapList;
}

export async function reloadMapList() {
	cachedMapList = await cmd.storeListMaps();
	emitEvent("map-list:changed");
}

/** Re-fetch the map list from the database. */
export async function invalidateMapList() {
	await reloadMapList();
	await tauriEmit("map-list-changed");
}

/** Set the cached map list directly (used by initStore). */
export function setCachedMapList(list: MapMeta[]) {
	cachedMapList = list;
}

/** Create a new empty map and return its metadata. */
export async function createMap(name: string, folder: string | null = null) {
	const meta = await cmd.storeCreateMap(name, folder);
	await invalidateMapList();
	return meta;
}

/** Open the scratch map, created on first use. An ordinary map that the list hides and
 *  startup wipes, so the list never needs invalidating for it. */
export async function openScratchMap() {
	const meta = await cmd.storeScratchMap();
	await openWindow({ type: "editor", mapId: meta.id }, meta.name);
}

/** Ids the app keeps for its own fixtures. */
const RESERVED_MAP_IDS: ReadonlySet<string> = new Set([SCRATCH_MAP_ID]);

/** A reserved map is an app fixture, not one of the user's: it carries no name, never
 *  appears in the list, and has nothing to configure. Keyed by id, never by name -- the
 *  name is a value the user could type. */
export function isReservedMap(id: string | null | undefined): boolean {
	return id != null && RESERVED_MAP_IDS.has(id);
}

/** Permanently delete a map and all its data. Not undoable. */
export async function deleteMap(id: string) {
	await cmd.storeDeleteMap(id);
	await invalidateMapList();
	await tauriEmit("map-deleted", id);
}

export async function renameFolder(from: string, to: string) {
	cachedMapList = cachedMapList.map((m) => (m.folder === from ? { ...m, folder: to } : m));
	emitEvent("map-list:changed");
	await cmd.storeRenameFolder(from, to);
	await invalidateMapList();
}

export async function moveMapToFolder(mapId: string, folder: string | null) {
	const idx = cachedMapList.findIndex((m) => m.id === mapId);
	if (idx !== -1) {
		cachedMapList = cachedMapList.map((m) => (m.id === mapId ? { ...m, folder } : m));
		emitEvent("map-list:changed");
	}
	await cmd.storeUpdateMapMeta(mapId, { folder: folder ?? null });
	await tauriEmit("map-list-changed");
}

export async function deleteFolder(name: string) {
	await cmd.storeDeleteFolder(name);
	await invalidateMapList();
}
