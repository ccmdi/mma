import { Autosave } from "./autosave";
import { Feed } from "./feed";
import { Store } from "./store";
import { Editor } from "./editor";
import { Edit } from "./edit";
import type { StoreStatus, StoreWarning } from "@/bindings.gen";
import { listen } from "@tauri-apps/api/event";
import { log } from "@/lib/util/log";
import { toast } from "@/lib/util/toast";
import { storeWarningText } from "@/lib/util/format";
import { mapOpen, trace } from "@/lib/util/debug";
import { Scene } from "@/lib/render/scene";
import { Import } from "./import";
import { CommitDiff } from "./commitDiff";
import { SCRATCH_MAP_ID } from "@/bindings.consts";
import { type Counts, type MapMeta } from "@/bindings.gen";
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

/** Ids the app keeps for its own fixtures. */
const RESERVED_MAP_IDS: ReadonlySet<string> = new Set([SCRATCH_MAP_ID]);

/** A mark drawn after a map's name in the map list: an icon, or a count of changes. */
export type MapBadge = { key: string; title: string } & ({ icon: string } | { diff: Counts });

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

/** Reset all per-map editing state to its initial values. */
function clearEditState() {
	Editor.setArea("overview");
	Import.reset();
	CommitDiff.reset();
}

/** Initialize map metadata and derived state on each open. */
function applyOpenedMap(meta: MapMeta | null, status: StoreStatus) {
	Feed.seed(status.version);
	Store.patch({ map: meta });
	Store.merge(status.derived, status.version);
}

/** Tear down all in-memory state for the open map. */
function resetMapState() {
	emitEvent("map:close");
	Store.patch({ mapId: null, map: null });

	clearEditState();

	Scene.clear();
	Feed.reset();
	Store.resetDerived();
}

export const Maps = {
	/** One-time store startup. The app calls this; plugins never need to. @unstable */
	init: async () => {
		await Maps.reload();
		// App-lifetime listeners: never unsubscribed, so the handles are dropped on purpose.
		void listen("map-list-changed", () => void Maps.reload());
		void listen<StoreWarning>("store-warning", (e) => toast(storeWarningText(e.payload), 8000));
	},
	/** Open a map in this window, closing any currently open map first. */
	open: async (id: string) => {
		mapOpen.begin();

		Autosave.cancel();
		await Autosave.waitForInflight();

		const t = trace("openMap");
		Store.patch({ mapId: id, map: null });
		const meta = await cmd.storeGetMap(id);
		t.step("getMap");

		if (meta) {
			try {
				const openResult = await cmd.storeOpenMap(id);
				t.step("store_open_map");
				mapOpen.mark("data");
				applyOpenedMap(meta, openResult);
				void Feed.start().catch((e: unknown) =>
					log.error("[openMap] change feed subscription failed:", e),
				);
			} catch (e) {
				log.error("[openMap] store_open_map failed:", e);
				Store.patch({ mapId: null, map: null });
				return;
			}
		}

		clearEditState();
		t.end();
		const opened = Store.get().map;
		if (opened) emitEvent("map:open", opened);
	},
	/** Close the open map, saving unsaved changes first. */
	close: async () => {
		await Autosave.flush();
		resetMapState();
		await cmd.storeCloseMap();
	},
	/** Drop the open map without persisting anything @unstable */
	discard: () => {
		Autosave.cancel();
		resetMapState();
	},
	/** Reactive list of all maps (metadata only). */
	useList: (): MapMeta[] => {
		return useEventValue("map-list:changed", () => cachedMapList);
	},
	/** The list of all maps (metadata only). */
	list: () => {
		return cachedMapList;
	},
	/** Refresh the map list from disk. @unstable */
	reload: async () => {
		cachedMapList = await cmd.storeListMaps();
		emitEvent("map-list:changed");
	},
	/** Refresh the map list and notify other windows of the change. @unstable */
	invalidate: async () => {
		await Maps.reload();
		await tauriEmit("map-list-changed");
	},
	/** Create a new empty map and return its metadata. */
	create: async (name: string, folder: string | null = null) => {
		const meta = await cmd.storeCreateMap(name, folder);
		await Maps.invalidate();
		return meta;
	},
	/** Copy a map, uncommitted edits included, into a new map named `name` and return its metadata. */
	duplicate: async (id: string, name: string) => {
		const meta = await cmd.storeDuplicateMap(id, name);
		await Maps.invalidate();
		return meta;
	},
	/** Permanently delete a map and all its data. Not undoable. */
	remove: async (id: string) => {
		await cmd.storeDeleteMap(id);
		await Maps.invalidate();
		await tauriEmit("map-deleted", id);
	},
	/** Open the scratch map, creating it on first use. */
	openScratch: async () => {
		const meta = await cmd.storeScratchMap();
		await openWindow({ type: "editor", mapId: meta.id }, meta.name);
	},
	/** Whether `id` belongs to an app fixture rather than a user-created map. @unstable */
	isReserved: (id: string | null): boolean => {
		return id != null && RESERVED_MAP_IDS.has(id);
	},
	/** The name a copy of the map named `name` starts with. @unstable */
	copyName: (name: string): string => {
		return t("{name} (copy)", { name: name || t("(unnamed)") });
	},
	/** Rename a folder, moving all its maps to the new name. */
	renameFolder: async (from: string, to: string) => {
		cachedMapList = cachedMapList.map((m) => (m.folder === from ? { ...m, folder: to } : m));
		emitEvent("map-list:changed");
		await cmd.storeRenameFolder(from, to);
		await Maps.invalidate();
	},
	/** Move a map into a folder, or to the root when `folder` is null. */
	moveToFolder: async (mapId: string, folder: string | null) => {
		const idx = cachedMapList.findIndex((m) => m.id === mapId);
		if (idx !== -1) {
			cachedMapList = cachedMapList.map((m) => (m.id === mapId ? { ...m, folder } : m));
			emitEvent("map-list:changed");
		}
		await Edit.meta({ id: mapId, folder });
	},
	/** Delete a folder. Maps in it become unfoldered. */
	removeFolder: async (name: string) => {
		await cmd.storeDeleteFolder(name);
		await Maps.invalidate();
	},
	/** Add a source of map-row badges. @unstable */
	registerBadges: (source: BadgeSource) => {
		badgeSources.push(source);
		subscribeMany(source.events, invalidateMapBadges);
		invalidateMapBadges();
	},
	/** Every registered badge source, in registration order. @unstable */
	badgeSources: (): readonly BadgeSource[] => {
		return badgeSources;
	},
	/** Badges per map id, from every registered source. @unstable */
	badges: (): Map<string, MapBadge[]> => {
		if (!collected) {
			const hidden = getSettings().hiddenMapBadges;
			collected = { hidden, badges: collectMapBadges(hidden) };
		}
		return collected.badges;
	},
	/** Reactive {@link Maps.badges}. @unstable */
	useBadges: (): Map<string, MapBadge[]> => {
		return useEventValue("map-badges:changed", Maps.badges);
	},
};

subscribe("map:saved", () => void Maps.invalidate());

subscribe("settings:changed", () => {
	if (collected && collected.hidden !== getSettings().hiddenMapBadges) invalidateMapBadges();
});

Maps.registerBadges({
	id: "pending",
	label: msg("Uncommitted changes"),
	events: ["map-list:changed"],
	*collect() {
		for (const m of cachedMapList) {
			const { added, removed, updated } = m.pending;
			if (added + removed + updated === 0) continue;
			yield [m.id, { key: "pending", diff: m.pending, title: t("Changes since the last commit") }];
		}
	},
});
