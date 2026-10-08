// Legacy API shims for plugins. Every export is deprecated: kept only so
// plugins built against an older MMA keep working. New code must not call these.

import { getMapHost, waitForMapHost } from "@/lib/map/mapState";
import { hostInstance } from "@/lib/map/host";
import { addSelection, removeSelection, tagSelector } from "@/store/selections";
import { applySelectionUpdate, getMapState, getActiveSelections, query } from "@/store/useMapStore";
import { cmd } from "@/lib/commands";
import * as edit from "@/store/edit";
import type { CountBy, KeySpec, Location, PartitionBucket } from "@/bindings.gen";
import { registerProvider, type EnrichFieldOption, type Provider } from "@/lib/data/fieldDefs";
import { storage } from "@/plugins/pluginStorage";
import { sidecar, type SidecarOptions } from "@/plugins/sidecar";
import type { Selector } from "@/types";
import type { FieldDef } from "@/bindings.gen";

/** @deprecated v0.8.1. Use `MMA.getMapHost()` and narrow via `hostInstance`. */
export function getGoogleMap(): google.maps.Map | null {
	return hostInstance(getMapHost(), "google");
}

/** @deprecated v0.8.1. Use `MMA.waitForMapHost()`. */
export function waitForGoogleMap(): Promise<google.maps.Map | null> {
	return waitForMapHost().then((host) => hostInstance(host, "google"));
}

