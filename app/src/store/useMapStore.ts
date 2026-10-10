import { memoOnRefs } from "@/lib/util/memoOnRefs";
import type { Patch, Tag } from "@/types";
import type { WorkArea, MaybeLocation } from "@/types";
import { locId } from "@/types";
import type {
	EntryKey,
	Location,
	MapMeta,
	StoreStatus,
	CountBy,
	Target,
	Answer,
	Ask,
} from "@/bindings.gen";
import { listen } from "@tauri-apps/api/event";
import { Channel } from "@tauri-apps/api/core";
import { cmd } from "@/lib/commands";
import type { ChangeEvent, Mutation, MutationResult, Derived, HeldValue } from "@/bindings.gen";
import { emit as emitEvent, useEventValue } from "@/lib/events";
import { log } from "@/lib/util/log";
import { colorForName } from "@/lib/util/color";
import { toast } from "@/lib/util/toast";
import { storeWarningText } from "@/lib/util/format";
import { mapOpen, trace } from "@/lib/util/debug";
import { mmaBufUrl, nowUnix } from "@/lib/util/util";
import { compareNatural } from "@/lib/util/util";
import type { KeySpec, PartitionBucket, StoreWarning } from "@/bindings.gen";
import type { MergeWinner, Stack } from "@/bindings.consts";
import { SelectedIds, type ReadonlyIdSet } from "@/lib/render/CellManager";
import { clearScene, loadScene, sceneReached } from "@/lib/render/sceneStore";
import { refreshPolygonFills } from "@/lib/render/polygonFills";
import { resetImportState, getImportStaging, importTarget } from "./importStaging";
import { resetCommitDiffState, resetCommitDiffCounts } from "./commitDiff";
import { setCachedMapList, invalidateMapList, reloadMapList } from "./mapList";
import * as autosave from "./autosave";
import * as edit from "./edit";

import type { Selector } from "@/types";
import type { Selection } from "@/bindings.gen";
import { selection, tagSelector, onActive, setSelections } from "./selections";

// --- Map state ---

/** The engine-owned mirror: the derived state Rust ships, with every field required. */
type EngineState = {
	[K in Exclude<keyof Derived, "meta">]: NonNullable<Derived[K]>;
};

export interface UiState {
	mapId: string | null;
	/** Persisted identity slice (metadata + settings). Changes rarely. */
	map: MapMeta | null;
	selectedLocationIds: SelectedIds;
	/** The location open in the editor, or null. */
	open: Open | null;
	/** @unstable */
	duplicateLocations: Location[];
	/** @unstable */
	workArea: WorkArea;
	/** @unstable */
	activePluginId: string | null;
}

/** Where an open row came from: the map's rows, the seen history, or a pending import. */
export type OpenOrigin = "map" | "seen" | "import";

/** A location open in the editor. A preview's id is its viewer-layer id. */
export interface Open {
	id: number;
	origin: OpenOrigin;
	/** Which opening this is: opening the same location again starts a new session. */
	session: number;
	/** The row as the viewer's layer last read it; null until the first read lands. */
	row: Location | null;
}

let lastSession = 0;
const opening = (id: number, origin: OpenOrigin, row: Location | null = null): Open => ({
	id,
	origin,
	session: ++lastSession,
	row,
});

export type MapState = UiState & EngineState;

const ENGINE_INITIAL: EngineState = {
	locationCount: 0,
	history: {},
	fieldValues: {},
	fieldDefs: {},
	selectionCounts: {},
	selectionList: [],
};

