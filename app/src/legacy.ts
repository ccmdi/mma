// Compatibility bindings for shipped plugin calls.
import { Store } from "@/store/store";
import { Maps } from "@/store/maps";
import { Field } from "@/store/field";
import { History } from "@/store/history";
import { Commit } from "@/store/commit";
import { Tag } from "@/store/tag";
import { Mutation } from "@/store/mutation";
import { Location } from "@/store/location";
import { SelectionList } from "@/store/selectionList";
import { Editor } from "@/store/editor";
import { Query } from "@/store/query";
import { Edit } from "@/store/edit";
import { Autosave } from "@/store/autosave";
import { MapHost } from "@/lib/map/host";
import { Scene } from "@/lib/render/scene";
import { addSelection, tagSelector, selection } from "@/store/selections";
import { emit, subscribe } from "@/lib/events";
import type { CountBy, KeySpec, PartitionBucket, Target } from "@/bindings.gen";
import type { EnrichFieldOption } from "@/lib/data/fieldDefs";
import { Provider } from "@/lib/data/provider";
import { storage } from "@/plugins/pluginStorage";
import { sidecar, type SidecarOptions } from "@/plugins/sidecar";
import type { MaybeLocation, Selector } from "@/types";
import type { FieldDef } from "@/bindings.gen";
import { compareNatural } from "@/lib/util/util";

/** @deprecated v0.8.1. Use `MMA.MapHost.get()` and narrow via `MMA.MapHost.instance`. @api @unstable */
export function getGoogleMap(): google.maps.Map | null {
	return MapHost.instance(MapHost.get(), "google");
}

/** @deprecated v0.8.1. Use `MMA.MapHost.wait()`. @api @unstable */
export function waitForGoogleMap(): Promise<google.maps.Map | null> {
	return MapHost.wait().then((host) => MapHost.instance(host, "google"));
}

/** @deprecated v0.8.2. Read `MMA.Store.get().map`. @api @unstable */
export function getCurrentMap() {
	return Store.get().map;
}

/** @deprecated v0.8.2. Read `MMA.Store.get().mapId`. @api @unstable */
export function getCurrentMapId() {
	return Store.get().mapId;
}

/** @deprecated v0.8.2. Read `MMA.Editor.get().open?.location`. @api @unstable */
export function getActiveLocation() {
	return Editor.get().open?.location ?? null;
}

/** @deprecated v0.8.2. Read `MMA.Scene.selected()`. @api @unstable */
export function getSelectedLocationIds() {
	return Scene.selected();
}

/** @deprecated v0.8.2. Read `MMA.Editor.get().workArea`. @api @unstable */
export function getWorkArea() {
	return Editor.get().workArea;
}

/** @deprecated v0.8.2. Read `MMA.SelectionList.listed()`. @api @unstable */
export function getAllSelections() {
	return SelectionList.listed().map((r) => r.selection);
}

/** @deprecated v0.8.2. Read `MMA.SelectionList.listed()`. @api @unstable */
export function getGhostedSelections() {
	return new Set(
		SelectionList.listed()
			.filter((r) => r.ghosted)
			.map((r) => r.selection.key),
	);
}

/** @deprecated v0.8.2. Use `MMA.SelectionList.active()`. @api @unstable */
export function getSelections() {
	return SelectionList.active();
}

/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: [id], name: null }, { kind: "locations" })`. @api @unstable */
export async function fetchLocation(id: number) {
	return (await query({ type: "Locations", locations: [id], name: null }).locations())[0] ?? null;
}

/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Locations", locations: ids, name: null }, { kind: "locations" })`. @api @unstable */
export function fetchLocationsByIds(ids: number[]) {
	return query({ type: "Locations", locations: ids, name: null }).locations();
}

/** @deprecated v0.8.4. Use `MMA.Query.read({ type: "Everything" }, { kind: "locations" })`. @api @unstable */
export function fetchAllLocations() {
	return query({ type: "Everything" }).locations();
}

/** @deprecated v0.10.2. Use `MMA.Query.read(selector, { kind: "coverage" })`. @api @unstable */
export function fieldCoverage(selector: Selector): Promise<[string, number][]> {
	return query(selector).coverage();
}

/** @deprecated v0.10.2. Use `MMA.Provider.register()`. @api @unstable */
export function registerEnrichmentProvider(provider: Provider): void {
	void Provider.register(provider);
}