/** @deprecated v0.8.2. Read `MMA.getMapState().map`. */
export function getCurrentMap() {
	return getMapState().map;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().mapId`. */
export function getCurrentMapId() {
	return getMapState().mapId;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().openRow`. */
export function getActiveLocation() {
	return getMapState().openRow;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().selectedLocationIds`. */
export function getSelectedLocationIds() {
	return getMapState().selectedLocationIds;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().workArea`. */
export function getWorkArea() {
	return getMapState().workArea;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().selectionList`. */
export function getAllSelections() {
	return getMapState().selectionList.map((r) => r.selection);
}

/** @deprecated v0.8.2. Read `MMA.getMapState().selectionList`. */
export function getGhostedSelections() {
	return new Set(
		getMapState()
			.selectionList.filter((r) => r.ghosted)
			.map((r) => r.selection.key),
	);
}

/** @deprecated v0.8.2. Use `MMA.getActiveSelections()`. */
export function getSelections() {
	return getActiveSelections();
}

/** @deprecated v0.8.2. Ask `MMA.read` for the summary and take `dirtyCount`. */
export async function getDirtyCount(): Promise<number> {
	return (await cmd.storeSummary()).dirtyCount;
}

/** @deprecated v0.8.4. Use `MMA.query({ type: "Locations", locations: [id], name: null }).locations()`. */
export async function fetchLocation(id: number) {
	return (await query({ type: "Locations", locations: [id], name: null }).locations())[0] ?? null;
}

/** @deprecated v0.8.4. Use `MMA.query({ type: "Locations", locations: ids, name: null }).locations()`. */
export function fetchLocationsByIds(ids: number[]) {
	return query({ type: "Locations", locations: ids, name: null }).locations();
}

/** @deprecated v0.8.4. Use `MMA.query({ type: "Everything" }).locations()`. */
export function fetchAllLocations() {
	return query({ type: "Everything" }).locations();
}

/** @deprecated v0.10.2. Use `MMA.query(selector).coverage()`. */
export function fieldCoverage(selector: Selector): Promise<[string, number][]> {
	return query(selector).coverage();
}

/** @deprecated v0.11.7. Use the `{ type: "Selected" }` selector. */
export function currentSelection(): Selector {
	return { type: "Selected" };
}

/** @deprecated v0.11.3. Use `MMA.query(selector).ids()`. */
export function resolveIds(selector: Selector): Promise<number[]> {
	return query(selector).ids();
}

/** @deprecated v0.11.3. Use `MMA.query(selector).count()`. */
export function countIn(selector: Selector): Promise<number> {
	return query(selector).count();
}

/** @deprecated v0.11.3. Use `MMA.query(selector).bounds()`. */
export function fetchBounds(selector: Selector): Promise<[number, number, number, number] | null> {
	return query(selector).bounds();
}

/** @deprecated v0.11.3. Use `MMA.query(selector).sample(n)`. */
export function sampleFrom(selector: Selector, n: number): Promise<number[]> {
	return query(selector).sample(n);
}

/** @deprecated v0.11.3. Use `MMA.query(selector).values(field)`. */
export function fieldValues(selector: Selector, field: string): Promise<string[]> {
	return query(selector).values(field);
}

/** @deprecated v0.11.3. Use `MMA.query(selector).countBy([field], key)`. */
export async function countBy(selector: Selector, field: string, key: KeySpec): Promise<CountBy> {
	const [counted] = await query(selector).countBy([field], key);
	return counted;
}

/** @deprecated v0.11.3. Use `MMA.query(selector).coverage()`. */
export function coverage(selector: Selector): Promise<[string, number][]> {
	return query(selector).coverage();
}

/** @deprecated v0.11.3. Use `MMA.query(selector).columns(fields)`. */
export function fetchColumns(selector: Selector, fields: string[]): Promise<unknown[][]> {
	return query(selector).columns(fields);
}

/** @deprecated v0.11.3. Use `MMA.query(selector).partition(field, key)`. */
export function partition(
	field: string,
	key: KeySpec,
	selector: Selector,
): Promise<PartitionBucket[]> {
	return query(selector).partition(field, key);
}

/** @deprecated v0.11.3. Use `MMA.query(selector).locations()`. */
export function fetchLocations(selector: Selector): Promise<Location[]> {
	return query(selector).locations();
}

/** @deprecated v0.10.2. Use `MMA.registerProvider()`. */
export function registerEnrichmentProvider(provider: Provider): void {
	registerProvider(provider);
}

/** @deprecated v0.11.3. A provider's `fieldDefs` are offered as enrichment options on their
 *  own; set `defaultOff` on the provider to make them opt-in. */
export function registerEnrichFields(_fields: EnrichFieldOption[]): void {}

/** @deprecated v0.10.5. The user layer is Rust-owned state (`MMA.getMapState().fieldDefs`);
 *  use `MMA.edit.meta({ extra: { fields } })` to change it, or `MMA.registerPluginFieldDefs()`
 *  for plugin-owned defs. */
export function setUserFieldDefs(fields: Record<string, FieldDef>) {
	return edit.meta({ extra: { ...getMapState().map?.extra, fields } });
}

/** @deprecated v0.11.0. Use `MMA.storage()`. */
export function createPluginStorage(id: string) {
	return storage(id);
}

/** @deprecated v0.11.0. Use `MMA.sidecar.request()`. */
export function request<T>(
	pluginId: string,
	command: string,
	payload?: unknown,
	opts?: SidecarOptions<T>,
) {
	return sidecar.request(pluginId, command, payload, opts);
}

/** @deprecated v0.11.0. Use `MMA.sidecar.installedVersion()`. */
export function installedVersion(pluginId: string) {
	return sidecar.installedVersion(pluginId);
}

/** @deprecated v0.10.5. Use `MMA.edit.work(selector, { kind: "listSet", key: "tags", add: [tagId], remove: [] })`. */
export function addTagToLocations(tagId: number, locationIds: number[]) {
	return edit.work(
		{ type: "Locations", locations: locationIds, name: null },
		{ kind: "listSet", key: "tags", add: [tagId], remove: [] },
	);
}

/** @deprecated v0.10.5. Use `MMA.edit.work(selector, { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. */
export function removeTagFromLocations(tagId: number, locationIds: number[]) {
	return edit.work(
		{ type: "Locations", locations: locationIds, name: null },
		{ kind: "listSet", key: "tags", add: [], remove: [tagId] },
	);
}

/** @deprecated v0.10.5. Use `MMA.edit.work(MMA.tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] })`. */
export function removeTagFromAllLocations(tagId: number) {
	return edit.work(tagSelector(tagId), { kind: "listSet", key: "tags", add: [], remove: [tagId] });
}

/** @deprecated v0.11.3. Use `MMA.applySelectionUpdate(MMA.addSelection(...selectors))`. */
export function addSelections(selectors: Selector[]) {
	return applySelectionUpdate(addSelection(...selectors));
}

/** @deprecated v0.11.3. Use `MMA.applySelectionUpdate(MMA.removeSelection(...keys))`. */
export function removeSelections(keys: string[]) {
	return applySelectionUpdate(removeSelection(...keys));
}

/** @deprecated v0.11.3. Use `MMA.applySelectionUpdate({ kind: "set", selections: [] })`. */
export function resetSelections() {
	return applySelectionUpdate({ kind: "set", selections: [] });
}