const INITIAL_STATE: MapState = {
	...ENGINE_INITIAL,
	mapId: null,
	map: null,
	selectedLocationIds: SelectedIds.EMPTY,
	open: null,
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
 *  `fieldValues` merges per value: a present value replaces its entry, a null one is gone. */
function mergeDerived(v: Derived) {
	const { fieldValues, meta, ...rest } = v;
	if (meta && state.map) state = { ...state, map: { ...state.map, ...meta } };
	state = { ...state, ...Object.fromEntries(Object.entries(rest).filter(([, x]) => x != null)) };
	if (!fieldValues) return;
	const merged = { ...state.fieldValues };
	for (const [field, values] of Object.entries(fieldValues)) {
		const next = { ...merged[field] };
		for (const [key, value] of Object.entries(values)) {
			if (value) next[key] = value;
			else delete next[key];
		}
		merged[field] = next;
	}
	state = { ...state, fieldValues: merged };
}

const NO_VALUES: Record<string, HeldValue | null> = {};

/** Per-tag location counts, keyed by numeric id. */
export const getTagCounts: () => Record<number, number> = memoOnRefs(
	() => [state.fieldValues["tags"] ?? NO_VALUES] as const,
	(values) =>
		Object.fromEntries(Object.entries(values).map(([k, v]) => [Number(k), v?.count ?? 0])),
);

/** The tag view: each value's record dressed as a tag. A tag is visible exactly while
 *  something carries it (count > 0); a value present in data without a record (foreign
 *  import) shows under a derived name/color; an emptied record lingers dark until its
 *  name is reused. */
export const getTags: () => Record<number, Tag> = memoOnRefs(
	() => [state.fieldValues["tags"] ?? NO_VALUES] as const,
	(values) => {
		const out: Record<number, Tag> = {};
		for (const [k, v] of Object.entries(values)) {
			if (!v) continue;
			const id = Number(k);
			const rec = v.record ?? {};
			const name = typeof rec.name === "string" && rec.name ? rec.name : `Tag ${id}`;
			out[id] = {
				id,
				name,
				color: typeof rec.color === "string" ? rec.color : colorForName(name),
				visible: v.count > 0,
				order: typeof rec.order === "number" ? rec.order : null,
				doclinks: Array.isArray(rec.doclinks) ? (rec.doclinks as string[]) : [],
			};
		}
		return out;
	},
);

function resetEngineState() {
	feedVersion = 0;
	feedWaiters = [];
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
		selectedLocationIds: SelectedIds.EMPTY,
		open: null,
		workArea: "overview",
	});
	resetImportState();
	resetCommitDiffState();
}

