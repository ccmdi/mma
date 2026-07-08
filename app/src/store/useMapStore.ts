import { useEffect, useState, useSyncExternalStore } from "react";
import type { WorkArea, LatLng, MaybeLocation } from "@/types";
import {
	isVirtualLocation,
	isImportPreview,
	LocationFlag,
	locId,
	bboxTupleToBounds,
} from "@/types";
import type {
	Location,
	MapData,
	MapMeta,
	Tag,
	ExtraFieldDef,
	FilterOp,
	KeySpec,
	Scope,
	CommitDiff,
	PartitionBucket,
	EditorImportPreview,
} from "@/bindings.gen";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { emit as tauriEmit, listen } from "@tauri-apps/api/event";
import { cmd } from "@/lib/commands";
import type {
	MutationResult,
	MapMetaPatch_Deserialize as MapMetaPatch,
	SelectionSync,
	CommitInfo,
} from "@/bindings.gen";
import { emit as emitEvent } from "@/lib/events";
import { log, fireAndForget } from "@/lib/util/log";
import { hexToRgb } from "@/lib/util/color";
import { trace } from "@/lib/util/debug";
import { nowUnix } from "@/lib/util/format";
import { mmaBufUrl, compareNatural } from "@/lib/util/util";
import { fitMapToBounds } from "@/lib/map/mapState";
import { getSettings, setSetting } from "@/store/settings";
import { getTriggeredProviders } from "@/lib/data/fieldDefs";
import {
	setUserFieldDefs,
	mergeUserFieldDefs,
	resetForMapChange,
} from "@/lib/data/fieldDefRegistry";
import {
	planFieldMove,
	planFieldDelete,
	rewriteSelectionFields,
	type MergeWinner,
} from "@/lib/data/fieldOps";
import type { LocationPatch_Deserialize as LocationPatch, Update, TagPatch } from "@/bindings.gen";
import { getSavedSelections, rewriteSavedSelectionFields } from "./savedSelections";
import type { RenderDelta } from "@/bindings.gen";
import {
	SelectedIds,
	decodeSelectionBitmask,
	type ReadonlyIdSet,
	type SelCellEntry,
} from "@/lib/render/CellManager";
import { whenSceneSettled } from "@/lib/render/sceneStore";

/** Minimal pub/sub bus. `.on()` returns an unsubscribe function. */
function createBus<T extends (...args: never[]) => void>() {
	let handlers: T[] = [];
	return {
		on: (fn: T) => {
			handlers.push(fn);
			return () => {
				handlers = handlers.filter((h) => h !== fn);
			};
		},
		emit: ((...args: Parameters<T>) => {
			for (const h of handlers) h(...args);
		}) as T,
	};
}

/** Fires when Rust sends incremental render changes (adds/removes/patches to cell buffers). */
export const renderDeltaBus = createBus<(delta: RenderDelta) => void>();

type SelectionBitmaskHandler = (
	selColors: [number, number, number][],
	cellEntries: SelCellEntry[],
	setIds: (ids: SelectedIds) => void,
) => void;
/** Fires when selection bitmasks are resolved. Subscribers apply per-cell masks to the render overlay. */
export const selBitmaskBus = createBus<SelectionBitmaskHandler>();

import type { Selection, SelectionProps, PolygonGeometry } from "@/bindings.gen";
import {
	type GroupType,
	addSelection as addSel,
	removeSelection as removeSel,
	intersectSelections,
	unionSelections,
	invertSelections,
	toggleManualSelection as toggleManual,
	setPolygonName as renamePolygonSel,
	setSelectionColors as setSelColor,
	reorderSelections,
	composeSelections as composeSels,
	composeWithChild as composeWithChildSel,
	decomposeChild as decomposeChildSel,
	removeFromComposite as removeFromCompositeSel,
	composeSiblings as composeSiblingsSel,
	replaceSelection as replaceSel,
	sampleIds,
	isolateGhostKeys,
} from "./selections";

const storeBus = createBus<() => void>();
const subscribe = storeBus.on;
const notify = storeBus.emit;

/** Subscribe to any store mutation (map open/close, rename, edits, ...). */
export const subscribeStore = subscribe;

/** Build a reactive store hook: subscribe to the bus, return the latest value. */
function makeStoreHook<T>(getValue: () => T, snapshot: () => number = getMapSnapshot): () => T {
	return function useStoreValue(): T {
		useSyncExternalStore(subscribe, snapshot);
		return getValue();
	};
}

// --- Map list state ---
let mapListVersion = 0;
function getMapListSnapshot() {
	return mapListVersion;
}

let cachedMapList: MapMeta[] = [];
export const useMapList = makeStoreHook(() => cachedMapList, getMapListSnapshot);
export const getMapList = () => cachedMapList;

async function reloadMapList() {
	cachedMapList = await cmd.storeListMaps();
	mapListVersion++;
	notify();
}

export async function invalidateMapList() {
	await reloadMapList();
	tauriEmit("map-list-changed");
}

// --- Current map state ---
let currentMapId: string | null = null;
let currentMap: MapData | null = null;
/** Persisted bitmasks per selection key. Updated incrementally on each
 *  mutation (delta refresh) when the column store is available. */
let selections: Selection[] = [];
/** Resolved count per selection node (top-level and nested), keyed by `Selection.key`.
 *  The sole source for sidebar counts — refreshed wholesale from Rust on every sync. */
let selectionCounts: Record<string, number> = {};
/** Keys of selections that are "ghosted": kept in the list but excluded from the
 *  Rust sync, so they neither render nor count toward the selected set. Ephemeral. */
const ghostedSelections = new Set<string>();
let selectedLocationIds: SelectedIds = SelectedIds.EMPTY;
let activeLocationId: number | null = null;
let duplicateLocations: Location[] = [];
let workArea: WorkArea = "overview";
let activePluginId: string | null = null;
let mapVersion = 0;
let tagCounts: Record<number, number> = {};
let undoRedoState = { canUndo: false, canRedo: false };
/** Extra-field keys known to exist in location data on the current map.
 *  Populated from `StoreStatus.knownFieldKeys` on map open, extended
 *  incrementally via `MutationResult.newFieldDefs`.
 *  Treat as immutable -- reassign, never mutate in place: consumers memo on
 *  the Set's reference identity (`useMemo(..., [keys])`). */
let knownFieldKeys = new Set<string>();

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
	preview: EditorImportPreview;
	source: "file" | "paste";
}
let importStaging: ImportStaging | null = null;
/** Interleaved `[lng, lat]` f32 preview-marker positions; `importMarkerVersion` bumps to rebuild the layer. */
let importPreviewPositions = new Float32Array(0);
let importMarkerVersion = 0;

/** Ephemeral commit-diff overlay shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` f32; `diffMarkerVersion` bumps to rebuild the layers. */
export interface CommitDiffPreview {
	commitId: string;
	hash: string;
	counts: CommitDiff;
	added: Float32Array;
	removed: Float32Array;
	modified: Float32Array;
}
let commitDiffPreview: CommitDiffPreview | null = null;
let diffMarkerVersion = 0;