/** @deprecated v0.10.5. The user layer is store-owned state (`MMA.Store.get().fieldDefs`);
 *  use `MMA.Edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
 *  for plugin-owned defs. @api @unstable */
export function setUserFieldDefs(fields: Record<string, FieldDef>) {
	return Edit.meta({ extra: { fields } });
}

/** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`. @api @unstable */
export function addTagToLocations(tagId: number, locationIds: number[]) {
	return Edit.work(
		{ type: "Locations", locations: locationIds, name: null },
		{ kind: "listSet", key: "tags", add: [tagId], remove: [] },
	);
}

/** @deprecated v0.10.5. Use `MMA.Edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @api @unstable */
export function removeTagFromLocations(tagId: number, locationIds: number[]) {
	return Edit.work(
		{ type: "Locations", locations: locationIds, name: null },
		{ kind: "listSet", key: "tags", add: [], remove: [tagId] },
	);
}

/** @deprecated v0.10.5. Use `MMA.Edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. @api @unstable */
export function removeTagFromAllLocations(tagId: number) {
	return Edit.work(tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] });
}

/** @deprecated v0.11.0. Use `MMA.storage()`. @api @unstable */
export function createPluginStorage(id: string) {
	return storage(id);
}

/** @deprecated v0.11.0. Use `MMA.sidecar.request()`. @api @unstable */
export function request<T>(
	pluginId: string,
	command: string,
	payload?: unknown,
	opts?: SidecarOptions<T>,
) {
	return sidecar.request(pluginId, command, payload, opts);
}

/** @deprecated v0.11.0. Use `MMA.sidecar.installedVersion()`. @api @unstable */
export function installedVersion(pluginId: string) {
	return sidecar.installedVersion(pluginId);
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "ids" })`. @api @unstable */
export function resolveIds(selector: Selector): Promise<number[]> {
	return query(selector).ids();
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "count" })`. @api @unstable */
export function countIn(selector: Selector): Promise<number> {
	return query(selector).count();
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "bounds" })`. @api @unstable */
export function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null> {
	return query(selector).bounds();
}

/** @deprecated v0.11.3. Use `MMA.Query.read({ type: "Sample", selection: MMA.selection(selector), n }, { kind: "ids" })`. @api @unstable */
export function sampleFrom(selector: Selector, n: number): Promise<number[]> {
	return query(selector).sample(n);
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "values", field })`. @api @unstable */
export function fieldValues(selector: Selector, field: string): Promise<string[]> {
	return query(selector).values(field);
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "countBy", fields: [field], key })`. @api @unstable */
export async function countBy(selector: Selector, field: string, key: KeySpec): Promise<CountBy> {
	const [counted] = await query(selector).countBy([field], key);
	return counted;
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "coverage" })`. @api @unstable */
export function coverage(selector: Selector): Promise<[string, number][]> {
	return query(selector).coverage();
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "columns", fields })`. @api @unstable */
export function fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]> {
	return query(selector).columns(fields);
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "groupBy", field, key })`. @api @unstable */
export function partition(
	field: string,
	key: KeySpec,
	selector: Selector,
): Promise<PartitionBucket[]> {
	return query(selector).partition(field, key);
}

/** @deprecated v0.11.3. Use `MMA.Query.read(selector, { kind: "locations" })`. @api @unstable */
export function fetchLocations(selector: Selector): Promise<Location[]> {
	return query(selector).locations();
}

/** @deprecated v0.11.3. A provider's `fieldDefs` are offered as enrichment options on their
 *  own; set `defaultOff` on the provider to make them opt-in. @api @unstable */
export function registerEnrichFields(_fields: EnrichFieldOption[]): void {}

/** @deprecated v0.11.3. Use `MMA.Edit.selections(MMA.addSelection(...selectors))`. @api @unstable */
export function addSelections(selectors: Selector[]) {
	return Edit.selections(addSelection(...selectors));
}

/** @deprecated v0.11.3. Use `MMA.Edit.selections({ kind: "remove", keys })`. @api @unstable */
export function removeSelections(keys: string[]) {
	return Edit.selections({ kind: "remove", keys });
}

/** @deprecated v0.11.3. Use `MMA.Edit.selections({ kind: "set", selections: [] })`. @api @unstable */
export function resetSelections() {
	return Edit.selections({ kind: "set", selections: [] });
}

