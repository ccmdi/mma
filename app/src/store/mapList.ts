import { SCRATCH_MAP_ID } from "@/bindings.consts";
import { type CommitDiff, type MapMeta } from "@/bindings.gen";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import { cmd } from "@/lib/commands";
import {
	emit as emitEvent,
	subscribe,
	subscribeMany,
	useEventValue,
	type EditorEvent,
} from "@/lib/events";
import { openWindow } from "@/lib/window";
import { getSettings } from "@/store/settings";
import { msg, t } from "@/lib/i18n";

let cachedMapList: MapMeta[] = [];

/** Reactive list of all maps (metadata only). */
export function useMapList(): MapMeta[] {
	return useEventValue("map-list:changed", () => cachedMapList);
}

/** The list of all maps (metadata only). */
export function getMapList() {
	return cachedMapList;
}

/** Refresh the map list from disk. @unstable */
export async function reloadMapList() {
	cachedMapList = await cmd.storeListMaps();
	emitEvent("map-list:changed");
}

/** Refresh the map list and notify other windows of the change. @unstable */
export async function invalidateMapList() {
	await reloadMapList();
	await tauriEmit("map-list-changed");
}

/** Set the map list directly without a disk read. @unstable */
export function setCachedMapList(list: MapMeta[]) {
	cachedMapList = list;
}

/** Create a new empty map and return its metadata. */
export async function createMap(name: string, folder: string | null = null) {
	const meta = await cmd.storeCreateMap(name, folder);
	await invalidateMapList();
	return meta;
}

/** Open the scratch map, creating it on first use. */
export async function openScratchMap() {
	const meta = await cmd.storeScratchMap();
	await openWindow({ type: "editor", mapId: meta.id }, meta.name);
}

/** Ids the app keeps for its own fixtures. */
const RESERVED_MAP_IDS: ReadonlySet<string> = new Set([SCRATCH_MAP_ID]);

/** Whether `id` belongs to an app fixture rather than a user-created map. @unstable */
export function isReservedMap(id: string | null): boolean {
	return id != null && RESERVED_MAP_IDS.has(id);
}

/** Permanently delete a map and all its data. Not undoable. */
export async function deleteMap(id: string) {
	await cmd.storeDeleteMap(id);
	await invalidateMapList();
	await tauriEmit("map-deleted", id);
}

/** Rename a folder, moving all its maps to the new name. */
export async function renameFolder(from: string, to: string) {
	cachedMapList = cachedMapList.map((m) => (m.folder === from ? { ...m, folder: to } : m));
	emitEvent("map-list:changed");
	await cmd.storeRenameFolder(from, to);
	await invalidateMapList();
}

/** Move a map into a folder, or to the root when `folder` is null. */
export async function moveMapToFolder(mapId: string, folder: string | null) {
	const idx = cachedMapList.findIndex((m) => m.id === mapId);
	if (idx !== -1) {
		cachedMapList = cachedMapList.map((m) => (m.id === mapId ? { ...m, folder } : m));
		emitEvent("map-list:changed");
	}
	await cmd.storeUpdateMapMeta(mapId, { folder: folder ?? null });
	await tauriEmit("map-list-changed");
}

/** Delete a folder. Maps in it become unfoldered. */
export async function deleteFolder(name: string) {
	await cmd.storeDeleteFolder(name);
	await invalidateMapList();
}

/** A mark drawn after a map's name in the map list: an icon, or a count of changes. */
export type MapBadge = { key: string; title: string } & ({ icon: string } | { diff: CommitDiff });

/** A feature that marks map rows, shown or hidden as a unit in settings. */
export interface BadgeSource {
	/** Stable id, remembered by the setting that hides it. */
	id: string;
	/** Name shown next to its checkbox in settings. */
	label: string;
	/** Events after which the badges are collected again. */
	events: readonly EditorEvent[];
	/** Yields the badges to show, each paired with its map id. */
	collect(): Iterable<[mapId: string, badge: MapBadge]>;
}

const badgeSources: BadgeSource[] = [];
let collected: { hidden: readonly string[]; badges: Map<string, MapBadge[]> } | null = null;

function collectMapBadges(hidden: readonly string[]) {
	const badges = new Map<string, MapBadge[]>();
	for (const source of badgeSources) {
		if (hidden.includes(source.id)) continue;
		for (const [mapId, badge] of source.collect()) {
			const forMap = badges.get(mapId) ?? [];
			forMap.push(badge);
			badges.set(mapId, forMap);
		}
	}
	return badges;
}

function invalidateMapBadges() {
	collected = null;
	emitEvent("map-badges:changed");
}

subscribe("settings:changed", () => {
	if (collected && collected.hidden !== getSettings().hiddenMapBadges) invalidateMapBadges();
});

/** Add a source of map-row badges. @unstable */
export function registerMapBadges(source: BadgeSource) {
	badgeSources.push(source);
	subscribeMany(source.events, invalidateMapBadges);
	invalidateMapBadges();
}

/** Every registered badge source, in registration order. @unstable */
export function getMapBadgeSources(): readonly BadgeSource[] {
	return badgeSources;
}

/** Badges per map id, from every registered source. @unstable */
export function getMapBadges(): Map<string, MapBadge[]> {
	if (!collected) {
		const hidden = getSettings().hiddenMapBadges;
		collected = { hidden, badges: collectMapBadges(hidden) };
	}
	return collected.badges;
}

/** Reactive {@link getMapBadges}. @unstable */
export function useMapBadges(): Map<string, MapBadge[]> {
	return useEventValue("map-badges:changed", getMapBadges);
}

registerMapBadges({
	id: "pending",
	label: msg("Uncommitted changes"),
	events: ["map-list:changed"],
	*collect() {
		for (const m of cachedMapList) {
			const { added, removed, modified } = m.pending;
			if (added + removed + modified === 0) continue;
			yield [m.id, { key: "pending", diff: m.pending, title: t("Changes since the last commit") }];
		}
	},
});