export const useTagCounts = makeStoreHook(() => tagCounts);

export function getTagCounts() {
	return tagCounts;
}

async function computeCommitDiff(): Promise<CommitDiff> {
	const [added, removed, modified] = await cmd.storeCommitDiff();
	return { added, removed, modified };
}

function getMapSnapshot() {
	return mapVersion;
}

/** Mark the current map's content dirty and re-render its consumers. */
function bump() {
	mapVersion++;
	notify();
}

export function refreshAfterMutation() {
	if (!currentMap) {
		selections = [];
		selectedLocationIds = SelectedIds.EMPTY;
		bump();
		return;
	}
	bump();
}

export const useCurrentMap = makeStoreHook(() => currentMap);

/** Tags that exist from the user's point of view. Raw `meta.tags` also holds soft-deleted ghosts (count=0, visible=false, kept for undo revival) — almost nothing outside the undo/revival machinery should enumerate those. Cached on the tag-set reference (reassigned on every tag mutation) so repeated calls return the same array and memo deps stay stable. */
let visibleTagsCache: { tags: MapData["meta"]["tags"]; list: Tag[] } | null = null;
export function getVisibleTags(): Tag[] {
	if (!currentMap) return [];
	const tags = currentMap.meta.tags;
	if (!visibleTagsCache || visibleTagsCache.tags !== tags) {
		visibleTagsCache = {
			tags,
			list: Object.values(tags).filter((t) => t.visible !== false),
		};
	}
	return visibleTagsCache.list;
}

export const useVisibleTags = makeStoreHook(getVisibleTags);

/** Raw by-id tag lookup — includes soft-deleted ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
export function getTag(id: number): Tag | undefined {
	return currentMap?.meta.tags[id];
}

export const useMapVersion = makeStoreHook(() => mapVersion);
export const useSelectedLocationIds = makeStoreHook(() => selectedLocationIds);

let cachedActiveLocation: Location | null = null;
export const useActiveLocation = makeStoreHook((): Location | null => cachedActiveLocation);
export const useDuplicateLocations = makeStoreHook(() => duplicateLocations);

export const useWorkArea = makeStoreHook(() => workArea);
export const useImportStaging = makeStoreHook(() => importStaging);
export const useImportMarkerVersion = makeStoreHook(() => importMarkerVersion);

export function getImportPreviewPositions() {
	return importPreviewPositions;
}

export const useCommitDiffPreview = makeStoreHook(() => commitDiffPreview);
export const useDiffMarkerVersion = makeStoreHook(() => diffMarkerVersion);

export function getCommitDiffPreview() {
	return commitDiffPreview;
}

let cachedCommitDiff = { added: 0, removed: 0, modified: 0 };

export function hasCommitDiff(): boolean {
	return (
		cachedCommitDiff.added > 0 || cachedCommitDiff.removed > 0 || cachedCommitDiff.modified > 0
	);
}

export function useCommitDiff() {
	const version = useSyncExternalStore(subscribe, getMapSnapshot);
	useEffect(() => {
		computeCommitDiff().then((d) => {
			if (
				d.added !== cachedCommitDiff.added ||
				d.removed !== cachedCommitDiff.removed ||
				d.modified !== cachedCommitDiff.modified
			) {
				cachedCommitDiff = d;
				bump();
			}
		});
	}, [version]);
	return cachedCommitDiff;
}

// --- Autosave ---
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let inflightPersist: Promise<void> | null = null;
const AUTOSAVE_DELAY_MS = 2000;

export async function getDirtyCount(): Promise<number> {
	const result = await cmd.storeGetSummary();
	return result.dirtyCount;
}

export function scheduleSave() {
	if (autosaveTimer) clearTimeout(autosaveTimer);
	autosaveTimer = setTimeout(() => {
		autosaveTimer = null;
		doSave();
	}, AUTOSAVE_DELAY_MS);
}

function cancelAutosave() {
	if (autosaveTimer) {
		clearTimeout(autosaveTimer);
		autosaveTimer = null;
	}
}

async function doSave(): Promise<void> {
	if (!currentMapId || !currentMap) return;
	await inflightPersist;

	const t = trace("save");
	inflightPersist = cmd
		.storeSaveDirty()
		.then(() => {
			t.end();
			invalidateMapList();
		})
		.catch((err) => {
			scheduleSave();
			log.error("Autosave failed, will retry:", err);
		})
		.finally(() => {
			inflightPersist = null;
		});
	await inflightPersist;
}

export async function flushSave(): Promise<void> {
	cancelAutosave();
	await doSave();
}

// --- Init (called once at startup) ---
export async function initStore() {
	cachedMapList = await cmd.storeListMaps();
	notify();
	listen("map-list-changed", () => reloadMapList());
}

/** Cross-module stopwatch for map-open latency. */
export const mapOpen = {
	start: 0,
	seen: new Set<string>(),
	begin() {
		this.start = performance.now();
		this.seen.clear();
	},
	mark(phase: string) {
		if (!this.start || this.seen.has(phase)) return;
		this.seen.add(phase);
		log.info(`[map-open] ${phase}=${Math.round(performance.now() - this.start)}ms`);
	},
};

// --- Actions ---
export async function openMap(id: string) {
	mapOpen.begin();

	cancelAutosave();
	await inflightPersist;

	const t = trace("openMap");
	currentMapId = id;
	currentMap = null;
	notify();
	const meta = await cmd.storeGetMap(id);
	t.step("getMap");

	if (meta) {
		try {
			const openResult = await cmd.storeOpenMap(id);
			t.step("store_open_map");
			mapOpen.mark("data");
			currentMap = meta;
			tagCounts = openResult.tagCounts;
			undoRedoState = { canUndo: openResult.canUndo, canRedo: openResult.canRedo };
			knownFieldKeys = new Set(openResult.knownFieldKeys);
			setUserFieldDefs(meta.meta.extra?.fields ?? {});
		} catch (e) {
			log.error("[openMap] store_open_map failed:", e);
			currentMap = null;
			currentMapId = null;
			notify();
			return;
		}
		cmd.storeTouchMapOpened(id);
	}

	selections = [];
	selectedLocationIds = SelectedIds.EMPTY;
	activeLocationId = null;
	workArea = "overview";
	importStaging = null;
	importPreviewPositions = new Float32Array(0);
	commitDiffPreview = null;

	bump();
	t.end();
	if (currentMap) emitEvent("map:open", currentMap);
}

/** Tear down all in-memory state for the open map. */
function resetMapState() {
	emitEvent("map:close");
	currentMapId = null;
	currentMap = null;

	selections = [];
	selectedLocationIds = SelectedIds.EMPTY;
	activeLocationId = null;
	workArea = "overview";
	importStaging = null;
	importPreviewPositions = new Float32Array(0);
	knownFieldKeys = new Set();
	resetForMapChange();

	renderDeltaBus.emit({ added: [], updated: [], removed: [], colorPatches: [], fullReset: true });
	undoRedoState = { canUndo: false, canRedo: false };
	tagCounts = {};
	bump();
}

