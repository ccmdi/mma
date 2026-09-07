import { memoOnRefs } from "@/lib/util/memoOnRefs";
import type { WorkArea, MaybeLocation } from "@/types";
import { isVirtualLocation, isImportPreview, locId, applyLocationPatch } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import type { Location, MapMeta, Tag, ExtraFieldDef, StoreStatus } from "@/bindings.gen";
import { listen } from "@tauri-apps/api/event";
import { cmd } from "@/lib/commands";
import type {
	MutationResult,
	EngineValues,
	MapMetaPatch_Deserialize as MapMetaPatch,
	SelectionSync,
} from "@/bindings.gen";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { log } from "@/lib/util/log";
import { hexToRgb, type RGB } from "@/lib/util/color";
import { toast } from "@/lib/util/toast";
import { trace } from "@/lib/util/debug";
import { mmaBufUrl, nowUnix } from "@/lib/util/util";
import { rewriteSelectionFields } from "@/store/selections";
import { compareNatural } from "@/lib/util/util";
import { compareMonthOrder } from "@/lib/util/date";
import type { LocationPatch_Deserialize as LocationPatch, Update, TagPatch } from "@/bindings.gen";
import type { KeySpec, PartitionBucket, FieldOp, FieldOpResult, MergeWinner } from "@/bindings.gen";
import { SelectedIds, decodeSelectionBitmask, type ReadonlyIdSet } from "@/lib/render/CellManager";
import { resetImportState } from "./importStaging";
import { resetCommitDiffState, resetCommitDiffCounts } from "./commitDiff";
import { setCachedMapList, invalidateMapList, reloadMapList } from "./mapList";

import type { Selection, Selector } from "@/bindings.gen";
import { addSelection, batch, removeSelection, replaceSelection } from "./selections";
import type { SelectionPatch } from "./selections";

// --- Map state ---

/** The engine-owned mirror: exactly the value slice Rust ships (`EngineValues`), with every field required. */
type EngineState = { [K in keyof EngineValues]: NonNullable<EngineValues[K]> };

export interface UiState {
	mapId: string | null;
	/** Persisted identity slice (metadata + settings). Changes rarely. */
	map: MapMeta | null;
	/** Resolved count per selection node (top-level and nested), keyed by `Selection.key`.
	 *  The sole source for sidebar counts — refreshed wholesale from Rust on every sync. */
	selectionCounts: Record<string, number>;
	selections: Selection[];
	/** Keys of selections that are "ghosted": kept in the list but excluded from the
	 *  Rust sync, so they neither render nor count toward the selected set. Ephemeral. */
	ghostedSelections: ReadonlySet<string>;
	selectedLocationIds: SelectedIds;
	activeLocationId: number | null;
	/** The location open in the editor, or null. Virtual locations (staged
	 *  imports, seen previews) live here with negative ids. */
	activeLocation: Location | null;
	duplicateLocations: Location[];
	workArea: WorkArea;
	activePluginId: string | null;
}

export type MapState = UiState & EngineState;

const ENGINE_INITIAL: EngineState = {
	locationCount: 0,
	canUndo: false,
	canRedo: false,
	tagCounts: {},
	tags: {},
	fieldDefs: {},
};

const INITIAL_STATE: MapState = {
	...ENGINE_INITIAL,
	mapId: null,
	map: null,
	selectionCounts: {},
	selections: [],
	ghostedSelections: new Set(),
	selectedLocationIds: SelectedIds.EMPTY,
	activeLocationId: null,
	activeLocation: null,
	duplicateLocations: [],
	workArea: "overview",
	activePluginId: null,
};

let state: MapState = INITIAL_STATE;

/** Re-mint the state object with a shallow patch. Field values are hook
 *  snapshots: reassign, never mutate in place. */
function setState(patch: Partial<UiState>) {
	state = { ...state, ...patch };
}

/** Merge the engine values Rust shipped (JSON merge patch: null = unchanged). */
function mergeEngineValues(v: EngineValues) {
	state = { ...state, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x != null)) };
}

function resetEngineState() {
	state = { ...state, ...ENGINE_INITIAL };
}

/** Reactive slice of the map state. Re-renders only when the selected value's
 *  reference changes (`Object.is`), so selectors must return state fields or
 *  cached derivations — never construct a value per call. */
export function useMapState<T>(selector: (s: MapState) => T): T {
	return useEventValue("store:changed", () => selector(state));
}

/** Imperative snapshot of the map state. */
export function getMapState(): Readonly<MapState> {
	return state;
}

/** Tags that exist from the user's point of view. Raw `tags` also holds soft-deleted ghosts (count=0, visible=false) - almost nothing outside the undo machinery should enumerate those. */
export const getVisibleTags: () => Tag[] = memoOnRefs(
	() => [state.tags] as const,
	(tags) => Object.values(tags).filter((t) => t.visible !== false),
);

/** Raw by-id tag lookup — includes soft-deleted ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
export function getTag(id: number): Tag | undefined {
	return state.tags[id];
}

/** Tag names for the given ids, skipping any that no longer resolve. */
export function tagIdsToNames(ids: number[]): string[] {
	return ids.map((id) => state.tags[id]?.name).filter((n): n is string => n != null);
}

