// Legacy API shims for plugins. Every export is deprecated: kept only so
// plugins built against an older MMA keep working. New code must not call these.

import { getMapHost, waitForMapHost } from "@/lib/map/mapState";
import { hostInstance } from "@/lib/map/host";
import {
	getMapState,
	getActiveSelections,
	fetchLocations,
	currentSelection,
} from "@/store/useMapStore";
import { useSelectorPick, createSelectorPick } from "@/store/selectorPick";
import { savedSelector } from "@/store/savedSelections";
import type { ReadonlyIdSet } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import type { Location, Selector } from "@/bindings.gen";

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

/** @deprecated v0.8.2. Read `MMA.getMapState().activeLocation`. */
export function getActiveLocation() {
	return getMapState().activeLocation;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().selectedLocationIds`. */
export function getSelectedLocationIds() {
	return getMapState().selectedLocationIds;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().workArea`. */
export function getWorkArea() {
	return getMapState().workArea;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().tagCounts`. */
export function getTagCounts() {
	return getMapState().tagCounts;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().knownFieldKeys`. */
export function getKnownFieldKeys() {
	return getMapState().knownFieldKeys;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().selections`. */
export function getAllSelections() {
	return getMapState().selections;
}

/** @deprecated v0.8.2. Read `MMA.getMapState().ghostedSelections`. */
export function getGhostedSelections() {
	return getMapState().ghostedSelections;
}

/** @deprecated v0.8.2. Use `MMA.getActiveSelections()`. */
export function getSelections() {
	return getActiveSelections();
}

/** @deprecated v0.8.2. Read `(await MMA.cmd.storeGetSummary()).dirtyCount`. */
export async function getDirtyCount(): Promise<number> {
	return (await cmd.storeGetSummary()).dirtyCount;
}

/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Locations", locations: [id], name: null })`. */
export async function fetchLocation(id: number) {
	return (await fetchLocations({ type: "Locations", locations: [id], name: null }))[0] ?? null;
}

/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Locations", locations: ids, name: null })`. */
export function fetchLocationsByIds(ids: number[]) {
	return fetchLocations({ type: "Locations", locations: ids, name: null });
}

/** @deprecated v0.8.4. Use `MMA.fetchLocations({ type: "Everything" })`. */
export function fetchAllLocations() {
	return fetchLocations({ type: "Everything" });
}

/** Argument shape the bulk enrichment entry points still tolerate: plugins built against
 *  an older MMA hand them location rows. `asSelector` is the only place either shape is
 *  accepted -- the app's own code, and everything below the API surface, passes a Selector.
 *  @deprecated v0.9.2. Pass a Selector. */
export type SelectorOrLocations = Selector | Location[];

/** @deprecated v0.9.2. Pass a Selector to `MMA.enrichAll`/`MMA.bulkPinToPano` instead. */
export function asSelector(target: SelectorOrLocations): Selector {
	return Array.isArray(target)
		? { type: "Locations", locations: target.map((l) => l.id), name: null }
		: target;
}

/** The old parallel "which locations" enum, replaced by `Selector` -- the same idea
 *  without a second language for it. `saved` resolved in JS and has no `Selector` form
 *  here; use `MMA.savedSelector(id)`.
 *  @deprecated v0.9.3. Pass a `Selector`. */
export type Scope =
	| { kind: "all" }
	| { kind: "selected" }
	| { kind: "ids"; ids: number[] }
	| { kind: "props"; props: Selector };

/** @deprecated v0.9.3. Pass a `Selector`. */
export type ScopeWithSaved = Scope | { kind: "saved"; id: string };

/** @deprecated v0.9.3. Use `MMA.selectorForPick`, or build the `Selector` directly. */
export function scopeToSelector(scope: ScopeWithSaved | Selector): Selector {
	if (!("kind" in scope)) return scope;
	switch (scope.kind) {
		case "all":
			return { type: "Everything" };
		case "selected":
			return currentSelection();
		case "ids":
			return { type: "Locations", locations: scope.ids, name: null };
		case "props":
			return scope.props;
		case "saved":
			return savedSelector(scope.id);
	}
}

/** @deprecated v0.9.3. Use `MMA.scopeToSelector`. */
export const scopeToProps = scopeToSelector;

/** @deprecated v0.9.3. Use `MMA.resolveIds`. */
export function scopeIds(scope: ScopeWithSaved | Selector) {
	return cmd.storeResolve(scopeToSelector(scope));
}

/** @deprecated v0.9.3. Use `MMA.countLocations`. */
export function scopeCount(scope: ScopeWithSaved | Selector) {
	return cmd.storeCount(scopeToSelector(scope));
}

/** @deprecated v0.9.3. Use `MMA.sampleFrom`. */
export function sampleScope(scope: ScopeWithSaved | Selector, n: number) {
	return cmd.storeSample(scopeToSelector(scope), n);
}

/** @deprecated v0.9.3. Use `MMA.resolveIds` (it returns every id, never null). */
export async function resolveScopeIds(
	scope: ScopeWithSaved | Selector,
): Promise<ReadonlyIdSet | null> {
	if ("kind" in scope && scope.kind === "all") return null;
	if ("kind" in scope && scope.kind === "selected") return getMapState().selectedLocationIds;
	return new Set(await cmd.storeResolve(scopeToSelector(scope)));
}

/** @deprecated v0.9.3. Narrow with a `Selector` and let Rust resolve it. */
export function applyScope(scope: ScopeWithSaved | Selector, pool: Location[]): Location[] {
	const sel = scopeToSelector(scope);
	if (sel.type === "Everything") return pool;
	if (sel.type !== "Locations" && sel.type !== "Manual")
		throw new Error(`applyScope: ${sel.type} resolves in Rust (use MMA.resolveIds)`);
	const ids = new Set(sel.locations);
	return pool.filter((item) => ids.has(item.id));
}

/** @deprecated v0.9.3. Use `MMA.useSelectorPick`. */
export const useScope = useSelectorPick;

/** @deprecated v0.9.3. Use `MMA.createSelectorPick`. */
export const createScope = createSelectorPick;