export async function closeMap() {
	await flushSave();
	resetMapState();
	await cmd.storeCloseMap();
}

/* Drop the open map without persisting anything */
export function discardOpenMap() {
	cancelAutosave();
	resetMapState();
}

export function getCurrentMapId() {
	return currentMapId;
}

export function getCurrentMap() {
	return currentMap;
}

/** Returns the set of extra-field keys known to exist on the current map. */
export function getKnownFieldKeys(): ReadonlySet<string> {
	return knownFieldKeys;
}

/** Reactive hook for `knownFieldKeys`. Re-renders when keys are added. */
export const useKnownFieldKeys = makeStoreHook((): ReadonlySet<string> => knownFieldKeys);

export function getActiveLocation(): Location | null {
	return cachedActiveLocation;
}

export async function fetchAllLocations(): Promise<Location[]> {
	const path = await cmd.storeGetAllLocations();
	const res = await fetch(mmaBufUrl(path));
	return res.json();
}

export async function fetchLocation(id: number): Promise<Location | null> {
	return cmd.storeGetLocation(id);
}

export async function fetchLocationsByIds(ids: number[]): Promise<Location[]> {
	return cmd.storeGetLocationsByIds(ids);
}

/** All selections including ghosted. Only for rendering/UI that needs the full list. */
export function getAllSelections() {
	return selections;
}

/** Active (non-ghosted) selections, the default for any operational logic. */
export function getSelections() {
	if (ghostedSelections.size === 0) return selections;
	return selections.filter((s) => !ghostedSelections.has(s.key));
}

export function getSelectedLocationIds() {
	return selectedLocationIds;
}

export function setSelectedLocationIds(ids: SelectedIds) {
	selectedLocationIds = ids;
}

/** @internal Test-only. Forces a full selection re-resolve in Rust and returns
 *  the raw selected IDs. App code should use getSelectedLocationIds() instead —
 *  mutations already sync selections via MutationResult. */
export async function syncSelections(): Promise<{ ids: number[] }> {
	const sels = buildSyncInputs();
	if (sels.length === 0) return { ids: [] };
	await cmd.storeSyncSelections(sels);
	const ids = await cmd.storeGetSelectedIdsList();
	return { ids };
}

export interface ScopeController {
	scope: Scope;
	setScope: (s: Scope) => void;
	allCount: number;
	selectionCount: number;
}

/** Narrow a materialized pool of id-bearing records to the scope's subset (JS-side). */
export function applyScope<T extends { id: number }>(scope: Scope, pool: T[]): T[] {
	if (scope.kind === "all") return pool;
	const ids = getSelectedLocationIds();
	return pool.filter((item) => ids.has(item.id));
}

/** Group the scoped location set by a derived key — entirely in Rust, no locations fetched.
 *  Numeric bins arrive in bound order; projection keys are sorted naturally for display. */
export async function partition(
	field: string,
	key: KeySpec,
	scope: Scope,
): Promise<PartitionBucket[]> {
	const groups = await cmd.storePartition(field, key, scope);
	if (key.kind !== "numericBin") groups.sort((a, b) => compareNatural(a.key, b.key));
	return groups;
}

function defaultScope(): Scope {
	return getSelectedLocationIds().size > 0 ? { kind: "selected" } : { kind: "all" };
}

/** Reactive scope state + live counts, owned by the calling React component. Defaults to
 *  the current selection when one exists at mount, else all locations. Use this for plugins
 *  whose scope lives entirely in a React sidebar; reach for `createScope` when an imperative
 *  renderer (e.g. a deck.gl overlay) outside React also needs to read the scope. */
export function useScope(initial?: Scope): ScopeController {
	const selectedIds = useSelectedLocationIds();
	const map = useCurrentMap();
	const [scope, setScope] = useState<Scope>(() => initial ?? defaultScope());
	return {
		scope,
		setScope,
		allCount: map?.meta.locationCount ?? 0,
		selectionCount: selectedIds.size,
	};
}

/** A per-consumer scope store that lives outside React, so an imperative renderer can read it
 *  synchronously and subscribe to changes while a React sidebar drives it via `use()`. Mirrors
 *  the module-store + hook idiom (cf. settings). Isolated per call — one consumer's choice never
 *  leaks into another's. */
export interface ScopeHandle {
	get(): Scope;
	set(scope: Scope): void;
	subscribe(listener: () => void): () => void;
	/** React view of this handle: re-renders on change, with live counts. */
	use(): ScopeController;
}

export function createScope(initial?: Scope): ScopeHandle {
	let scope: Scope = initial ?? defaultScope();
	const listeners = new Set<() => void>();
	const get = () => scope;
	const set = (next: Scope) => {
		if (next.kind === scope.kind) return;
		scope = next;
		for (const l of listeners) l();
	};
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	return {
		get,
		set,
		subscribe,
		use(): ScopeController {
			useSyncExternalStore(subscribe, get);
			const selectedIds = useSelectedLocationIds();
			const map = useCurrentMap();
			return {
				scope,
				setScope: set,
				allCount: map?.meta.locationCount ?? 0,
				selectionCount: selectedIds.size,
			};
		},
	};
}

export async function createMap(name: string, folder: string | null = null) {
	const { meta } = await cmd.storeCreateMap(name, folder);
	await invalidateMapList();
	return meta;
}

export async function deleteMap(id: string) {
	await cmd.storeDeleteMap(id);
	await invalidateMapList();
	// Tell every window (including this one) showing this map to close it.
	tauriEmit("map-deleted", id);
}

export async function renameFolder(from: string, to: string) {
	cachedMapList = cachedMapList.map((m) => (m.folder === from ? { ...m, folder: to } : m));
	mapListVersion++;
	notify();
	await cmd.storeRenameFolder(from, to);
	await invalidateMapList();
}

export async function moveMapToFolder(mapId: string, folder: string | null) {
	const idx = cachedMapList.findIndex((m) => m.id === mapId);
	if (idx !== -1) {
		cachedMapList = cachedMapList.map((m) => (m.id === mapId ? { ...m, folder } : m));
		mapListVersion++;
		notify();
	}
	await cmd.storeUpdateMapMeta(mapId, { folder: folder ?? null });
	tauriEmit("map-list-changed");
}

export async function deleteFolder(name: string) {
	await cmd.storeDeleteFolder(name);
	await invalidateMapList();
}

export async function renameMap(id: string, name: string) {
	await cmd.storeUpdateMapMeta(id, { name });
	if (currentMap && currentMapId === id) currentMap.meta.name = name;
	refreshAfterMutation();
	await invalidateMapList();
}

export async function updateMapLabels(id: string, labels: string[]) {
	await cmd.storeUpdateMapMeta(id, { labels });
	if (currentMap && currentMapId === id) currentMap.meta.labels = labels;
	await invalidateMapList();
}

