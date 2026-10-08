import { memoOnRefs } from "@/lib/util/memoOnRefs";
import type { Patch, Tag } from "@/types";
import type { WorkArea, MaybeLocation } from "@/types";
import { isImportPreview, isSeenPreview, locId } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import type {
	Location,
	MapMeta,
	StoreStatus,
	CountBy,
	Target,
	Answer,
	Ask,
	RowPick,
} from "@/bindings.gen";
import { listen } from "@tauri-apps/api/event";
import { Channel } from "@tauri-apps/api/core";
import { cmd } from "@/lib/commands";
import type { ChangeEvent, MutationResult, Derived } from "@/bindings.gen";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { log } from "@/lib/util/log";
import { colorForName } from "@/lib/util/color";
import { toast } from "@/lib/util/toast";
import { storeWarningText } from "@/lib/util/format";
import { mapOpen, trace } from "@/lib/util/debug";
import { mmaBufUrl, nowUnix } from "@/lib/util/util";
import { rewriteSelectionFields } from "@/store/selections";
import { compareNatural } from "@/lib/util/util";
import type { KeySpec, PartitionBucket, StoreWarning } from "@/bindings.gen";
import type { MergeWinner } from "@/bindings.consts";
import { SelectedIds, type ReadonlyIdSet } from "@/lib/render/CellManager";
import { clearScene, loadScene, sceneReached } from "@/lib/render/sceneStore";
import { refreshPolygonFills } from "@/lib/render/polygonFills";
import { resetImportState, getImportStaging, importTarget } from "./importStaging";
import { resetCommitDiffState, resetCommitDiffCounts } from "./commitDiff";
import { setCachedMapList, invalidateMapList, reloadMapList } from "./mapList";
import * as autosave from "./autosave";
import * as edit from "./edit";

import type { ListedSelection, Selection, Selector } from "@/bindings.gen";
import {
	buildSelection,
	displayColor,
	removeSelection,
	tagIdOf,
	tagSelector,
	onActive,
} from "./selections";

// --- Map state ---

/** The engine-owned mirror: the derived state Rust ships, with every field required. Dead
 *  values are an announcement the change handler consumes, never state. */
type EngineState = {
	[K in Exclude<keyof Derived, "deadValues">]: NonNullable<Derived[K]>;
};

export interface UiState {
	mapId: string | null;
	/** Persisted identity slice (metadata + settings). Changes rarely. */
	map: MapMeta | null;
	/** The selections as the sidebar lists them, ghosted ones included. Everything that acts on
	 *  the selection reads `getActiveSelections` instead. @unstable */
	selectionList: ListedSelection[];
	selectedLocationIds: SelectedIds;
	/** The id of the row open in the editor, or null. A preview's is its viewer-layer id. */
	openId: number | null;
	/** The open row as the viewer's layer sees it: the one row projection JS keeps. The
	 *  layer is the only writer; this mirrors its latest read. */
	openRow: Location | null;
	/** @unstable */
	duplicateLocations: Location[];
	/** @unstable */
	workArea: WorkArea;
	/** @unstable */
	activePluginId: string | null;
}

export type MapState = UiState & EngineState;

const ENGINE_INITIAL: EngineState = {
	locationCount: 0,
	canUndo: false,
	canRedo: false,
	valueCounts: {},
	valueMeta: {},
	fieldDefs: {},
	selectionCounts: {},
};

const INITIAL_STATE: MapState = {
	...ENGINE_INITIAL,
	mapId: null,
	map: null,
	selectionList: [],
	selectedLocationIds: SelectedIds.EMPTY,
	openId: null,
	openRow: null,
	duplicateLocations: [],
	workArea: "overview",
	activePluginId: null,
};

let state: MapState = INITIAL_STATE;

/** Re-mint the state object with a shallow patch. Field values are hook
 *  snapshots: reassign, never mutate in place. */
function setState(patch: Partial<MapState>) {
	state = { ...state, ...patch };
	emitEvent("store:changed");
}

/** Merge the derived state Rust shipped (JSON merge patch: null = unchanged).
 *  `valueCounts`/`valueMeta` merge per field: each present field replaces its whole
 *  map, absent fields keep theirs. */