// --- Autosave ---
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let inflightPersist: Promise<void> | null = null;
const AUTOSAVE_DELAY_MS = 2000;

/** Schedule an autosave shortly. Mutations call this automatically; debounced. */
let autosaveHolds = 0;
let saveDeferred = false;

/** Defer autosave until the returned release function runs. Useful for batches that land many mutations. @unstable */
export function holdAutosave(): () => void {
	autosaveHolds++;
	return () => {
		autosaveHolds--;
		if (autosaveHolds === 0 && saveDeferred) {
			saveDeferred = false;
			scheduleSave();
		}
	};
}

/** Schedule a debounced autosave. Mutations call this automatically. @unstable */
export function scheduleSave() {
	if (autosaveHolds > 0) {
		saveDeferred = true;
		return;
	}
	if (autosaveTimer) clearTimeout(autosaveTimer);
	autosaveTimer = setTimeout(() => {
		autosaveTimer = null;
		void doSave();
	}, AUTOSAVE_DELAY_MS);
}

/** Cancel any pending autosave timer. @unstable */
export function cancelAutosave() {
	if (autosaveTimer) {
		clearTimeout(autosaveTimer);
		autosaveTimer = null;
	}
}

/** Wait for any in-progress save to finish. @unstable */
export function waitForInflightPersist() {
	return inflightPersist;
}

/** Background auto-commit after an import with autoCommit set. @unstable */
export function scheduleAutoCommit(mapId: string, importedCount: number) {
	inflightPersist = cmd
		.storeCommit(mapId, `Import ${importedCount} locations`)
		.then((r) => {
			applyMutation(r.status);
			resetCommitDiffCounts();
		})
		.catch((e: unknown) => log.error("[import] background commit failed:", e))
		.finally(() => {
			inflightPersist = null;
			emitEvent("store:changed");
		});
}