export async function updateMapMeta(patch: MapMetaPatch) {
	if (!currentMapId || !currentMap) return;
	if (patch.name != null) currentMap.meta.name = patch.name;
	if (patch.description != null) currentMap.meta.description = patch.description;
	if (patch.folder !== undefined) currentMap.meta.folder = patch.folder;
	if (patch.settings != null) currentMap.meta.settings = patch.settings;
	if (patch.scoreBounds != null) currentMap.meta.scoreBounds = patch.scoreBounds;
	if (patch.extra != null) currentMap.meta.extra = patch.extra;
	refreshAfterMutation();
	await cmd.storeUpdateMapMeta(currentMapId, patch);
	await invalidateMapList();
}

export async function setMapExtraFields(fields: Record<string, ExtraFieldDef>) {
	if (!currentMapId || !currentMap) return;
	const current = currentMap.meta.extra ?? {};
	const replaced = { ...current, fields };
	currentMap = { ...currentMap, meta: { ...currentMap.meta, extra: replaced } };
	setUserFieldDefs(fields);
	bump();
	await cmd.storeUpdateMapMeta(currentMapId, { extra: replaced } as Partial<MapMeta>);
}

/** Sync JS-side state (location count, undo/redo, tag counts, field keys, selections) from a Rust MutationResult. */
function syncMutationResult(r: MutationResult) {
	if (!currentMap) return;
	const hasNewDefs = r.newFieldDefs != null && Object.keys(r.newFieldDefs).length > 0;
	const needsNotify =
		currentMap.meta.locationCount !== r.locationCount ||
		undoRedoState.canUndo !== r.canUndo ||
		undoRedoState.canRedo !== r.canRedo ||
		hasNewDefs ||
		r.tags != null;
	if (hasNewDefs) {
		knownFieldKeys = new Set(knownFieldKeys);
		for (const key of Object.keys(r.newFieldDefs!)) knownFieldKeys.add(key);
		mergeUserFieldDefs(r.newFieldDefs!);
	}
	currentMap = {
		...currentMap,
		meta: {
			...currentMap.meta,
			locationCount: r.locationCount,
		},
	};
	undoRedoState = { canUndo: r.canUndo, canRedo: r.canRedo };
	tagCounts = r.tagCounts;
	if (needsNotify) {
		bump();
	}
	if (r.tags) {
		const oldTags = currentMap.meta.tags;
		currentMap = { ...currentMap, meta: { ...currentMap.meta, tags: r.tags } };
		const removedKeys: string[] = [];
		for (const idStr of Object.keys(oldTags)) {
			const id = Number(idStr);
			const was = oldTags[id];
			const now = r.tags[id];
			if (was && was.visible !== false && (!now || now.visible === false)) {
				removedKeys.push(`tag:${id}`);
			}
		}
		removeSelections(removedKeys);
	}
	if (r.selectionSync) {
		applySelectionSync(r.selectionSync);
	}
}

/** Decode the inline bitmask bytes from Rust and emit to selBitmaskBus. */
export function emitBitmask(bytes: number[]) {
	const { selColors, cellEntries } = decodeSelectionBitmask(bytes);
	selBitmaskBus.emit(selColors, cellEntries, (ids) => {
		selectedLocationIds = ids;
	});
}

/** Apply a resolved selection payload (counts + overlay bitmask) to JS state and re-render.
 *  Shared by both triggers: location mutations (membership changed) and selection edits. */
function applySelectionSync(sync: SelectionSync) {
	selectionCounts = sync.counts;
	if (sync.bitmask) emitBitmask(sync.bitmask);
	bump();
}

/** Await a mutation IPC, emit its render delta, sync JS state, and schedule a save. */
export async function mutate(p: Promise<MutationResult>): Promise<MutationResult> {
	const r = await p;
	await inflightPersist;
	renderDeltaBus.emit(r.delta);
	syncMutationResult(r);
	refreshAfterMutation();
	scheduleSave();
	return r;
}

export async function addLocations(locs: Location[], opts?: { hideInDelta?: boolean }) {
	if (!currentMap || locs.length === 0) return;
	const t = trace("add");
	const r = await mutate(cmd.storeAddLocations(locs));
	t.end({ delta: `+${r.delta.added.length} -${r.delta.removed.length}` });
	for (let i = 0; i < r.delta.added.length && i < locs.length; i++) {
		locs[i].id = r.delta.added[i].id;
	}
	if (opts?.hideInDelta) {
		for (const entry of r.delta.added) entry.a = 0;
	}
	emitEvent("location:add", locs);
}

export async function duplicateLocation(id: number): Promise<number | null> {
	if (!currentMap || isVirtualLocation({ id })) return null;
	const loc = await cmd.storeGetLocation(id);
	if (!loc) return null;
	const now = nowUnix();
	const clone: Location = { ...loc, id: 0, createdAt: now, modifiedAt: now };
	await addLocations([clone]);
	return clone.id;
}

export async function removeLocations(ids: ReadonlyIdSet) {
	if (!currentMap || ids.size === 0) return;
	if ([...ids].some((id) => isVirtualLocation({ id }))) {
		await setActiveLocation(null);
		return;
	}
	if (activeLocationId && ids.has(activeLocationId)) {
		activeLocationId = null;
		cachedActiveLocation = null;
		workArea = "overview";
	}
	bump();
	emitEvent("location:remove", [...ids]);
	await mutate(cmd.storeRemoveLocations([...ids])).catch((e) =>
		log.error("[delete] store_remove_locations failed:", e),
	);
}

export async function updateLocations(
	updates: Update<LocationPatch>[],
	opts?: { undoable?: boolean },
) {
	if (!currentMap || updates.length === 0) return;
	if (updates.some((u) => isVirtualLocation(u))) return;
	emitEvent("location:update", updates);
	await mutate(cmd.storeUpdateLocations(updates, opts?.undoable ?? true));
	if (cachedActiveLocation && updates.some((u) => u.id === activeLocationId)) {
		const activePatch = updates.find((u) => u.id === activeLocationId)?.patch;
		if (activePatch) cachedActiveLocation = { ...cachedActiveLocation, ...activePatch } as Location;
		bump();
	}
}

// --- Bulk metadata-field operations ---

/** Rename or merge extra-field `from` into `to` across all locations, then migrate
 *  its definition and every selection that references it. Merge ≡ rename; `winner`
 *  decides the survivor only where a location already holds `to`. */
export async function renameField(from: string, to: string, winner: MergeWinner = "from") {
	if (!currentMap || from === to || !to) return;
	const updates = planFieldMove(await fetchAllLocations(), from, to, winner);
	const nextKeys = new Set(knownFieldKeys);
	if (updates.length) {
		await updateLocations(updates, { undoable: false });
		nextKeys.add(to);
	}
	nextKeys.delete(from);
	knownFieldKeys = nextKeys;
	await migrateFieldReferences(from, to);
}