/** @deprecated v0.11.7. Use the `{ type: "Selected" }` selector. @api @unstable */
export function currentSelection(): Selector {
	return { type: "Selected" };
}

/** @deprecated v0.12.0. Use MMA.Query.read(selector, ask) instead. @api @unstable */
export function query(selector: Selector, target: Target = { kind: "map" }) {
	return {
		/** Resolved ids in ascending order, or in ranked-selector order. */
		ids: async (): Promise<number[]> => Query.read(selector, { kind: "ids" }, target),
		/** Number of locations the selector resolves to. */
		count: async (): Promise<number> => Query.read(selector, { kind: "count" }, target),
		/** Bounding box [west, south, east, north], or null when nothing resolves. */
		bounds: async (): Promise<[number, number, number, number] | null> =>
			Query.read(selector, { kind: "bounds" }, target),
		/** n ids drawn uniformly at random, without replacement. */
		sample: async (n: number): Promise<number[]> =>
			Query.read({ type: "Sample", selection: selection(selector), n }, { kind: "ids" }, target),
		/** Distinct values of field, sorted. */
		values: async (field: string): Promise<string[]> =>
			Query.read(selector, { kind: "values", field }, target),
		/** Group each field by a derived key and count, one result per field. */
		countBy: async (fields: string[], key: KeySpec): Promise<CountBy[]> =>
			Query.read(selector, { kind: "countBy", fields, key }, target),
		/** How many locations hold a value for each field, key-sorted. */
		coverage: async (): Promise<[string, number][]> =>
			Query.read(selector, { kind: "coverage" }, target),
		/** One column per field: null for missing values and value-id lists for interned fields. */
		columns: async (fields: string[]): Promise<unknown[][]> =>
			Query.read(selector, { kind: "columns", fields }, target),
		/** Group by a derived key; bins use bound order and other keys sort naturally. */
		partition: async (field: string, key: KeySpec): Promise<PartitionBucket[]> => {
			const groups = await Query.read(selector, { kind: "groupBy", field, key }, target);
			if (key.kind !== "numericBin") groups.sort((a, b) => compareNatural(a.key, b.key));
			return groups;
		},
		/** Full matching locations, loading any large result from its temporary file. */
		locations: async (): Promise<Location[]> => Query.read(selector, { kind: "locations" }, target),
	};
}

/** @deprecated v0.12.0. Use `MMA.Editor.open(target)`, or `MMA.Editor.close()` in place of null. @api @unstable */
export async function setActiveLocation(target: MaybeLocation | null, checkDuplicates = true) {
	if (target == null) Editor.close();
	else await Editor.open(target, checkDuplicates);
}

subscribe("open:change", (id) => emit("active:change", id));

/** @deprecated v0.12.0. Use `MMA.Store.get`. @api */
export const getMapState: typeof Store.get = Store.get;

/** @deprecated v0.12.0. Use `MMA.Store.use`. @api */
export const useMapState: typeof Store.use = Store.use;

/** @deprecated v0.12.0. Use `MMA.Tag.counts`. @api */
export const getTagCounts: typeof Tag.counts = Tag.counts;

/** @deprecated v0.12.0. Use `MMA.Tag.all`. @api */
export const getTags: typeof Tag.all = Tag.all;

/** @deprecated v0.12.0. Use `MMA.Tag.visible`. @api */
export const getVisibleTags: typeof Tag.visible = Tag.visible;

/** @deprecated v0.12.0. Use `MMA.Tag.get`. @api */
export const getTag: typeof Tag.get = Tag.get;

/** @deprecated v0.12.0. Use `MMA.Tag.names`. @api */
export const tagIdsToNames: typeof Tag.names = Tag.names;

/** @deprecated v0.12.0. Use `MMA.Tag.remove`. @api */
export const deleteTags: typeof Tag.remove = Tag.remove;

/** @deprecated v0.12.0. Use `MMA.Mutation.run`. @api */
export const mutate: typeof Mutation.run = Mutation.run;

/** @deprecated v0.12.0. Use `MMA.Mutation.settle`. @api */
export const settled: typeof Mutation.settle = Mutation.settle;

/** @deprecated v0.12.0. Use `MMA.Query.read`. @api */
export const read: typeof Query.read = Query.read;