function mergeDerived(v: Omit<Derived, "deadValues">) {
	const { valueCounts, valueMeta, ...rest } = v;
	state = { ...state, ...Object.fromEntries(Object.entries(rest).filter(([, x]) => x != null)) };
	if (valueCounts) state = { ...state, valueCounts: { ...state.valueCounts, ...valueCounts } };
	if (valueMeta) state = { ...state, valueMeta: { ...state.valueMeta, ...valueMeta } };
}

const NO_COUNTS: Record<string, number> = {};
const NO_META: Record<number, Record<string, unknown>> = {};

/** Per-tag location counts: `valueCounts.tags` re-keyed by numeric id. */
export const getTagCounts: () => Record<number, number> = memoOnRefs(
	() => [state.valueCounts["tags"] ?? NO_COUNTS] as const,
	(counts) => Object.fromEntries(Object.entries(counts).map(([k, n]) => [Number(k), n])),
);

/** The tag view: `valueMeta.tags` piles dressed over the counts, recomputed only when
 *  either slice moves. A tag is visible exactly while something carries it (count > 0);
 *  a value present in data without metadata (foreign import) shows under a derived
 *  name/color; emptied metadata lingers dark until its name is reused. */
export const getTags: () => Record<number, Tag> = memoOnRefs(
	() => [state.valueMeta["tags"] ?? NO_META, getTagCounts()] as const,
	(meta, counts) => {
		const out: Record<number, Tag> = {};
		for (const [k, rec] of Object.entries(meta)) {
			const id = Number(k);
			const name = typeof rec.name === "string" && rec.name ? rec.name : `Tag ${id}`;
			out[id] = {
				id,
				name,
				color: typeof rec.color === "string" ? rec.color : colorForName(name),
				visible: (counts[id] ?? 0) > 0,
				order: typeof rec.order === "number" ? rec.order : null,
				doclinks: Array.isArray(rec.doclinks) ? (rec.doclinks as string[]) : [],
			};
		}
		for (const [k, n] of Object.entries(counts)) {
			const id = Number(k);
			if (n > 0 && !out[id]) {
				const name = `Tag ${id}`;
				out[id] = { id, name, color: colorForName(name), visible: true, order: null, doclinks: [] };
			}
		}
		return out;
	},
);

function resetEngineState() {
	setState(ENGINE_INITIAL);
}

/** Reactive slice of the map state. Re-renders only when the selected value's
 *  reference changes (`Object.is`), so selectors must return state fields or
 *  memoized values, not a new value per call. */
export function useMapState<T>(selector: (s: MapState) => T): T {
	return useEventValue("store:changed", () => selector(state));
}

/** Imperative snapshot of the map state. */
export function getMapState(): Readonly<MapState> {
	return state;
}

/** Tags that exist from the user's point of view: the ones something carries. Raw
 *  `tags` also holds dark metadata ghosts (count=0, visible=false) - almost nothing
 *  should enumerate those. */
export const getVisibleTags: () => Tag[] = memoOnRefs(
	() => [getTags()] as const,
	(tags) => Object.values(tags).filter((t) => t.visible !== false),
);

/** Raw by-id tag lookup — includes dark metadata ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
export function getTag(id: number): Tag | undefined {
	return getTags()[id];
}

/** Tag names for the given ids, skipping any that no longer resolve. */
export function tagIdsToNames(ids: number[]): string[] {
	return ids.map((id) => getTags()[id]?.name).filter((n): n is string => n != null);
}

// --- Init (called once at startup) ---
/** One-time store startup. The app calls this; plugins never need to. @unstable */
export async function initStore() {
	setCachedMapList(await cmd.storeListMaps());
	emitEvent("store:changed");
	// App-lifetime listeners: never unsubscribed, so the handles are dropped on purpose.
	void listen("map-list-changed", () => void reloadMapList());
	void listen<StoreWarning>("store-warning", (e) => toast(storeWarningText(e.payload), 8000));
}

/** Reset all per-map editing state to its initial values. */
function clearEditState() {
	setState({
		selectionList: [],
		selectedLocationIds: SelectedIds.EMPTY,
		openId: null,
		openRow: null,
		workArea: "overview",
	});
	resetImportState();
	resetCommitDiffState();
}

/** Every (re)open: the meta identity slice, then the open-time engine full picture. */
function applyOpenedMap(meta: MapMeta | null, status: StoreStatus) {
	setState({ map: meta });
	mergeDerived(status.derived);
}