/** Delete extra-field `key` from every location, its definition, and references. */
export async function deleteField(key: string) {
	if (!currentMap) return;
	const updates = planFieldDelete(await fetchAllLocations(), key);
	if (updates.length) {
		await updateLocations(updates, { undoable: false });
	}
	knownFieldKeys = new Set(knownFieldKeys);
	knownFieldKeys.delete(key);
	await migrateFieldReferences(key, null);
}

/** Migrate field definition + active/saved selection references after a data move. */
async function migrateFieldReferences(from: string, to: string | null) {
	if (!currentMap) return;
	const defs = { ...(currentMap.meta.extra?.fields ?? {}) };
	if (defs[from]) {
		if (to && !defs[to]) defs[to] = defs[from];
		delete defs[from];
		await setMapExtraFields(defs);
	}
	setSetting("savedSelections", rewriteSavedSelectionFields(getSavedSelections(), from, to));
	await applySelectionUpdate((sels) => rewriteSelectionFields(sels, from, to));
}

export async function patchLocationExtra(
	loc: Location,
	extraPatch: Record<string, unknown>,
	replace = false,
) {
	if (!currentMap) return;
	if (isVirtualLocation(loc)) return;
	const extra = replace ? extraPatch : { ...loc.extra, ...extraPatch };
	await mutate(cmd.storeUpdateLocations([{ id: loc.id, patch: { extra } }], false));

	const patched = { ...loc, extra };
	if (activeLocationId === loc.id) {
		cachedActiveLocation = patched;
		bump();
	}

	const triggered = getTriggeredProviders(Object.keys(extraPatch));
	if (triggered.length > 0) {
		const enrichFields = currentMap?.meta.settings.enrichFields ?? null;
		// Merge all triggered providers against the same base before writing once,
		// so they don't clobber each other's fields.
		const results = await Promise.all(
			triggered.map((provider) =>
				provider.enrich([patched], enrichFields).then((m) => m.get(loc.id)),
			),
		);
		const merged = Object.assign({}, ...results.filter(Boolean));
		if (Object.keys(merged).length > 0) await patchLocationExtra(patched, merged);
	}
}

// --- Selections ---

/** All selections including ghosted. Only for rendering/UI that needs the full list. */
export const useAllSelections = makeStoreHook(() => selections);

/** Active (non-ghosted) selections — the default for any operational logic. */
export const useSelections = makeStoreHook(() =>
	ghostedSelections.size === 0
		? selections
		: selections.filter((s) => !ghostedSelections.has(s.key)),
);

/** Keyed per-node selection counts (by `Selection.key`). Look up a row's count by its key. */
export const useSelectionCounts = makeStoreHook(() => selectionCounts);

export function getSelectionCounts() {
	return selectionCounts;
}

/** Resolve a selection's overlay color, substituting the live tag color for Tag selections. */
function selectionSyncColor(s: Selection): [number, number, number] {
	if (s.props.type === "Tag" && currentMap) {
		const tag = currentMap.meta.tags[s.props.tagId];
		if (tag) return hexToRgb(tag.color);
	}
	return s.color;
}

/** All selections, each flagged ghosted or not. Rust counts every one, renders/selects only non-ghosted. */
function buildSyncInputs() {
	return selections.map((s) => ({
		key: s.key,
		props: s.props,
		color: selectionSyncColor(s),
		ghosted: ghostedSelections.has(s.key),
	}));
}

/** Apply a pure selection transform, then IPC to Rust to resolve bitmasks and sync the overlay. */
async function applySelectionUpdate(updater: (sels: Selection[]) => Selection[]) {
	if (!currentMap) return;
	const t = trace("selection", { summary: true });
	selections = updater(selections);
	pruneGhosted();
	const sels = buildSyncInputs();
	const result = await cmd.storeSyncSelections(sels);
	t.step("ipc");
	applySelectionSync(result);
	t.step("apply");
	t.end({ selected: result.selectedCount });
	emitEvent("selection:change", selections);
}

/** Drop ghosted keys that no longer correspond to a live selection. */
function pruneGhosted() {
	if (ghostedSelections.size === 0) return;
	const live = new Set(selections.map((s) => s.key));
	for (const k of ghostedSelections) if (!live.has(k)) ghostedSelections.delete(k);
}

export const useGhostedSelections = makeStoreHook(() => ghostedSelections);

/** Toggle a selection's ghosted state and re-sync (excludes/includes it from the overlay). */
export function toggleGhostSelection(key: string) {
	if (ghostedSelections.has(key)) ghostedSelections.delete(key);
	else ghostedSelections.add(key);
	return applySelectionUpdate((sels) => sels);
}

/** "Solo" a selection: ghost every other top-level selection, keep this one visible.
 *  If it is already the only visible one, un-ghost everything (toggle back). */
export function isolateSelection(key: string) {
	const next = isolateGhostKeys(
		selections.map((s) => s.key),
		ghostedSelections,
		key,
	);
	ghostedSelections.clear();
	for (const k of next) ghostedSelections.add(k);
	return applySelectionUpdate((sels) => sels);
}

/** Ghost every top-level selection; if all are already ghosted, un-ghost them all. */
export function toggleGhostAllSelections() {
	const keys = selections.map((s) => s.key);
	const allGhosted = keys.length > 0 && keys.every((k) => ghostedSelections.has(k));
	if (allGhosted) ghostedSelections.clear();
	else for (const k of keys) ghostedSelections.add(k);
	return applySelectionUpdate((sels) => sels);
}

export function addSelections(props: SelectionProps[]) {
	return applySelectionUpdate((sels) => {
		let result = sels;
		for (const p of props) result = addSel(result, p);
		return result;
	});
}

/** No-op (no sync) when none of the keys are live selections. */
export function removeSelections(keys: string[]) {
	const live = new Set(selections.map((s) => s.key));
	const present = keys.filter((k) => live.has(k));
	if (present.length === 0) return;
	return applySelectionUpdate((sels) => {
		let result = sels;
		for (const k of present) result = removeSel(result, k);
		return result;
	});
}

export function resetSelections() {
	return applySelectionUpdate(() => []);
}

export function selectIntersection(keys: string[] | null = null) {
	return applySelectionUpdate((sels) => intersectSelections(sels, keys));
}

export function selectUnion(keys: string[] | null = null) {
	return applySelectionUpdate((sels) => unionSelections(sels, keys));
}

export function selectInverse(keys: string[] | null = null) {
	return applySelectionUpdate((sels) => invertSelections(sels, keys));
}

export function toggleManualSelection(locationId: number) {
	return applySelectionUpdate((sels) => toggleManual(sels, locationId));
}

/** Replace the current selection with a single Manual selection holding `count` ids picked
 *  at random from whatever is currently selected. `count` is clamped to the selection size.
 *  No-op when nothing is selected. Returns the number of ids actually picked. */