/** @deprecated v0.12.0. Use `MMA.Query.locationsOf`. @api */
export const locationsOf: typeof Query.locationsOf = Query.locationsOf;

/** @deprecated v0.12.0. Use `MMA.Location.add`. @api */
export const addLocations: typeof Location.add = Location.add;

/** @deprecated v0.12.0. Use `MMA.Location.duplicate`. @api */
export const duplicateLocation: typeof Location.duplicate = Location.duplicate;

/** @deprecated v0.12.0. Use `MMA.Location.remove`. @api */
export const removeLocations: typeof Location.remove = Location.remove;

/** @deprecated v0.12.0. Use `MMA.Location.update`. @api */
export const updateLocations: typeof Location.update = Location.update;

/** @deprecated v0.12.0. Use `MMA.Location.duplicateGroups`. @api @unstable */
export const previewDuplicateGroups: typeof Location.duplicateGroups = Location.duplicateGroups;

/** @deprecated v0.12.0. Use `MMA.Editor.openImport`. @api @unstable */
export const openStagedLocation: typeof Editor.openImport = Editor.openImport;

/** @deprecated v0.12.0. Use `MMA.Editor.preview`. @api @unstable */
export const previewLocation: typeof Editor.preview = Editor.preview;

/** @deprecated v0.12.0. Use `MMA.Editor.resolve`. @api */
export const resolveLocation: typeof Editor.resolve = Editor.resolve;

/** @deprecated v0.12.0. Use `MMA.Editor.open`. @api */
export const openLocation: typeof Editor.open = Editor.open;

/** @deprecated v0.12.0. Use `MMA.Editor.close`. @api */
export const closeLocation: typeof Editor.close = Editor.close;

/** @deprecated v0.12.0. Use `MMA.Editor.openDuplicate`. @api @unstable */
export const openDuplicateLocation: typeof Editor.openDuplicate = Editor.openDuplicate;

/** @deprecated v0.12.0. Use `MMA.Editor.removeDuplicate`. @api @unstable */
export const removeDuplicate: typeof Editor.removeDuplicate = Editor.removeDuplicate;

/** @deprecated v0.12.0. Use `MMA.Editor.closeDuplicates`. @api @unstable */
export const closeDuplicates: typeof Editor.closeDuplicates = Editor.closeDuplicates;

/** @deprecated v0.12.0. Use `MMA.Editor.setArea`. @api @unstable */
export const setWorkArea: typeof Editor.setArea = Editor.setArea;

/** @deprecated v0.12.0. Use `MMA.Editor.openPlugin`. @api */
export const setPluginMode: typeof Editor.openPlugin = Editor.openPlugin;

/** @deprecated v0.12.0. Use `MMA.Editor.closePlugin`. @api */
export const exitPluginMode: typeof Editor.closePlugin = Editor.closePlugin;

/** @deprecated v0.12.0. Use `MMA.Field.rename`. @api */
export const renameField: typeof Field.rename = Field.rename;

/** @deprecated v0.12.0. Use `MMA.Field.remove`. @api */
export const deleteField: typeof Field.remove = Field.remove;

/** @deprecated v0.12.0. Use `MMA.SelectionList.active`. @api */
export const getActiveSelections: typeof SelectionList.active = SelectionList.active;

/** @deprecated v0.12.0. Use `MMA.Edit.selections`. @api @unstable */
export const applySelectionUpdate: typeof Edit.selections = Edit.selections;

/** @deprecated v0.12.0. Use `MMA.SelectionList.select`. @api */
export const select: typeof SelectionList.select = SelectionList.select;

/** @deprecated v0.12.0. Use `MMA.History.available`. @api @unstable */
export const historyAvailable: typeof History.available = History.available;

/** @deprecated v0.12.0. Use `MMA.Commit.create`. @api */
export const commitMap: typeof Commit.create = Commit.create;

/** @deprecated v0.12.0. Use `MMA.Commit.checkout`. @api @unstable */
export const checkoutCommit: typeof Commit.checkout = Commit.checkout;

/** @deprecated v0.12.0. Use `MMA.Maps.init`. @api @unstable */
export const initStore: typeof Maps.init = Maps.init;

/** @deprecated v0.12.0. Use `MMA.Maps.open`. @api */
export const openMap: typeof Maps.open = Maps.open;

/** @deprecated v0.12.0. Use `MMA.Maps.close`. @api */
export const closeMap: typeof Maps.close = Maps.close;