/** Hear the store's change feed for this window's map and republish it locally. */
async function subscribeChanges() {
	const ch = new Channel<ChangeEvent>();
	ch.onmessage = applyChange;
	await cmd.storeSubscribeChanges(ch);
}

// --- Actions ---
/** Open a map in this window, closing any currently open map first. */
export async function openMap(id: string) {
	mapOpen.begin();

	autosave.cancel();
	await autosave.waitForInflight();

	const t = trace("openMap");
	setState({ mapId: id, map: null });
	const meta = await cmd.storeGetMap(id);
	t.step("getMap");

	if (meta) {
		try {
			const openResult = await cmd.storeOpenMap(id);
			t.step("store_open_map");
			mapOpen.mark("data");
			applyOpenedMap(meta, openResult);
			void subscribeChanges().catch((e: unknown) =>
				log.error("[openMap] change feed subscription failed:", e),
			);
		} catch (e) {
			log.error("[openMap] store_open_map failed:", e);
			setState({ mapId: null, map: null });
			return;
		}
		void cmd.storeTouchMapOpened(id);
	}

	clearEditState();
	t.end();
	if (state.map) emitEvent("map:open", state.map);
}

/** Tear down all in-memory state for the open map. */
function resetMapState() {
	emitEvent("map:close");
	setState({ mapId: null, map: null });

	clearEditState();

	clearScene();
	resetEngineState();
}

/** Close the open map, saving unsaved changes first. */
export async function closeMap() {
	await autosave.flush();
	resetMapState();
	await cmd.storeCloseMap();
}

/** Drop the open map without persisting anything @unstable */
export function discardOpenMap() {
	autosave.cancel();
	resetMapState();
}

type AnswerOf<K extends Answer["kind"]> = Extract<Answer, { kind: K }>;

/** The one read: `ask` a question of the rows `selector` resolves to, optionally
 *  narrowed by `pick` first. Answers once, against the map as it is now. */
export async function read<K extends Answer["kind"]>(
	selector: Selector,
	pick: RowPick | null,
	ask: Ask,
	kind: K,
): Promise<AnswerOf<K>> {
	const answer = await cmd.storeRead(selector, pick, ask);
	if (answer.kind !== kind) throw new Error(`read answered ${answer.kind}, expected ${kind}`);
	return answer as AnswerOf<K>;
}

/** Full rows out of a rows answer, fetched from disk when they were many. */
export async function rowsOf(rows: AnswerOf<"rows">["rows"]): Promise<Location[]> {
	return rows.kind === "inline" ? rows.locations : (await fetch(mmaBufUrl(rows.path))).json();
}

/** Questions about the locations a selector resolves to. Each call answers once,
 *  against the map as it is now; ask again after a change. */
export function query(selector: Selector) {
	return {
		/** The resolved ids, in map order. */
		ids: async (): Promise<number[]> => (await read(selector, null, { kind: "ids" }, "ids")).ids,
		/** How many locations resolve. */
		count: async (): Promise<number> =>
			(await read(selector, null, { kind: "count" }, "count")).count,
		/** Bounding box `[west, south, east, north]`, or null when nothing resolves. */
		bounds: async (): Promise<[number, number, number, number] | null> =>
			(await read(selector, null, { kind: "bounds" }, "bounds")).bounds,
		/** `n` ids drawn uniformly at random, without replacement. */
		sample: async (n: number): Promise<number[]> =>
			(await read(selector, { kind: "sample", n }, { kind: "ids" }, "ids")).ids,
		/** Distinct values of `field`, sorted. */
		values: async (field: string): Promise<string[]> =>
			(await read(selector, null, { kind: "values", field }, "values")).values,
		/** Group each field by a derived key and count, one result per field. */
		countBy: async (fields: string[], key: KeySpec): Promise<CountBy[]> =>
			(await read(selector, null, { kind: "countBy", fields, key }, "counts")).counts,
		/** How many locations hold a value for each field, key-sorted. */
		coverage: async (): Promise<[string, number][]> =>
			(await read(selector, null, { kind: "coverage" }, "coverage")).coverage,
		/** One column per field. `null` where a location lacks the field; `"tags"`
		 *  returns a column of tag-id arrays. */
		columns: async (fields: string[]): Promise<unknown[][]> =>
			(await read(selector, null, { kind: "columns", fields }, "columns")).columns,
		/** Group by a derived key. Numeric bins arrive in bound order; other keys are
		 *  sorted naturally. */
		partition: async (field: string, key: KeySpec): Promise<PartitionBucket[]> => {
			const { groups } = await read(selector, null, { kind: "groupBy", field, key }, "groups");
			if (key.kind !== "numericBin") groups.sort((a, b) => compareNatural(a.key, b.key));
			return groups;
		},
		/** Every matching location as a full row; missing ids are skipped.
		 *
		 *  Every row lands in memory, so an unscoped call on a large map is expensive.
		 *  Prefer a narrower selector or a projection (`columns`, `countBy`) when possible. */
		locations: async (): Promise<Location[]> =>
			rowsOf((await read(selector, null, { kind: "rows" }, "rows")).rows),
	};
}