async function doSave(): Promise<void> {
	if (!state.mapId || !state.map) return;
	await inflightPersist;

	const t = trace("save");
	inflightPersist = cmd
		.storeSaveDirty()
		.then(() => {
			t.end();
			void invalidateMapList();
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

/** Save any unsaved changes now instead of waiting for the autosave timer. @unstable */
export async function flushSave(): Promise<void> {
	cancelAutosave();
	await doSave();
}

// --- Init (called once at startup) ---
/** One-time store startup. The app calls this; plugins never need to. @unstable */
export async function initStore() {
	setCachedMapList(await cmd.storeListMaps());
	emitEvent("store:changed");
	// App-lifetime listeners: never unsubscribed, so the handles are dropped on purpose.
	void listen("map-list-changed", () => void reloadMapList());
	void listen<string>("store-warning", (e) => toast(e.payload, 8000));
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

/** Reset all per-map editing state to its initial values. */
function clearEditState() {
	setState({
		selections: [],
		selectedLocationIds: SelectedIds.EMPTY,
		activeLocationId: null,
		activeLocation: null,
		workArea: "overview",
	});
	resetImportState();
	resetCommitDiffState();
}

/** Every (re)open: the meta identity slice, then the open-time engine full picture. */
function applyOpenedMap(meta: MapMeta | null, status: StoreStatus) {
	setState({ map: meta });
	mergeEngineValues(status.values);
}

// --- Actions ---
/** Open a map in this window, closing any currently open map first. */
export async function openMap(id: string) {
	mapOpen.begin();

	cancelAutosave();
	await inflightPersist;

	const t = trace("openMap");
	setState({ mapId: id, map: null });
	emitEvent("store:changed");
	const meta = await cmd.storeGetMap(id);
	t.step("getMap");

	if (meta) {
		try {
			const openResult = await cmd.storeOpenMap(id);
			t.step("store_open_map");
			mapOpen.mark("data");
			applyOpenedMap(meta, openResult);
		} catch (e) {
			log.error("[openMap] store_open_map failed:", e);
			setState({ mapId: null, map: null });
			emitEvent("store:changed");
			return;
		}
		void cmd.storeTouchMapOpened(id);
	}

	clearEditState();
	emitEvent("store:changed");
	t.end();
	if (state.map) emitEvent("map:open", state.map);
}

/** Tear down all in-memory state for the open map. */
function resetMapState() {
	emitEvent("map:close");
	setState({ mapId: null, map: null });

	clearEditState();

	emitEvent("render:delta", { added: [], updated: [], removed: [], fullReset: true });
	resetEngineState();
	emitEvent("store:changed");
}

/** Close the open map, saving unsaved changes first. */
export async function closeMap() {
	await flushSave();
	resetMapState();
	await cmd.storeCloseMap();
}

/** Drop the open map without persisting anything @unstable */
export function discardOpenMap() {
	cancelAutosave();
	resetMapState();
}

/** Ids of every location the selector resolves to. */
export function resolveIds(selector: Selector): Promise<number[]> {
	return cmd.storeResolve(selector);
}

/** How many locations the selector resolves to. */
export function countIn(selector: Selector): Promise<number> {
	return cmd.storeCount(selector);
}

/** Bounding box `[west, south, east, north]`, or null when the selector is empty. */
export function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null> {
	return cmd.storeBounds(selector);
}

/** `n` ids drawn uniformly at random, without replacement. */
export function sampleFrom(selector: Selector, n: number): Promise<number[]> {
	return cmd.storeSample(selector, n);
}

/** Distinct values of `field`, sorted. */
export function fieldValues(selector: Selector, field: string): Promise<string[]> {
	return cmd.storeValues(selector, field);
}

/** Group by a derived key and count. */
export function countBy(
	selector: Selector,
	field: string,
	key: KeySpec,
): Promise<[string, number][]> {
	return cmd.storeCountBy(selector, field, key);
}

/** How many locations hold a value for each field, key-sorted. */
export function coverage(selector: Selector): Promise<[string, number][]> {
	return cmd.storeCoverage(selector);
}

/** One column per field over the selected set. `null` where a location
 *  lacks the field; `"tags"` returns a column of tag-id arrays. */
export function fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]> {
	return cmd.storeColumns(selector, fields);
}

/** Group the selected location set by a derived key. Numeric bins arrive in bound order;
 *  other keys are sorted naturally. */
export async function partition(
	field: string,
	key: KeySpec,
	selector: Selector,
): Promise<PartitionBucket[]> {
	const groups = await cmd.storeGroupBy(selector, field, key);
	if (key.kind !== "numericBin") {
		const cmp =
			key.kind === "datePart" && key.part === "monthOfYear" ? compareMonthOrder : compareNatural;
		groups.sort((a, b) => cmp(a.key, b.key));
	}
	return groups;
}

/** Fetch full location rows matching a selector. Missing ids are skipped.
 *
 *  Every row lands in memory, so an unscoped call on a large map is expensive.
 *  Prefer a narrower selector or a projection (`fetchColumns`, `countBy`) when possible. */
export async function fetchLocations(selector: Selector): Promise<Location[]> {
	const rows = await cmd.storeCollect(selector);
	return rows.kind === "inline" ? rows.locations : (await fetch(mmaBufUrl(rows.path))).json();
}

/** Active (non-ghosted) selections, the default for any operational logic. */
export const getActiveSelections: () => Selection[] = memoOnRefs(
	() => [state.selections, state.ghostedSelections] as const,
	(sels, ghosts) => (ghosts.size === 0 ? sels : sels.filter((s) => !ghosts.has(s.key))),
);

/** The live selection as a `Selector`: the union of the active selection nodes. */
export function currentSelection(): Selector {
	return { type: "Union", selections: getActiveSelections() };
}

/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. */
export function setSelectedLocationIds(ids: SelectedIds) {
	setState({ selectedLocationIds: ids });
}

/** Patch any map's metadata by id and persist it. Updates the open map's state when it is that map. */
export async function patchMapMeta(id: string, patch: MapMetaPatch) {
	if (state.map && state.mapId === id) {
		const carried = Object.fromEntries(
			Object.entries(patch).filter(([, v]) => v !== undefined),
		) as Partial<MapMeta>;
		setState({ map: { ...state.map, ...carried } });
	}
	emitEvent("store:changed");
	const r = await cmd.storeUpdateMapMeta(id, patch);
	if (r && state.mapId === id) applyMutation(r);
	await invalidateMapList();
}

/** [`patchMapMeta`] for the map open in this window. */
export function updateMapMeta(patch: MapMetaPatch) {
	if (!state.mapId) return;
	return patchMapMeta(state.mapId, patch);
}

/** Replace the map's extra-field definitions (types/labels for `Location.extra` keys). */
export async function setMapExtraFields(fields: Record<string, ExtraFieldDef>) {
	if (!state.mapId || !state.map) return;
	const current = state.map.extra ?? {};
	return patchMapMeta(state.mapId, { extra: { ...current, fields } } as MapMetaPatch);
}

/** Keys of tag selections whose tag just died (deleted or went invisible). */
function deadTagKeys(oldTags: Record<number, Tag>, newTags: Record<number, Tag>): string[] {
	return Object.keys(oldTags)
		.map(Number)
		.filter((id) => {
			const was = oldTags[id];
			const now = newTags[id];
			return was && was.visible !== false && (!now || now.visible === false);
		})
		.map((id) => `tag:${id}`);
}

/** A MutationResult carries only what moved: every present field replaces its slice,
 *  every null field was untouched and keeps its reference. Announces its own writes. */
function applyMutation(r: MutationResult) {
	if (!state.map) return;
	const oldTags = state.tags;
	mergeEngineValues(r.values);
	if (r.values.tags)
		void applySelectionUpdate(batch(removeSelection)(deadTagKeys(oldTags, r.values.tags)));
	if (r.selectionSync) applySelectionSync(r.selectionSync);
	emitEvent("store:changed");
}

/** Decode a selection bitmask and emit it to the render pipeline. @unstable */
export function emitBitmask(bytes: number[]) {
	const { selColors, cellEntries } = decodeSelectionBitmask(bytes);
	emitEvent("render:selection", {
		selColors,
		cellEntries,
		setIds: (ids) => {
			setState({ selectedLocationIds: ids });
		},
	});
}

function applySelectionSync(sync: SelectionSync) {
	setState({ selectionCounts: sync.counts });
	if (sync.bitmask) emitBitmask(sync.bitmask);
}

const EMPTY_MUTATION: MutationResult = {
	version: 0,
	delta: { added: [], updated: [], removed: [], fullReset: false },
	selectionSync: null,
	values: {
		locationCount: null,
		canUndo: null,
		canRedo: null,
		tagCounts: null,
		tags: null,
		fieldDefs: null,
	},
};

/** Run a mutation, apply its result to the map, and schedule a save. */
export async function mutate(fn: () => Promise<MutationResult>): Promise<MutationResult> {
	if (!state.map) return EMPTY_MUTATION;
	const r = await fn();
	await inflightPersist;
	emitEvent("render:delta", r.delta);
	applyMutation(r);
	scheduleSave();
	return r;
}

/** Locations per staged chunk. A serialized Location averages ~250 bytes, so a chunk is a
 *  ~1MB POST body: small enough that peak JS memory stays flat at any batch size, large
 *  enough that the per-chunk round trip disappears into the parse. */
const ADD_CHUNK = 5000;

/** Stage `locs` as chunked JSON in an upload session, then commit them in one mutation.
 *  Only one chunk is serialized at a time, so peak memory is O(chunk), not O(batch). */
async function addViaUpload(locs: Location[]): Promise<MutationResult> {
	const session = await cmd.storeUploadBegin();
	try {
		for (let i = 0, n = 0; i < locs.length; i += ADD_CHUNK, n++) {
			const res = await fetch(mmaBufUrl(`${session}/${n}.json`), {
				method: "POST",
				body: JSON.stringify(locs.slice(i, i + ADD_CHUNK)),
			});
			if (!res.ok) throw new Error(`staged add: chunk ${n} upload failed (${res.status})`);
		}
	} catch (e) {
		await cmd.storeUploadAbort(session).catch(() => {});
		throw e;
	}
	return cmd.storeAddLocationsUploaded(session);
}

/** Add locations to the map. Real ids are assigned and written back into the passed
 *  objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable.
 *  Emits `location:add`. */
export async function addLocations(locs: Location[]) {
	if (locs.length === 0) return;
	const t = trace("add");
	const r = await mutate(() =>
		locs.length > ADD_CHUNK ? addViaUpload(locs) : cmd.storeAddLocations(locs),
	);
	t.end({ delta: `+${r.delta.added.length} -${r.delta.removed.length}` });
	for (let i = 0; i < r.delta.added.length && i < locs.length; i++) {
		locs[i].id = r.delta.added[i].id;
	}
	emitEvent("location:add", locs);
}

/** Clone a location in place and return the new id, or null if it doesn't exist. Undoable. */
export async function duplicateLocation(id: number): Promise<number | null> {
	if (!state.map || isVirtualLocation({ id })) return null;
	const [loc] = await fetchLocations({ type: "Locations", locations: [id], name: null });
	if (!loc) return null;
	const now = nowUnix();
	const clone: Location = { ...loc, id: 0, createdAt: now, modifiedAt: now };
	await addLocations([clone]);
	return clone.id;
}

/** Remove locations by id. Undoable. */
export async function removeLocations(ids: ReadonlyIdSet) {
	if (ids.size === 0) return;
	if ([...ids].some((id) => isVirtualLocation({ id }))) {
		await setActiveLocation(null);
		return;
	}
	if (state.activeLocationId && ids.has(state.activeLocationId)) setWorkArea("overview");
	emitEvent("store:changed");
	await mutate(() => cmd.storeRemoveLocations([...ids])).catch((e) =>
		log.error("[delete] store_remove_locations failed:", e),
	);
	emitEvent("location:remove", [...ids]);
}

/** Patch locations by id. Only include the fields you're changing; `extra` merges
 *  per-key (null deletes a key). Undoable by default. */
export async function updateLocations(
	updates: Update<LocationPatch>[],
	opts?: { undoable?: boolean },
) {
	if (updates.length === 0) return;
	if (updates.some((u) => isVirtualLocation(u))) return;
	await mutate(() => cmd.storeUpdateLocations(updates, opts?.undoable ?? true));
	emitEvent("location:update", updates);
	if (state.activeLocation) {
		const activePatch = updates.find((u) => u.id === state.activeLocationId)?.patch;
		if (activePatch) {
			setState({ activeLocation: applyLocationPatch(state.activeLocation, activePatch) });
			emitEvent("store:changed");
		}
	}
}

// --- Bulk metadata-field operations ---

/** Rename extra-field `from` to `to` across all locations, its definition, and selections.
 *  When a location already holds `to`, `winner` decides which value survives. */
export async function renameField(from: string, to: string, winner: MergeWinner = "from") {
	if (!state.map || from === to || !to) return;
	await applyFieldOp({ type: "Everything" }, { kind: "move", from, to, winner }, false);
	await migrateFieldReferences(from, to);
}

/** Delete extra-field `key` from every location, its definition, and references. */
export async function deleteField(key: string) {
	if (!state.map) return;
	await applyFieldOp({ type: "Everything" }, { kind: "delete", keys: [key] }, false);
	await migrateFieldReferences(key, null);
}

/** Apply a field operation across all locations matching `selector`. Emits `location:invalidate`. */
export async function applyFieldOp(
	selector: Selector,
	op: FieldOp,
	recordUndo: boolean,
): Promise<FieldOpResult> {
	let r: FieldOpResult = { mutation: EMPTY_MUTATION, changed: 0, failed: [] };
	await mutate(async () => {
		r = await cmd.storeApplyFieldOp(selector, op, recordUndo);
		return r.mutation;
	});
	emitEvent("location:invalidate");
	const active = state.activeLocation;
	if (active && !isVirtualLocation(active)) {
		const [fresh] = await fetchLocations({ type: "Locations", locations: [active.id], name: null });
		if (fresh) {
			setState({ activeLocation: fresh });
			emitEvent("store:changed");
		}
	}
	return r;
}

/** Migrate field definition + active selection references after a data move.
 *  Saved selections are deliberately NOT rewritten: they are global name-based
 *  rules resolved against whichever map is open, so a map-local rename/delete
 *  must not mutate them (the rule simply stops resolving here). */
async function migrateFieldReferences(from: string, to: string | null) {
	if (!state.map) return;
	const defs = { ...(state.map.extra?.fields ?? {}) };
	if (defs[from]) {
		if (to && !defs[to]) defs[to] = defs[from];
		delete defs[from];
		await setMapExtraFields(defs);
	}
	await applySelectionUpdate(rewriteSelectionFields(from, to));
}

// --- Selections ---

/** Resolve a selection's overlay color, substituting the live tag color for Tag selections. */
function selectionSyncColor(s: Selection): RGB {
	if (s.selector.type === "Tag") {
		const tag = state.tags[s.selector.tagId];
		if (tag) return hexToRgb(tag.color);
	}
	return s.color;
}

/** All selections, each flagged ghosted or not. Rust counts every one, renders/selects only non-ghosted. */
function buildSyncInputs() {
	return state.selections.map((s) => ({
		key: s.key,
		selector: s.selector,
		color: selectionSyncColor(s),
		ghosted: state.ghostedSelections.has(s.key),
	}));
}

/** Add selectors to the active selection list. */
export function addSelections(selectors: Selector[]): Promise<void> {
	return applySelectionUpdate(batch(addSelection)(selectors));
}

/** Drop selections by key. */
export function removeSelections(keys: string[]): Promise<void> {
	return applySelectionUpdate(batch(removeSelection)(keys));
}

/** Apply a selection transform function and re-resolve the selection.
 *  The function receives the current selections and ghosted set, and returns either
 *  a new `Selection[]` or a `SelectionPatch`. No-op when nothing changed. */
export async function applySelectionUpdate(
	op: (sels: Selection[], ghosted: ReadonlySet<string>) => Selection[] | SelectionPatch,
) {
	if (!state.map) return;
	const out = op(state.selections, state.ghostedSelections);
	const patch: SelectionPatch = Array.isArray(out) ? { selections: out } : out;
	const selections = patch.selections ?? state.selections;
	const ghostedSelections = pruneGhosted(selections, patch.ghosted ?? state.ghostedSelections);
	if (selections === state.selections && ghostedSelections === state.ghostedSelections) return;
	setState({ selections, ghostedSelections });
	return syncSelections();
}

/** Re-resolve all selections against the current map data and update the overlay.
 *  Use when the underlying data changed but the selections themselves did not. */
export async function syncSelections() {
	if (!state.map) return;
	const t = trace("selection", { summary: true });
	const sels = buildSyncInputs();
	const result = await cmd.storeSyncSelections(sels);
	t.step("ipc");
	applySelectionSync(result);
	emitEvent("store:changed");
	t.step("apply");
	t.end({ selected: result.selectedCount });
	emitEvent("selection:change", state.selections);
}

/** Drop ghosted keys that no longer correspond to a live selection. */
function pruneGhosted(selections: Selection[], ghosted: ReadonlySet<string>): ReadonlySet<string> {
	if (ghosted.size === 0) return ghosted;
	const live = new Set(selections.map((s) => s.key));
	const pruned = ghosted.intersection(live);
	return pruned.size !== ghosted.size ? pruned : ghosted;
}

/** Clear all selections. */
export function resetSelections() {
	return applySelectionUpdate(() => []);
}

/** The buckets a pick runs over: one per active selection when `perSelection`, else the
 *  whole selection as one. `null` means "whatever is currently selected" - the only way to
 *  express a selected-id set that no live selection produced. Falls back to that single
 *  bucket below two active selections, where per-bucket picking is the same operation. */
function pickBuckets(perSelection: boolean): (Selector | null)[] {
	const active = getActiveSelections();
	if (!perSelection || active.length < 2) return [null];
	return active.map((s) => s.selector);
}

/** Replace the current selection with up to `count` ids picked at random.
 *  With `perSelection`, picks up to `count` from each active selection separately.
 *  Returns the number of ids actually picked (0 when nothing is selected). */
export async function selectRandomFromSelection(
	count: number,
	perSelection = false,
): Promise<number> {
	const buckets = await Promise.all(
		pickBuckets(perSelection).map((selector) => sampleFrom(selector ?? currentSelection(), count)),
	);
	const picked = [...new Set(buckets.flat())];
	if (picked.length === 0) return 0;
	await applySelectionUpdate(() => addSelection({ type: "Manual", locations: picked })([]));

	return picked.length;
}

/** Replace the current selection with spatially spaced ids - either `count` ids maximizing
 *  spacing, or as many as fit at `minDistanceM`. With `perSelection`, each active selection
 *  is picked from separately. Returns the count picked and the minimum distance achieved. */
export async function selectSpacedFromSelection(
	opts: { count?: number; minDistanceM?: number },
	perSelection = false,
): Promise<{ picked: number; distanceM: number }> {
	const results = await Promise.all(
		pickBuckets(perSelection).map((selector) =>
			cmd.storeSpaced(
				selector ?? currentSelection(),
				opts.count ?? null,
				opts.minDistanceM ?? null,
			),
		),
	);
	const ids = [...new Set(results.flatMap((r) => r.ids))];
	if (ids.length === 0) return { picked: 0, distanceM: 0 };
	await applySelectionUpdate(() => addSelection({ type: "Manual", locations: ids })([]));

	// Spacing only holds within a bucket - two buckets can each pick a coincident location.
	const distanceM = results.length === 1 ? results[0].distanceM : 0;
	return { picked: ids.length, distanceM };
}

/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. @unstable */
export function previewDuplicateGroups(distance: number): Promise<number[][]> {
	return cmd.storeDuplicateGroups(distance);
}

/** Merge each transitive duplicate group into one survivor (tags unioned), ranked by the
 *  map's duplicate preference. One undoable edit. @unstable */
export async function mergeDuplicates(distance: number) {
	await mutate(() =>
		cmd.storeMergeDuplicates(distance, state.map?.settings.duplicateScore ?? null),
	);
}

/**
 * Prune duplicates within a resolved selection: keeps the most relevant location per
 * cluster (<= 25m) or thins to enforce spacing (> 25m). Returns the number pruned.
 *  @unstable
 */
export async function pruneDuplicates(selector: Selector, distance: number): Promise<number> {
	if (!state.map) return 0;
	const r = await mutate(() =>
		cmd.storePruneDuplicates(selector, distance, state.map?.settings.duplicateScore ?? null),
	);
	return r.delta.removed.length;
}

/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
export function updateFilterSelection(oldKey: string, selector: Selector) {
	return applySelectionUpdate((sels, ghosted): SelectionPatch => {
		const next = replaceSelection(sels, oldKey, selector);
		if (next.length !== sels.length) return { selections: next };
		let migrated: Set<string> | null = null;
		for (let i = 0; i < sels.length; i++) {
			if (next[i].key !== sels[i].key && ghosted.has(sels[i].key)) {
				migrated ??= new Set(ghosted);
				migrated.delete(sels[i].key);
				migrated.add(next[i].key);
			}
		}
		return migrated ? { selections: next, ghosted: migrated } : { selections: next };
	});
}

/** Toggle tag selections on/off for the given tags (used by tag-pill clicks). */
export function toggleTagSelections(tagIds: number[]) {
	if (!state.map || tagIds.length === 0) return;
	void applySelectionUpdate((sels) =>
		tagIds.reduce((result, tagId) => {
			const key = `tag:${tagId}`;
			return result.some((s) => s.key === key)
				? removeSelection(key)(result)
				: addSelection({ type: "Tag", tagId })(result);
		}, sels),
	);
}

/** Tag ids that currently have a top-level Tag selection active. */
export const getSelectedTagIds: () => ReadonlySet<number> = (() => {
	let prev: Set<number> | null = null;
	return memoOnRefs(
		() => [state.selections] as const,
		(sels) => {
			const ids = new Set(
				sels.flatMap((s) => (s.selector.type === "Tag" ? [s.selector.tagId] : [])),
			);
			if (prev && prev.symmetricDifference(ids).size === 0) return prev;
			prev = ids;
			return ids;
		},
	);
})();

/** Tag ids of every Tag leaf in the active selection tree, in list order.
 *  Includes composite children, excludes ghosted selections; ids may repeat. */
export const getSelectedTagIdsDeep: () => readonly number[] = memoOnRefs(
	() => [getActiveSelections()] as const,
	(sels) => {
		const out: number[] = [];
		const walk = (list: Selection[]) => {
			for (const s of list) {
				if (s.selector.type === "Tag") out.push(s.selector.tagId);
				if ("selections" in s.selector) walk(s.selector.selections);
			}
		};
		walk(sels);
		return out;
	},
);

let virtualIdSeq = 0;
/** Each preview gets a fresh negative id so its identity changes between previews (the pano viewer re-resolves on active-id change). */
const freshVirtualId = () => --virtualIdSeq;

/** Open a staged-import location read-only, "as if" it were active. The location becomes
 *  virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it. @unstable */
export async function openStagedLocation(index: number) {
	const loc = await cmd.storeImportStagedLocation(index);
	// Rust's active_id must not stay pinned to the previous real location.
	void cmd.storeSetActive(null);
	setState({
		activeLocationId: null,
		activeLocation: {
			...loc,
			id: freshVirtualId(),
			flags: loc.flags | LocationFlag.ImportPreview,
		},
		workArea: "location",
	});
	emitEvent("import-markers:changed");
	emitEvent("store:changed");
	emitEvent("active:change", null);
}

/** Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
export function previewVirtualLocation(loc: Location) {
	void cmd.storeSetActive(null);
	setState({
		activeLocationId: null,
		activeLocation: {
			...loc,
			id: freshVirtualId(),
			flags: loc.flags | LocationFlag.SeenOverlay,
		},
		workArea: "location",
	});
	emitEvent("store:changed");
	emitEvent("active:change", null);
}

/** Drop the active location, keeping Rust's `active_id` and `active:change` in step. */
function clearActiveLocation(): void {
	if (state.activeLocationId == null && state.activeLocation == null) return;
	if (state.activeLocationId != null) void cmd.storeSetActive(null);
	setState({ activeLocationId: null, activeLocation: null });
	emitEvent("active:change", null);
}

/** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
export async function resolveLocation(m: MaybeLocation): Promise<Location | null> {
	return typeof m === "number"
		? ((await fetchLocations({ type: "Locations", locations: [m], name: null }))[0] ?? null)
		: m;
}

/** Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
 *  with 2+ locations within 2m opens the duplicate-resolution panel instead. */
export async function setActiveLocation(target: MaybeLocation | null, checkDuplicates = true) {
	const t = trace("setActive");
	const id = target == null ? null : locId(target);
	if (state.activeLocation && isVirtualLocation(state.activeLocation)) {
		emitEvent("import-markers:changed");
		const wasStaged = isImportPreview(state.activeLocation);
		if (id == null) {
			clearActiveLocation();

			setState({
				workArea: wasStaged ? "import" : state.activePluginId ? "plugin" : "overview",
			});
			emitEvent("store:changed");
			t.end();
			return;
		}
	}
	setState({ activeLocationId: id });
	void cmd.storeSetActive(id);
	if (id) {
		const loc = await resolveLocation(target!);
		t.step("ipc");
		if (checkDuplicates && loc) {
			const nearby = await cmd.storeFindNearby(loc.lat, loc.lng, 2.0);
			if (nearby.length >= 2) {
				setState({ duplicateLocations: nearby, workArea: "duplicates" });
				clearActiveLocation();
				emitEvent("store:changed");
				t.end({ duplicates: nearby.length });
				return;
			}
		}
		setState({ activeLocation: loc ?? null, workArea: "location" });
		emitEvent("store:changed");
		emitEvent("active:change", state.activeLocationId);
		t.end();
		return;
	}
	clearActiveLocation();
	setState({
		duplicateLocations: [],
		workArea: state.activePluginId ? "plugin" : "overview",
	});
	emitEvent("store:changed");
	t.end();
}

/** Open one location from the duplicate-resolution panel in the editor. @unstable */
export function openDuplicateLocation(loc: Location) {
	setState({ activeLocationId: loc.id, activeLocation: loc, workArea: "location" });
	void cmd.storeSetActive(loc.id);
	emitEvent("store:changed");
}

/** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
export function removeDuplicate(id: number) {
	setState({ duplicateLocations: state.duplicateLocations.filter((l) => l.id !== id) });
	emitEvent("store:changed");
}

/** Close the duplicate-resolution panel and return to the overview. @unstable */
export function closeDuplicates() {
	setState({ duplicateLocations: [] });
	setWorkArea("overview");
}

/** Transition the editor pane, enforcing state invariants:
 *  leaving "location" clears the active location, leaving "plugin" clears the plugin id. */
export function setWorkArea(area: WorkArea) {
	setState({ workArea: area });
	if (area !== "location") clearActiveLocation();
	if (area !== "plugin") setState({ activePluginId: null });
	emitEvent("store:changed");
}

// --- Plugin mode ---

/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
export function setPluginMode(pluginId: string) {
	setState({ activePluginId: pluginId });
	setWorkArea("plugin");
}

/** Close the plugin sidebar and return to the overview. */
export function exitPluginMode() {
	setWorkArea("overview");
}

// --- Tag CRUD ---

/** Get-or-create tags by name. Existing tags are returned as-is; new names get
 *  auto-generated colors. Pass `selector` to assign the tags to those locations
 *  atomically. Emits `tag:add`. */
export async function createTags(
	names: string[],
	selector: Selector = { type: "Locations", locations: [], name: null },
): Promise<Tag[]> {
	if (names.length === 0) return [];
	await mutate(() => cmd.storeCreateTags(names, selector));
	const lower = new Set(names.map((n) => n.toLowerCase()));
	const created = Object.values(state.tags).filter((t) => lower.has(t.name.toLowerCase()));
	emitEvent("tag:add", created);
	return created;
}

/** Rename or recolor tags. If a rename collides with an existing tag name
 *  (case-insensitive), the two tags are merged — all locations are remapped
 *  to the survivor. */
export async function updateTags(updates: Update<TagPatch>[]) {
	if (updates.length === 0) return;
	await mutate(() => cmd.storeUpdateTags(updates));
	emitEvent("tag:update", updates);
	// ONLY resync on color change, everything else is resolved by Rust
	const recolored = new Set(updates.filter((u) => u.patch.color != null).map((u) => u.id));
	if (state.selections.some((s) => s.selector.type === "Tag" && recolored.has(s.selector.tagId))) {
		void syncSelections();
	}
}

/** Delete tags and strip them from all locations. Undoable. Emits `tag:remove`. */
export async function deleteTags(tagIds: number[]) {
	if (tagIds.length === 0) return;
	await mutate(() => cmd.storeDeleteTags(tagIds));
	emitEvent("tag:remove", tagIds);
}

/** Persist a new tag display order. */
export async function reorderTags(orderedIds: number[]) {
	await mutate(() => cmd.storeReorderTags(orderedIds));
}

/** Fetch locations, apply a tag transform, and mutate those that changed.
 *  `transform` returns null to skip a location (no change needed). */
async function modifyTagOnLocations(
	tagId: number,
	locationIds: number[],
	transform: (tags: number[], tagId: number) => number[] | null,
) {
	if (locationIds.length === 0) return;
	const locs = await fetchLocations({ type: "Locations", locations: locationIds, name: null });
	const updates = locs.flatMap((l): Update<LocationPatch>[] => {
		const next = transform(l.tags, tagId);
		return next ? [{ id: l.id, patch: { tags: next } }] : [];
	});
	if (updates.length === 0) return;
	await updateLocations(updates);
}

/** Add a tag to locations (skips ones that already have it). Undoable. */
export function addTagToLocations(tagId: number, locationIds: number[]) {
	return modifyTagOnLocations(tagId, locationIds, (tags, id) =>
		tags.includes(id) ? null : [...tags, id],
	);
}

/** Remove a tag from the given locations. Undoable. */
export function removeTagFromLocations(tagId: number, locationIds: number[]) {
	return modifyTagOnLocations(tagId, locationIds, (tags, id) =>
		tags.includes(id) ? tags.filter((t) => t !== id) : null,
	);
}

/** Remove a tag from every location that has it. Undoable. */
export async function removeTagFromAllLocations(tagId: number) {
	if (!state.map) return;
	const allWithTag = await resolveIds({ type: "Tag", tagId });
	if (allWithTag.length > 0) await removeTagFromLocations(tagId, allWithTag);
}

// --- Undo/redo ---

/** Shared undo/redo handler: call the IPC, clear active if removed. */
async function undoRedo(which: () => Promise<MutationResult>) {
	try {
		const r = await mutate(which);
		if (state.activeLocationId && r.delta.removed.some((e) => e.id === state.activeLocationId))
			setWorkArea("overview");
	} catch (e) {
		log.debug(`[${which.name}] nothing or failed:`, e);
	}
}

/** Undo the last edit. */
export function undo() {
	return undoRedo(cmd.storeUndo);
}
/** Redo the last undone edit. */
export function redo() {
	return undoRedo(cmd.storeRedo);
}

// --- Version control ---

/** Commit all pending changes to the map's version history. Clears the undo stack. */
export async function commitMap(message?: string): Promise<string> {
	if (!state.mapId) throw new Error("No map open");
	const t = trace("commit");
	cancelAutosave();
	await inflightPersist;

	const r = await cmd.storeCommit(state.mapId, message ?? null);
	t.step("commit");
	t.end();
	applyMutation(r.status);
	resetCommitDiffCounts();

	// Commit clears the overlay; commit-sensitive selections (e.g. Uncommitted) must
	// re-resolve against the new baseline instead of showing now-committed rows.
	if (state.selections.length > 0) await syncSelections();
	return r.id;
}

/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. */
export async function checkoutCommit(commitId: string) {
	if (!state.mapId) return;
	await flushSave();
	let openResult;
	let commitResult;
	try {
		await cmd.storeCloseMap();
		await cmd.storeCheckoutCommit(state.mapId, commitId);
		openResult = await cmd.storeOpenMap(state.mapId);
		const msg = `Revert to ${commitId.slice(0, 7)}`;
		commitResult = await cmd.storeCommit(state.mapId, msg);
	} catch (e) {
		log.error("[checkout] restore failed:", e);
		throw e;
	}
	const map = await cmd.storeGetMap(state.mapId);
	setState({
		selections: [],
		selectedLocationIds: SelectedIds.EMPTY,
		activeLocationId: null,
	});
	applyOpenedMap(map, openResult);
	applyMutation(commitResult.status);

	emitEvent("render:delta", { added: [], updated: [], removed: [], fullReset: true });
	emitEvent("store:changed");
	await invalidateMapList();
}