/** @deprecated v0.12.0. Use `MMA.Maps.discard`. @api @unstable */
export const discardOpenMap: typeof Maps.discard = Maps.discard;

/** @deprecated v0.12.0. Use `MMA.SelectionList.tagIds`. @api @unstable */
export const getSelectedTagIds: typeof SelectionList.tagIds = SelectionList.tagIds;

/** @deprecated v0.12.0. Use `MMA.SelectionList.tagIdsDeep`. @api @unstable */
export const getSelectedTagIdsDeep: typeof SelectionList.tagIdsDeep = SelectionList.tagIdsDeep;

/** @deprecated v0.12.0. Use `MMA.Maps.useList`. @api */
export const useMapList: typeof Maps.useList = Maps.useList;

/** @deprecated v0.12.0. Use `MMA.Maps.list`. @api */
export const getMapList: typeof Maps.list = Maps.list;

/** @deprecated v0.12.0. Use `MMA.Maps.reload`. @api @unstable */
export const reloadMapList: typeof Maps.reload = Maps.reload;

/** @deprecated v0.12.0. Use `MMA.Maps.invalidate`. @api @unstable */
export const invalidateMapList: typeof Maps.invalidate = Maps.invalidate;

/** @deprecated v0.12.0. Use `MMA.Maps.create`. @api */
export const createMap: typeof Maps.create = Maps.create;

/** @deprecated v0.12.0. Use `MMA.Maps.duplicate`. @api */
export const duplicateMap: typeof Maps.duplicate = Maps.duplicate;

/** @deprecated v0.12.0. Use `MMA.Maps.remove`. @api */
export const deleteMap: typeof Maps.remove = Maps.remove;

/** @deprecated v0.12.0. Use `MMA.Maps.openScratch`. @api */
export const openScratchMap: typeof Maps.openScratch = Maps.openScratch;

/** @deprecated v0.12.0. Use `MMA.Maps.isReserved`. @api @unstable */
export const isReservedMap: typeof Maps.isReserved = Maps.isReserved;

/** @deprecated v0.12.0. Use `MMA.Maps.copyName`. @api @unstable */
export const copyName: typeof Maps.copyName = Maps.copyName;

/** @deprecated v0.12.0. Use `MMA.Maps.renameFolder`. @api */
export const renameFolder: typeof Maps.renameFolder = Maps.renameFolder;

/** @deprecated v0.12.0. Use `MMA.Maps.moveToFolder`. @api */
export const moveMapToFolder: typeof Maps.moveToFolder = Maps.moveToFolder;

/** @deprecated v0.12.0. Use `MMA.Maps.removeFolder`. @api */
export const deleteFolder: typeof Maps.removeFolder = Maps.removeFolder;

/** @deprecated v0.12.0. Use `MMA.Maps.registerBadges`. @api @unstable */
export const registerMapBadges: typeof Maps.registerBadges = Maps.registerBadges;

/** @deprecated v0.12.0. Use `MMA.Maps.badgeSources`. @api @unstable */
export const getMapBadgeSources: typeof Maps.badgeSources = Maps.badgeSources;

/** @deprecated v0.12.0. Use `MMA.Maps.badges`. @api @unstable */
export const getMapBadges: typeof Maps.badges = Maps.badges;

/** @deprecated v0.12.0. Use `MMA.Maps.useBadges`. @api @unstable */
export const useMapBadges: typeof Maps.useBadges = Maps.useBadges;

/** @deprecated v0.12.0. Use `MMA.Edit`. @api */
export const edit: typeof Edit = Edit;

/** @deprecated v0.12.0. Use `MMA.Autosave`. @api */
export const autosave: typeof Autosave = Autosave;

/** @deprecated v0.12.0. Use `MMA.MapHost.get`. @api */
export const getMapHost: typeof MapHost.get = MapHost.get;

/** @deprecated v0.12.0. Use `MMA.MapHost.wait`. @api */
export const waitForMapHost: typeof MapHost.wait = MapHost.wait;

/** @deprecated v0.12.0. Use `MMA.Provider.register`. @api */
export const registerProvider: typeof Provider.register = Provider.register;

/** @deprecated v0.13.0. Use `MMA.Scene.positions`. @api @unstable */
export const getScenePositions: typeof Scene.positions = Scene.positions;