export function selectRandomFromSelection(count: number): number {
	const ids = Array.from(getSelectedLocationIds());
	const picked = sampleIds(ids, count);
	if (picked.length === 0) return 0;
	void applySelectionUpdate(() => addSel([], { type: "Manual", locations: picked }));
	return picked.length;
}

export function selectEverything() {
	return addSelections([{ type: "Everything" }]);
}

export function selectUntagged() {
	return addSelections([{ type: "Untagged" }]);
}

export function selectUnpanned() {
	return addSelections([{ type: "Unpanned" }]);
}

export function selectPanoIds() {
	return addSelections([{ type: "PanoIds" }]);
}

export function selectNotPanoIds() {
	return addSelections([{ type: "NotPanoIds" }]);
}

export function selectUncommitted() {
	return addSelections([{ type: "Uncommitted" }]);
}

export function selectDuplicates(distance: number) {
	return addSelections([{ type: "Duplicates", distance }]);
}

/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. */
export function previewDuplicateGroups(distance: number): Promise<number[][]> {
	return cmd.storeDuplicateGroups(distance);
}

/** Merge each transitive duplicate group into one survivor (tags unioned). One undoable edit. */
export async function mergeDuplicates(distance: number) {
	if (!currentMap) return;
	await mutate(cmd.storeMergeDuplicates(distance));
}

/**
 * Prune duplicates within a resolved selection: keeps the most relevant location per
 * cluster (<= 25m) or thins to enforce spacing (> 25m). Locations tagged "keep pano"
 * get a +5 score bonus. Returns the number pruned.
 */
export async function pruneDuplicates(props: SelectionProps, distance: number): Promise<number> {
	if (!currentMap) return 0;
	const ids = await cmd.storeResolveSelection(props);
	if (ids.length === 0) return 0;
	const keepTagIds = getVisibleTags()
		.filter((t) => t.name === "keep pano")
		.map((t) => t.id);
	const r = await mutate(cmd.storePruneDuplicates(ids, distance, keepTagIds));
	return r.delta.removed.length;
}

export function selectTag(tagId: number) {
	return addSelections([{ type: "Tag", tagId }]);
}

export function selectPolygon(polygon: PolygonGeometry, includeInformational = false) {
	return addSelections([{ type: "Polygon", polygon, includeInformational }]);
}

export function selectFilter(
	field: string,
	op: FilterOp,
	value: unknown,
	value2?: unknown,
	tzLocal = false,
) {
	return addSelections([{ type: "Filter", field, op, value, value2, tzLocal }]);
}

export function selectTopK(field: string, k: number, ascending: boolean) {
	return addSelections([{ type: "TopK", field, k, ascending }]);
}

/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
export function updateFilterSelection(oldKey: string, props: SelectionProps) {
	return applySelectionUpdate((sels) => {
		const next = replaceSel(sels, oldKey, props);
		// Carry a ghost flag across an in-place re-key. A collision instead merges into the
		// existing selection (shrinking the list); the survivor keeps its own ghost state and
		// pruneGhosted clears the old key, so only migrate when nothing was merged away.
		if (next.length === sels.length) {
			for (let i = 0; i < sels.length; i++) {
				if (next[i].key !== sels[i].key && ghostedSelections.has(sels[i].key)) {
					ghostedSelections.delete(sels[i].key);
					ghostedSelections.add(next[i].key);
				}
			}
		}
		return next;
	});
}

export function setPolygonName(key: string, name: string) {
	return applySelectionUpdate((sels) => renamePolygonSel(sels, key, name));
}

export function setSelectionColors(entries: { key: string; color: [number, number, number] }[]) {
	applySelectionUpdate((sels) => {
		let result = sels;
		for (const { key, color } of entries) result = setSelColor(result, key, color);
		return result;
	});
}

export function reorderSelection(fromKey: string, toKey: string, position: "before" | "after") {
	applySelectionUpdate((sels) => reorderSelections(sels, fromKey, toKey, position));
}

export function composeSelections(
	dragKey: string,
	dropKey: string,
	mode: GroupType,
	dragParent: string | null,
	dropParent: string | null,
) {
	applySelectionUpdate((sels) => {
		if (dragParent && dropParent && dragParent === dropParent) {
			return composeSiblingsSel(sels, dragParent, dragKey, dropKey, mode);
		}
		const updated = dragParent ? decomposeChildSel(sels, dragParent, dragKey) : sels;
		if (dropParent) {
			return composeWithChildSel(updated, dragKey, dropParent, dropKey, mode);
		}
		return composeSels(updated, dragKey, dropKey, mode);
	});
}

export function decomposeChild(parentKey: string, childKey: string) {
	applySelectionUpdate((sels) => decomposeChildSel(sels, parentKey, childKey));
}

export function removeChildFromSelection(parentKey: string, childKey: string) {
	applySelectionUpdate((sels) => removeFromCompositeSel(sels, parentKey, childKey));
}

export function toggleTagSelections(tagIds: number[]) {
	if (!currentMap || tagIds.length === 0) return;
	applySelectionUpdate((sels) => {
		let result = sels;
		for (const tagId of tagIds) {
			const key = `tag:${tagId}`;
			const exists = result.some((s) => s.key === key);
			if (exists) result = removeSel(result, key);
			else result = addSel(result, { type: "Tag", tagId });
		}
		return result;
	});
}

export function useSelectedTagIds() {
	useSyncExternalStore(subscribe, getMapSnapshot);
	const ids = new Set<number>();
	for (const s of selections) if (s.props.type === "Tag") ids.add(s.props.tagId);
	return ids;
}

let virtualIdSeq = 0;
/** Each preview gets a fresh negative id so its identity changes between previews (the pano viewer re-resolves on active-id change). */
const freshVirtualId = () => --virtualIdSeq;

/** Open a staged-import location read-only, "as if" it were active. The location becomes
 *  virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it. */
export async function openStagedLocation(index: number) {
	const loc = await cmd.storeImportStagedLocation(index);
	activeLocationId = null;
	// Rust's active_id must not stay pinned to the previous real location.
	fireAndForget(cmd.storeSetActive(null), "stagedOpen:setActive");
	cachedActiveLocation = {
		...loc,
		id: freshVirtualId(),
		flags: loc.flags | LocationFlag.ImportPreview,
	};
	workArea = "location";
	importMarkerVersion++;
	bump();
	emitEvent("active:change", null);
}

/** Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. */
export function previewVirtualLocation(loc: Location) {
	activeLocationId = null;
	fireAndForget(cmd.storeSetActive(null), "virtualPreview:setActive");
	cachedActiveLocation = {
		...loc,
		id: freshVirtualId(),
		flags: loc.flags | LocationFlag.SeenOverlay,
	};
	workArea = "location";
	bump();
	emitEvent("active:change", null);
}

/** Materialize a `MaybeLocation`. */
export async function resolveLocation(m: MaybeLocation): Promise<Location | null> {
	return typeof m === "number" ? await cmd.storeGetLocation(m) : m;
}