/** The selection: every listed selection that is not ghosted. */
export const getActiveSelections: () => Selection[] = memoOnRefs(
	() => [state.selectionList] as const,
	(rows) => rows.filter((r) => !r.ghosted).map((r) => r.selection),
);

/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want. @unstable */
export function setSelectedLocationIds(ids: SelectedIds) {
	setState({ selectedLocationIds: ids });
}

/** Replace the open map's row in state; persisting it is the caller's. @unstable */
export function setMap(map: MapMeta) {
	setState({ map });
}

/** A change event carries only what moved: every present value replaces its slice,
 *  every null value was untouched and keeps its reference. */
function applyChange(e: ChangeEvent) {
	if (!state.map) return;
	const { deadValues, ...derived } = e.derived;
	mergeDerived(derived);

	const deadTags = deadValues?.tags ?? [];
	if (deadTags.length > 0)
		void applySelectionUpdate(
			removeSelection(...deadTags.map((id) => buildSelection(tagSelector(id)).key)),
		);
	if (derived.valueMeta?.tags && getActiveSelections().some((s) => tagIdOf(s.selector) != null))
		void syncSelections();
	if (e.added.length || e.removed.length || e.updated.length) autosave.schedule();
	emitEvent("store:change", e);
	emitEvent("store:changed");
}

const MAP: Target = { kind: "map" };

/** The viewer's own pending layer: its edits read over the map's rows as they are now,
 *  and nothing reaches the map until a save lands them. */
export const VIEWER = { kind: "pending", name: "viewer" } as const satisfies Target;

/** The open row as the viewer's layer last read it. The layer is the single writer;
 *  everything else only looks. */
export function setOpenRow(row: Location | null) {
	setState({ openRow: row });
}

const EMPTY_MUTATION: MutationResult = {
	version: 0,
	added: [],
};

/** Settle a mutation that already ran: wait for the scene to draw its version and
 *  schedule a save. @unstable */
export async function settled(m: MutationResult): Promise<void> {
	await autosave.waitForInflight();
	await sceneReached(m.version);
	autosave.schedule();
}

/** Run a mutation and settle it; what it changed arrives on the change feed. A result
 *  that wraps its mutation comes back whole; `empty` is its answer when no map is
 *  open. @unstable */