/** Every (re)open: the meta identity slice, then the open-time engine full picture. */
function applyOpenedMap(meta: MapMeta | null, status: StoreStatus) {
	feedVersion = status.version;
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

/** The one read: `ask` a question of the rows `selector` resolves to. Answers once,
 *  against the map as it is now. */
export async function read<K extends Answer["kind"]>(
	selector: Selector,
	ask: Ask,
	kind: K,
	target: Target = MAP,
): Promise<AnswerOf<K>> {
	const answer = await cmd.storeRead(target, selector, ask);
	if (answer.kind !== kind) throw new Error(`read answered ${answer.kind}, expected ${kind}`);
	return answer as AnswerOf<K>;
}

/** Full rows out of a rows answer, fetched from disk when they were many. */
export async function rowsOf(rows: AnswerOf<"rows">["rows"]): Promise<Location[]> {
	return rows.kind === "inline" ? rows.locations : (await fetch(mmaBufUrl(rows.path))).json();
}

/** Questions about the locations a selector resolves to. Each call answers once,
 *  against the map as it is now; ask again after a change. */
export function query(selector: Selector, target: Target = MAP) {
	return {
		/** The resolved ids, in map order. */
		ids: async (): Promise<number[]> => (await read(selector, { kind: "ids" }, "ids", target)).ids,
		/** How many locations resolve. */
		count: async (): Promise<number> =>
			(await read(selector, { kind: "count" }, "count", target)).count,
		/** Bounding box `[west, south, east, north]`, or null when nothing resolves. */
		bounds: async (): Promise<[number, number, number, number] | null> =>
			(await read(selector, { kind: "bounds" }, "bounds", target)).bounds,
		/** `n` ids drawn uniformly at random, without replacement. */
		sample: async (n: number): Promise<number[]> =>
			(
				await read(
					{ type: "Sample", selection: selection(selector), n },
					{ kind: "ids" },
					"ids",
					target,
				)
			).ids,
		/** Distinct values of `field`, sorted. */
		values: async (field: string): Promise<string[]> =>
			(await read(selector, { kind: "values", field }, "values", target)).values,
		/** Group each field by a derived key and count, one result per field. */
		countBy: async (fields: string[], key: KeySpec): Promise<CountBy[]> =>
			(await read(selector, { kind: "countBy", fields, key }, "counts", target)).counts,
		/** How many locations hold a value for each field, key-sorted. */
		coverage: async (): Promise<[string, number][]> =>
			(await read(selector, { kind: "coverage" }, "coverage", target)).coverage,
		/** One column per field. `null` where a location lacks the field; `"tags"`
		 *  returns a column of tag-id arrays. */
		columns: async (fields: string[]): Promise<unknown[][]> =>
			(await read(selector, { kind: "columns", fields }, "columns", target)).columns,
		/** Group by a derived key. Numeric bins arrive in bound order; other keys are
		 *  sorted naturally. */
		partition: async (field: string, key: KeySpec): Promise<PartitionBucket[]> => {
			const { groups } = await read(selector, { kind: "groupBy", field, key }, "groups", target);
			if (key.kind !== "numericBin") groups.sort((a, b) => compareNatural(a.key, b.key));
			return groups;
		},
		/** Every matching location as a full row; missing ids are skipped.
		 *
		 *  Every row lands in memory, so an unscoped call on a large map is expensive.
		 *  Prefer a narrower selector or a projection (`columns`, `countBy`) when possible. */
		locations: async (): Promise<Location[]> =>
			rowsOf((await read(selector, { kind: "rows" }, "rows", target)).rows),
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
let feedVersion = 0;
let feedWaiters: { version: number; resolve: () => void }[] = [];

/** Resolves once the change feed has delivered `version`'s event (or a later one). */
function feedReached(version: number): Promise<void> {
	if (feedVersion >= version) return Promise.resolve();
	return new Promise((resolve) => feedWaiters.push({ version, resolve }));
}

function applyChange(e: ChangeEvent) {
	feedVersion = Math.max(feedVersion, e.version);
	feedWaiters = feedWaiters.filter((w) => {
		if (e.version < w.version) return true;
		w.resolve();
		return false;
	});
	if (!state.map) return;
	mergeDerived(e.derived);
	autosave.schedule();
	emitEvent("store:change", e);
	emitEvent("store:changed");
}

const MAP: Target = { kind: "map" };

/** The viewer's own pending layer: its edits read over the map's rows as they are now,
 *  and nothing reaches the map until a save lands them. */
export const VIEWER = { kind: "pending", name: "viewer" } as const satisfies Target;

/** The open row as the viewer's layer last read it, dropped unless `session` is still open.
 *  The layer is the single writer; everything else only looks. */
export function setOpenRow(row: Location | null, session: number) {
	if (state.open?.session !== session) return;
	setState({ open: { ...state.open, row } });
}

const EMPTY_MUTATION: MutationResult = { mutation: { version: 0, added: [] } };

export async function settled(m: Mutation): Promise<void> {
	await autosave.waitForInflight();
	await Promise.all([sceneReached(m.version), feedReached(m.version)]);
	autosave.schedule();
}

export async function mutate<R extends MutationResult = MutationResult>(
	fn: () => Promise<R>,
	...fallback: MutationResult extends R ? [empty?: R] : [empty: R]
): Promise<R> {
	if (!state.map) return (fallback[0] ?? EMPTY_MUTATION) as R;
	const r = await fn();
	await settled(r.mutation);
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
	if (state.map) locs.forEach((l, i) => (l.id = r.mutation.added[i] ?? l.id));
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
	if (state.open && ids.has(state.open.id)) setWorkArea("overview");
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
}

/** Delete extra-field `key` from every location, its definition, and the listed selections,
 *  in one undoable step. */
export async function deleteField(key: string) {
	if (!state.map) return;
	await edit.work({ type: "Everything" }, { kind: "delete", keys: [key] });
}

// --- Selections ---

/** Apply `op` to the listed selections and have the store hold and resolve the result: the
 *  one way the selection changes. Lift an op over the active selections alone with
 *  `onActive`. No-op when nothing changed. @unstable */
export async function applySelectionUpdate(op: import("@/bindings.gen").SelectionOp) {
	await updateSelections(() => cmd.storeEditSelections(op));
}

/** Undo the last selection change without undoing data edits. @unstable */
export async function restoreSelections() {
	await updateSelections(() => cmd.storeStep("undo", "selections"));
}

/** Redo the last undone selection change without redoing data edits. @unstable */
export async function redoSelections() {
	await updateSelections(() => cmd.storeStep("redo", "selections"));
}

async function updateSelections(write: () => Promise<MutationResult>) {
	if (!state.map) return;
	await mutate(write);
	await refreshPolygonFills(state.selectionList);
	emitEvent("selection:change", getActiveSelections());
}

export async function select<R extends { ids: number[] }>(
	pick: (selector: Selector) => Promise<R>,
	perSelection = false,
): Promise<{ picked: number; results: R[] }> {
	const active = getActiveSelections();
	const buckets: Selector[] =
		perSelection && active.length >= 2 ? active.map((s) => s.selector) : [{ type: "Selected" }];
	const results = await Promise.all(buckets.map(pick));
	const ids = [...new Set(results.flatMap((r) => r.ids))];
	if (ids.length)
		await applySelectionUpdate(
			onActive(setSelections([selection({ type: "Manual", locations: ids })])),
		);
	return { picked: ids.length, results };
}

/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. @unstable */
export async function previewDuplicateGroups(distance: number): Promise<number[][]> {
	const { groups } = await read(
		{ type: "Everything" },
		{ kind: "duplicateGroups", distance },
		"idGroups",
	);
	return groups;
}

/** Seed the viewer's layer with a copy of `loc` and open it from `origin`: the preview's
 *  edits live in the layer and are dropped on close, never the source. */
async function openPreview(loc: Location, origin: OpenOrigin) {
	await cmd.storeDrop(VIEWER.name);
	const r = await cmd.storeEdit(VIEWER, [{ set: { ...loc, id: 0 } }], null);
	const [added] = r.mutation.added;
	if (added == null) return;
	const row =
		(await query({ type: "Locations", locations: [added], name: null }, VIEWER).locations())[0] ??
		null;
	setState({ open: opening(added, origin, row), workArea: "location" });
	emitEvent("active:change", null);
}

/** Open a staged-import location, as if it were active: the viewer previews a copy, and
 *  the staged row itself stays in the import layer until Confirm lands it. @unstable */
export async function openStagedLocation(index: number) {
	const first = getImportStaging()?.preview.firstId;
	if (first == null) return;
	const loc =
		(
			await query(
				{ type: "Locations", locations: [first + index], name: null },
				importTarget(),
			).locations()
		)[0] ?? null;
	if (!loc) return;
	await openPreview(loc, "import");
	emitEvent("import-markers:changed");
}

/** Open an arbitrary location read-only as a seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. @unstable */
export function previewLocation(loc: Location) {
	void openPreview(loc, "seen");
}

/** Drop the open row, keeping `active:change` in step. */
function clearActiveLocation(): void {
	if (state.open == null) return;
	setState({ open: null });
	emitEvent("active:change", null);
}

/** Resolve a `MaybeLocation` (id or object) into a full `Location`, or null if not found. */
export async function resolveLocation(m: MaybeLocation): Promise<Location | null> {
	return typeof m === "number"
		? ((await query({ type: "Locations", locations: [m], name: null }).locations())[0] ?? null)
		: m;
}

/** Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
 *  with 2+ locations within 2m opens the duplicate-resolution panel instead. A later
 *  opening of any kind supersedes one still loading. */
export async function setActiveLocation(target: MaybeLocation | null, checkDuplicates = true) {
	const t = trace("setActive");
	const id = target == null ? null : locId(target);
	const activation = ++lastSession;
	if (state.open && state.open.origin !== "map") {
		emitEvent("import-markers:changed");
		const wasStaged = state.open.origin === "import";
		if (id == null) {
			clearActiveLocation();

			setState({
				workArea: wasStaged ? "import" : state.activePluginId ? "plugin" : "overview",
			});
			t.end();
			return;
		}
	}
	if (id != null) {
		const loc = await resolveLocation(target!);
		t.step("ipc");
		if (activation !== lastSession) return t.end({ superseded: true });
		if (checkDuplicates && loc) {
			const nearby = await rowsOf(
				(
					await read(
						{ type: "Nearby", selection: null, lat: loc.lat, lng: loc.lng, radiusM: 2.0 },
						{ kind: "rows" },
						"rows",
					)
				).rows,
			);
			if (activation !== lastSession) return t.end({ superseded: true });
			if (nearby.length >= 2) {
				setState({ duplicateLocations: nearby, workArea: "duplicates" });
				clearActiveLocation();
				t.end({ duplicates: nearby.length });
				return;
			}
		}
		setState({ open: opening(id, "map", loc), workArea: "location" });
		emitEvent("active:change", id);
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
	setState({ open: opening(loc.id, "map", loc), workArea: "location" });
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
		{ type: "Union", selections: tagIds.map((id) => selection(tagSelector(id))) },
		{ kind: "listSet", key: "tags", add: [], remove: tagIds },
	);
}

// --- Undo/redo ---

/** Whether a history action is available for one part or for the data edit as a whole. @unstable */
export function historyAvailable(
	history: MapState["history"],
	stack: Stack,
	key?: EntryKey,
): boolean {
	if (key) return history[key]?.[stack] ?? false;
	return Object.entries(history).some(([key, history]) => key !== "selections" && history?.[stack]);
}

/** Step through the edit history one way, closing the open row if the step removed it. */
async function step(stack: Stack) {
	try {
		const r = await mutate(() => cmd.storeStep(stack, null));
		const { removed } = await sceneReached(r.mutation.version);
		if (state.open && removed.includes(state.open.id)) setWorkArea("overview");
	} catch (e) {
		log.debug(`[${stack}] nothing or failed:`, e);
	}
}

/** Undo the last edit. */
export function undo() {
	return step("undo");
}
/** Redo the last undone edit. */
export function redo() {
	return step("redo");
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
	return r.id;
}

/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. @unstable */
export async function checkoutCommit(commitId: string) {
	if (!state.mapId) return;
	await autosave.flush();
	await mutate(() => cmd.storeCheckoutCommit(state.mapId!, commitId));
	await cmd.storeCommit(state.mapId, `Revert to ${commitId.slice(0, 7)}`);
	const map = await cmd.storeGetMap(state.mapId);
	setState({ map, open: null });

	void loadScene();
	await invalidateMapList();
}