export async function setActiveLocation(target: MaybeLocation | null, checkDuplicates = true) {
	const t = trace("setActive");
	const id = target == null ? null : locId(target);
	if (cachedActiveLocation && isVirtualLocation(cachedActiveLocation)) {
		importMarkerVersion++;
		const wasStaged = isImportPreview(cachedActiveLocation);
		if (id == null) {
			cachedActiveLocation = null;

			if (wasStaged) workArea = "import";
			else if (activePluginId) workArea = "plugin";
			else workArea = "overview";

			bump();
			emitEvent("active:change", null);
			t.end();
			return;
		}
	}
	activeLocationId = id;
	fireAndForget(cmd.storeSetActive(id), "setActive");
	if (id) {
		const loc = await resolveLocation(target!);
		t.step("ipc");
		if (checkDuplicates && loc) {
			const nearby = await cmd.storeFindNearby(loc.lat, loc.lng, 2.0);
			if (nearby.length >= 2) {
				duplicateLocations = nearby;
				workArea = "duplicates";
				activeLocationId = null;
				cachedActiveLocation = null;
				bump();
				emitEvent("active:change", null);
				t.end({ duplicates: nearby.length });
				return;
			}
		}
		cachedActiveLocation = loc ?? null;
		workArea = "location";
	} else {
		cachedActiveLocation = null;
		duplicateLocations = [];
		workArea = activePluginId ? "plugin" : "overview";
	}
	bump();
	emitEvent("active:change", activeLocationId);
	t.end();
}

export function openDuplicateLocation(loc: Location) {
	activeLocationId = loc.id;
	cachedActiveLocation = loc;
	workArea = "location";
	fireAndForget(cmd.storeSetActive(loc.id), "setActive");
	bump();
}

export function removeDuplicate(id: number) {
	duplicateLocations = duplicateLocations.filter((l) => l.id !== id);
	bump();
}

export function closeDuplicates() {
	duplicateLocations = [];
	activeLocationId = null;
	cachedActiveLocation = null;
	workArea = "overview";
	bump();
}

export function setWorkArea(area: WorkArea) {
	workArea = area;
	if (area !== "location") activeLocationId = null;
	if (area !== "plugin") activePluginId = null;
	bump();
}

// --- Plugin mode ---

export const useActivePluginId = makeStoreHook(() => activePluginId);

export function getWorkArea() {
	return workArea;
}

export function setPluginMode(pluginId: string) {
	workArea = "plugin";
	activePluginId = pluginId;
	activeLocationId = null;
	bump();
}

export function exitPluginMode() {
	workArea = "overview";
	activePluginId = null;
	bump();
}

// --- Tag CRUD ---

/** Get-or-create tags by name. Returns the tag objects for use
 *  in subsequent location updates. Idempotent — existing tags are returned
 *  as-is, new names get auto-generated colors. */
export async function createTags(names: string[]): Promise<Tag[]> {
	if (names.length === 0) return [];
	await mutate(cmd.storeCreateTags(names));
	const lower = new Set(names.map((n) => n.toLowerCase()));
	const created = Object.values(currentMap!.meta.tags).filter((t) =>
		lower.has(t.name.toLowerCase()),
	);
	emitEvent("tag:add", created);
	return created;
}

/** Rename or recolor tags. If a rename collides with an existing tag name
 *  (case-insensitive), the two tags are merged — all locations are remapped
 *  to the survivor. */
export async function updateTags(updates: Update<TagPatch>[]) {
	if (!currentMapId || !currentMap || updates.length === 0) return;
	await mutate(cmd.storeUpdateTags(updates));
	emitEvent("tag:update", updates);
	if (
		selections.some((s) => {
			const p = s.props;
			return p.type === "Tag" && updates.some((q) => q.id === p.tagId);
		})
	) {
		applySelectionUpdate((sels) => sels);
	}
}

/** Delete tags and strip them from all locations. Undoable (the location
 *  changes are in the undo stack; visibility auto-restores on undo). */
export async function deleteTags(tagIds: number[]) {
	if (!currentMapId || !currentMap || tagIds.length === 0) return;
	await mutate(cmd.storeDeleteTags(tagIds));
	emitEvent("tag:remove", tagIds);
}

/** Persist a new tag display order. */
export async function reorderTags(orderedIds: number[]) {
	if (!currentMapId || !currentMap) return;
	await mutate(cmd.storeReorderTags(orderedIds));
}

export async function addTagToLocations(tagId: number, locationIds: number[]) {
	if (!currentMap || locationIds.length === 0) return;
	const locs = await cmd.storeGetLocationsByIds(locationIds);
	const updates: Update<LocationPatch>[] = locs
		.filter((l) => !l.tags.includes(tagId))
		.map((l) => ({ id: l.id, patch: { tags: [...l.tags, tagId] } }));
	if (updates.length === 0) return;
	await mutate(cmd.storeUpdateLocations(updates, true));
}

export async function removeTagFromLocations(tagId: number, locationIds: number[]) {
	if (!currentMap || locationIds.length === 0) return;
	const locs = await cmd.storeGetLocationsByIds(locationIds);
	const updates: Update<LocationPatch>[] = locs
		.filter((l) => l.tags.includes(tagId))
		.map((l) => ({ id: l.id, patch: { tags: l.tags.filter((t: number) => t !== tagId) } }));
	if (updates.length === 0) return;
	await mutate(cmd.storeUpdateLocations(updates, true));
}

export async function removeTagFromAllLocations(tagId: number) {
	if (!currentMap) return;
	const allWithTag = await cmd.storeResolveSelection({ type: "Tag", tagId });
	if (allWithTag.length > 0) await removeTagFromLocations(tagId, allWithTag);
}

// --- Import ---

async function setImportStaging(preview: EditorImportPreview, source: "file" | "paste") {
	let positions = new Float32Array(0);
	try {
		const resp = await fetch(mmaBufUrl(preview.previewPositionsPath));
		if (!resp.ok) throw new Error(`preview fetch ${resp.status}: ${await resp.text()}`);
		positions = new Float32Array(await resp.arrayBuffer());
	} catch (e) {
		log.error("[import] preview positions fetch failed:", e);
	}
	importStaging = { preview, source };
	importPreviewPositions = positions;
	importMarkerVersion++;
	workArea = "import";
	bump();
	if (getSettings().panToImported) fitMapToBounds(bboxTupleToBounds(preview.bounds), 100);
}

/** Import from a known file path. Used by file picker and drag-and-drop. */
export async function beginImportFromPath(path: string) {
	await setImportStaging(await cmd.storeImportPreview(path), "file");
}

/** Stage pasted text for preview. Throws if no locations are found. */
export async function beginImportPaste(text: string) {
	await setImportStaging(await cmd.storeImportPastePreview(text), "paste");
}

/** Pick a file, stage it for preview. No-op if the picker is cancelled. */
export async function beginImportFile() {
	const path = await openFileDialog({
		multiple: false,
		filters: [{ name: "Map data", extensions: ["json", "csv"] }],
	});
	if (!path || typeof path !== "string") return;
	await beginImportFromPath(path);
}