export function mutate(fn: () => Promise<MutationResult>): Promise<MutationResult>;
export function mutate<R extends { mutation: MutationResult }>(
	fn: () => Promise<R>,
	empty: R,
): Promise<R>;
export async function mutate<R extends MutationResult | { mutation: MutationResult }>(
	fn: () => Promise<R>,
	empty: R = EMPTY_MUTATION as R,
): Promise<R> {
	if (!state.map) return empty;
	const r = await fn();
	const answer: MutationResult | { mutation: MutationResult } = r;
	await settled("mutation" in answer ? answer.mutation : answer);
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
 *  objects - build with `createLocation` (id 0) and read `loc.id` after. Undoable. */
export async function addLocations(locs: Location[]) {
	if (locs.length === 0) return;
	const t = trace("add");
	const r =
		locs.length > ADD_CHUNK
			? await mutate(() => addViaUpload(locs))
			: await edit.rows(
					MAP,
					locs.map((l) => ({ set: l })),
				);
	t.end({ added: locs.length });
	if (state.map) locs.forEach((l, i) => (l.id = r.added[i] ?? l.id));
}

/** Clone a location in place and return the new id, or null if it doesn't exist. Undoable. */
export async function duplicateLocation(id: number): Promise<number | null> {
	if (!state.map) return null;
	const [loc] = await query({ type: "Locations", locations: [id], name: null }).locations();
	if (!loc) return null;
	const now = nowUnix();
	const clone: Location = { ...loc, id: 0, createdAt: now, modifiedAt: now };
	await addLocations([clone]);
	return clone.id;
}

/** Remove locations by id. Undoable. */
export async function removeLocations(ids: ReadonlyIdSet) {
	if (ids.size === 0) return;
	if (state.openId && ids.has(state.openId)) setWorkArea("overview");
	emitEvent("store:changed");
	await edit
		.rows(
			MAP,
			[...ids].map((id) => ({ remove: id })),
		)
		.catch((e) => log.error("[delete] store_edit remove failed:", e));
}

/** Patch locations by id. Only include the fields you're changing; `extra` merges
 *  per-key (null deletes a key). Undoable by default. */
export async function updateLocations(updates: Patch<Location>[]) {
	if (updates.length === 0) return;
	await edit.rows(
		MAP,
		updates.map((put) => ({ put })),
	);
}

// --- Bulk metadata-field operations ---

/** Rename extra-field `from` to `to` across all locations, its definition, and the listed
 *  selections, in one undoable step. When a location already holds `to`, `winner` decides
 *  which value survives. Saved selections are map-independent rules and keep their names. */
export async function renameField(from: string, to: string, winner: MergeWinner = "from") {
	if (!state.map || from === to || !to) return;
	await edit.work({ type: "Everything" }, { kind: "move", from, to, winner });
	await applySelectionUpdate(rewriteSelectionFields(from, to));
}

/** Delete extra-field `key` from every location, its definition, and the listed selections,
 *  in one undoable step. */
export async function deleteField(key: string) {
	if (!state.map) return;
	await edit.work({ type: "Everything" }, { kind: "delete", keys: [key] });
	await applySelectionUpdate(rewriteSelectionFields(key, null));
}

// --- Selections ---

/** Apply `op` to the listed selections and re-resolve them: the one way the selection changes.
 *  Lift an op over the active selections alone with `onActive`. No-op when nothing changed. @unstable */
export async function applySelectionUpdate(op: (rows: ListedSelection[]) => ListedSelection[]) {
	if (!state.map) return;
	const selectionList = op(state.selectionList);
	if (selectionList === state.selectionList) return;
	setState({ selectionList });
	return syncSelections();
}

/** Re-resolve all selections against the current map data and update the overlay.
 *  Use when the underlying data changed but the selections themselves did not. @unstable */
export async function syncSelections() {
	if (!state.map) return;
	const t = trace("selection", { summary: true });
	const [result] = await Promise.all([
		cmd.storeSyncSelections(
			state.selectionList.map((r) => ({
				...r,
				selection: { ...r.selection, color: displayColor(r.selection) },
			})),
		),
		refreshPolygonFills(state.selectionList),
	]);
	t.step("ipc");
	await sceneReached(result.version);
	t.end();
	emitEvent("selection:change", getActiveSelections());
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
 *  Returns the number of ids actually picked (0 when nothing is selected). @unstable */
export async function selectRandomFromSelection(
	count: number,
	perSelection = false,
): Promise<number> {
	const buckets = await Promise.all(
		pickBuckets(perSelection).map((selector) =>
			query(selector ?? { type: "Selected" }).sample(count),
		),
	);
	const picked = [...new Set(buckets.flat())];
	if (picked.length === 0) return 0;
	await applySelectionUpdate(
		onActive(() => [buildSelection({ type: "Manual", locations: picked })]),
	);

	return picked.length;
}

/** Replace the current selection with what `pick` chooses from each pick bucket. Returns the
 *  count picked and the spacing they were picked at. */
async function selectSpacedWith(
	pick: (selector: Selector) => Promise<{ ids: number[]; distanceM: number }>,
	perSelection: boolean,
): Promise<{ picked: number; distanceM: number }> {
	const results = await Promise.all(
		pickBuckets(perSelection).map((selector) => pick(selector ?? { type: "Selected" })),
	);
	const ids = [...new Set(results.flatMap((r) => r.ids))];
	if (ids.length === 0) return { picked: 0, distanceM: 0 };
	await applySelectionUpdate(onActive(() => [buildSelection({ type: "Manual", locations: ids })]));

	// Spacing only holds within a bucket - two buckets can each pick a coincident location.
	const distanceM = results.length === 1 ? results[0].distanceM : 0;
	return { picked: ids.length, distanceM };
}

/** Replace the current selection with spatially spaced ids - either `count` ids maximizing
 *  spacing, or as many as fit at `minDistanceM`. With `perSelection`, each active selection
 *  is picked from separately. Returns the count picked and the minimum distance achieved. @unstable */
export function selectSpacedFromSelection(
	opts: { count?: number; minDistanceM?: number },
	perSelection = false,
): Promise<{ picked: number; distanceM: number }> {
	return selectSpacedWith(
		(selector) =>
			read(
				selector,
				{
					kind: "spaced",
					targetCount: opts.count ?? null,
					minDistanceM: opts.minDistanceM ?? null,
				},
				{ kind: "ids" },
				"ids",
			).then(({ ids, spacingM }) => ({ ids, distanceM: spacingM ?? 0 })),
		perSelection,
	);
}

/** Replace the current selection with evenly spaced ids laid out on a honeycomb - either at
 *  most `count` ids spaced as widely as that allows, or ids about `spacingM` apart. No two
 *  picks sit closer than half the spacing. With `perSelection`, each active selection is
 *  picked from separately. Returns the count picked and the spacing used. @unstable */
export function selectEvenlySpacedFromSelection(
	opts: { count?: number; spacingM?: number },
	perSelection = false,
): Promise<{ picked: number; distanceM: number }> {
	return selectSpacedWith(
		(selector) =>
			read(
				selector,
				{ kind: "evenlySpaced", targetCount: opts.count ?? null, spacingM: opts.spacingM ?? null },
				{ kind: "ids" },
				"ids",
			).then(({ ids, spacingM }) => ({ ids, distanceM: spacingM ?? 0 })),
		perSelection,
	);
}

/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. @unstable */
export async function previewDuplicateGroups(distance: number): Promise<number[][]> {
	const { groups } = await read(
		{ type: "Everything" },
		null,
		{ kind: "duplicateGroups", distance },
		"idGroups",
	);
	return groups;
}

/** Seed the viewer's layer with a copy of `loc` under `flag` and open it: the preview's
 *  edits live in the layer and are dropped on close, never the source. */
async function openPreview(loc: Location, flag: number) {
	await cmd.storeDrop(VIEWER.name);
	const r = await cmd.storeEdit(
		VIEWER,
		[{ set: { ...loc, id: 0, flags: loc.flags | flag } }],
		null,
	);
	const [added] = r.added;
	if (added == null) return;
	const row = await cmd.storeRow(VIEWER, added);
	setState({ openId: added, openRow: row, workArea: "location" });
	emitEvent("active:change", null);
}

/** Open a staged-import location, as if it were active: the viewer previews a copy, and
 *  the staged row itself stays in the import layer until Confirm lands it. @unstable */
export async function openStagedLocation(index: number) {
	const first = getImportStaging()?.preview.firstId;
	if (first == null) return;
	const loc = await cmd.storeRow(importTarget(), first + index);
	if (!loc) return;
	await openPreview(loc, LocationFlag.ImportPreview);
	emitEvent("import-markers:changed");
}

/** Open an arbitrary location read-only as a seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
export function previewLocation(loc: Location) {
	void openPreview(loc, LocationFlag.SeenOverlay);
}

/** Drop the open row, keeping `active:change` in step. */
function clearActiveLocation(): void {
	if (state.openId == null && state.openRow == null) return;
	setState({ openId: null, openRow: null });
	emitEvent("active:change", null);
}

/** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
export async function resolveLocation(m: MaybeLocation): Promise<Location | null> {
	return typeof m === "number"
		? ((await query({ type: "Locations", locations: [m], name: null }).locations())[0] ?? null)
		: m;
}

/** Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
 *  with 2+ locations within 2m opens the duplicate-resolution panel instead. */
export async function setActiveLocation(target: MaybeLocation | null, checkDuplicates = true) {
	const t = trace("setActive");
	const id = target == null ? null : locId(target);
	if (state.openRow && (isImportPreview(state.openRow) || isSeenPreview(state.openRow))) {
		emitEvent("import-markers:changed");
		const wasStaged = isImportPreview(state.openRow);
		if (id == null) {
			clearActiveLocation();

			setState({
				workArea: wasStaged ? "import" : state.activePluginId ? "plugin" : "overview",
			});
			t.end();
			return;
		}
	}
	setState({ openId: id });
	if (id) {
		const loc = await resolveLocation(target!);
		t.step("ipc");
		if (state.openId !== id) return t.end({ superseded: true });
		if (checkDuplicates && loc) {
			const nearby = await rowsOf(
				(
					await read(
						{ type: "Everything" },
						{ kind: "nearby", lat: loc.lat, lng: loc.lng, radiusM: 2.0 },
						{ kind: "rows" },
						"rows",
					)
				).rows,
			);
			if (state.openId !== id) return t.end({ superseded: true });
			if (nearby.length >= 2) {
				setState({ duplicateLocations: nearby, workArea: "duplicates" });
				clearActiveLocation();
				t.end({ duplicates: nearby.length });
				return;
			}
		}
		setState({ openRow: loc ?? null, workArea: "location" });
		emitEvent("active:change", state.openId);
		t.end();
		return;
	}
	clearActiveLocation();
	setState({
		duplicateLocations: [],
		workArea: state.activePluginId ? "plugin" : "overview",
	});
	t.end();
}

/** Open one location from the duplicate-resolution panel in the editor. @unstable */
export function openDuplicateLocation(loc: Location) {
	setState({ openId: loc.id, openRow: loc, workArea: "location" });
}

/** Drop a location from the duplicate-resolution panel (does not delete it). @unstable */
export function removeDuplicate(id: number) {
	setState({ duplicateLocations: state.duplicateLocations.filter((l) => l.id !== id) });
}

/** Close the duplicate-resolution panel and return to the overview. @unstable */
export function closeDuplicates() {
	setState({ duplicateLocations: [] });
	setWorkArea("overview");
}

/** Transition the editor pane, enforcing state invariants:
 *  leaving "location" clears the active location, leaving "plugin" clears the plugin id. @unstable */
export function setWorkArea(area: WorkArea) {
	setState({ workArea: area });
	if (area !== "location") clearActiveLocation();
	if (area !== "plugin") setState({ activePluginId: null });
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

// --- Tags ---

/** Strip `tagIds` from every location in one undoable step. The emptied records go dark
 *  (count 0 hides them); undo restores the rows and the tags with them. */
export function deleteTags(tagIds: number[]) {
	return edit.work(
		{ type: "Union", selections: tagIds.map((id) => buildSelection(tagSelector(id))) },
		{ kind: "listSet", key: "tags", add: [], remove: tagIds },
	);
}

// --- Undo/redo ---

/** Shared undo/redo handler: call the IPC, clear active if removed. */
async function undoRedo(which: () => Promise<MutationResult>) {
	try {
		const r = await mutate(which);
		const { removed } = await sceneReached(r.version);
		if (state.openId && removed.includes(state.openId)) setWorkArea("overview");
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
	autosave.cancel();
	await autosave.waitForInflight();

	const r = await cmd.storeCommit(state.mapId, message ?? null);
	t.step("commit");
	t.end();
	resetCommitDiffCounts();
	void invalidateMapList();

	// Commit clears the overlay; commit-sensitive selections (e.g. Uncommitted) must
	// re-resolve against the new baseline instead of showing now-committed rows.
	if (state.selectionList.length > 0) await syncSelections();
	return r.id;
}

/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. @unstable */
export async function checkoutCommit(commitId: string) {
	if (!state.mapId) return;
	await autosave.flush();
	let openResult;
	let commitResult;
	try {
		await cmd.storeCloseMap();
		try {
			await cmd.storeCheckoutCommit(state.mapId, commitId);
		} finally {
			openResult = await cmd.storeOpenMap(state.mapId);
		}
		const msg = `Revert to ${commitId.slice(0, 7)}`;
		commitResult = await cmd.storeCommit(state.mapId, msg);
	} catch (e) {
		log.error("[checkout] restore failed:", e);
		// The reopened store holds no selections; push the listed ones back before surfacing.
		await syncSelections().catch(() => {});
		throw e;
	}
	const map = await cmd.storeGetMap(state.mapId);
	setState({
		selectionList: [],
		selectedLocationIds: SelectedIds.EMPTY,
		openId: null,
	});
	applyOpenedMap(map, openResult);
	void commitResult;

	void loadScene();
	await invalidateMapList();
}
