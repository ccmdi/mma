import type { MapMeta } from "@/bindings.gen";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import { cmd } from "@/lib/commands";
import { emit as emitEvent, useEventValue } from "@/lib/events";

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
	const { meta } = await cmd.storeCreateMap(name, folder);
	await invalidateMapList();
	return meta;
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