/** Commit the staged import, optionally dropping fields and applying a bulk tag. */
export async function confirmImport(droppedFields: string[], tagName?: string) {
	if (!importStaging) return null;
	await inflightPersist; // don't overlap a prior import's backgrounded commit

	const r = await cmd.storeImportFile(droppedFields, tagName?.trim() || null);
	cancelImport();
	await mutate(Promise.resolve(r));

	// Overlay any settings the import carried (extra.settings) onto the open map's
	// settings. Generic: imported keys win, untouched keys are preserved.
	if (currentMap && r.settings && Object.keys(r.settings).length) {
		await updateMapMeta({ settings: { ...currentMap.meta.settings, ...r.settings } });
	}

	if (r.autoCommit && currentMapId) {
		const mapId = currentMapId;
		// Let the full render finish (markers on screen) before kicking off the commit --
		// otherwise the commit's ~1s of Arrow writes stall the render-buffer fetch and the
		// map stays blank for seconds after the import "returns".
		await whenSceneSettled();
		cancelAutosave();
		await inflightPersist;

		inflightPersist = cmd
			.storeCommit(mapId, `Import ${r.importedCount} locations`)
			.then(() => {
				undoRedoState = { canUndo: false, canRedo: false };
				cachedCommitDiff = { added: 0, removed: 0, modified: 0 };
			})
			.catch((e) => log.error("[import] background commit failed:", e))
			.finally(() => {
				inflightPersist = null;
				bump();
			});
	}
	return r;
}

/** Discard the staged import without committing. */
export function cancelImport() {
	importStaging = null;
	importPreviewPositions = new Float32Array(0);
	importMarkerVersion++;
	if (cachedActiveLocation && isVirtualLocation(cachedActiveLocation)) {
		cachedActiveLocation = null;
		workArea = "overview";
	}
	if (workArea === "import") workArea = "overview";
	bump();
}

// --- Undo/redo ---

/** Shared undo/redo handler: call the IPC, clear active if removed. */
async function undoRedo(which: () => Promise<MutationResult>) {
	if (!currentMap) return;
	try {
		const r = await mutate(which());
		if (activeLocationId && r.delta.removed.some((e) => e.id === activeLocationId)) {
			activeLocationId = null;
			cachedActiveLocation = null;
			workArea = "overview";
		}
	} catch (e) {
		log.debug(`[${which.name}] nothing or failed:`, e);
	}
}

export function undo() {
	return undoRedo(cmd.storeUndo);
}
export function redo() {
	return undoRedo(cmd.storeRedo);
}

export function getUndoRedoState() {
	return undoRedoState;
}

export const useUndoRedo = makeStoreHook(() => undoRedoState);

// --- Version control ---

/** Bake overlay, write the commit delta, create a VCS commit. Resets undo stack. */
export async function commitMap(message?: string): Promise<string> {
	if (!currentMapId) throw new Error("No map open");
	const t = trace("commit");
	cancelAutosave();
	await inflightPersist;

	const id = await cmd.storeCommit(currentMapId, message ?? null);
	t.step("commit");
	t.end();
	undoRedoState = { canUndo: false, canRedo: false };
	cachedCommitDiff = { added: 0, removed: 0, modified: 0 };

	// Commit clears the overlay; commit-sensitive selections (e.g. Uncommitted) must
	// re-resolve against the new baseline instead of showing now-committed rows.
	if (selections.length > 0) {
		await applySelectionUpdate((s) => s);
	} else {
		bump();
	}
	return id;
}

/** Interleave `[lng, lat]` pairs into an f32 buffer for deck.gl. */
export function diffPositions(locs: LatLng[]): Float32Array {
	const a = new Float32Array(locs.length * 2);
	for (let i = 0; i < locs.length; i++) {
		a[i * 2] = locs[i].lng;
		a[i * 2 + 1] = locs[i].lat;
	}
	return a;
}

/** Split a commit delta into added / removed / modified. An updated location appears in
 *  both `created` (new) and `removed` (old), keyed by id. */
export function categorizeCommitDelta<T extends { id: number }>(delta: {
	created: T[];
	removed: T[];
}): { added: T[]; removed: T[]; modified: T[] } {
	const removedIds = new Set(delta.removed.map((l) => l.id));
	const createdIds = new Set(delta.created.map((l) => l.id));
	return {
		added: delta.created.filter((l) => !removedIds.has(l.id)),
		removed: delta.removed.filter((l) => !createdIds.has(l.id)),
		modified: delta.created.filter((l) => removedIds.has(l.id)),
	};
}

/** Fetch a commit's delta and overlay its added/removed/modified locations on the map,
 *  temporarily replacing the regular markers. */
export async function beginCommitDiffPreview(commit: CommitInfo) {
	if (!currentMap) return;
	const delta = await cmd.storeGetCommitDelta(commit.mapId, commit.id);
	const { added, removed, modified } = categorizeCommitDelta(delta);
	commitDiffPreview = {
		commitId: commit.id,
		hash: commit.id.slice(0, 7),
		counts: { added: added.length, removed: removed.length, modified: modified.length },
		added: diffPositions(added),
		removed: diffPositions(removed),
		modified: diffPositions(modified),
	};
	diffMarkerVersion++;
	workArea = "diff";
	bump();
	const all = [...added, ...removed, ...modified];
	if (all.length > 0) {
		let west = Infinity,
			south = Infinity,
			east = -Infinity,
			north = -Infinity;
		for (const l of all) {
			if (l.lng < west) west = l.lng;
			if (l.lng > east) east = l.lng;
			if (l.lat < south) south = l.lat;
			if (l.lat > north) north = l.lat;
		}
		fitMapToBounds({ west, south, east, north }, 100);
	}
}

export function endCommitDiffPreview() {
	commitDiffPreview = null;
	diffMarkerVersion++;
	if (workArea === "diff") workArea = "overview";
	bump();
}

export async function checkoutCommit(commitId: string) {
	if (!currentMapId) return;
	await flushSave();
	try {
		await cmd.storeCloseMap();
		await cmd.storeCheckoutCommit(currentMapId, commitId);
		await cmd.storeOpenMap(currentMapId);
		await cmd.storeResetUndo();
		const msg = `Revert to ${commitId.slice(0, 7)}`;
		await cmd.storeCommit(currentMapId, msg);
	} catch (e) {
		log.error("[checkout] restore failed:", e);
		throw e;
	}
	currentMap = await cmd.storeGetMap(currentMapId);
	selections = [];
	selectedLocationIds = SelectedIds.EMPTY;
	activeLocationId = null;
	undoRedoState = { canUndo: false, canRedo: false };

	renderDeltaBus.emit({ added: [], updated: [], removed: [], colorPatches: [], fullReset: true });
	refreshAfterMutation();
	await invalidateMapList();
}
