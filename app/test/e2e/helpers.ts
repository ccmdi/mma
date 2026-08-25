/**
 * Shared helpers for E2E tests.
 * All browser calls go through withApi, which injects the MMA API as `api`.
 */

import { cmd } from "@/lib/commands";
import type { MMA } from "@/api";
import { createLocation } from "../../src/types";
import type { Location, Selector, ExtraFieldDef } from "@/bindings.gen";

/**
 * Run an async function in the browser with the MMA API injected as `api`.
 * The result type is inferred from whatever the callback returns.
 *
 * Usage: `await withApi(async (api, id) => api.fetchLocation(id), locId);`
 */
export async function withApi<A extends unknown[], R>(
	fn: (api: MMA, ...args: A) => R,
	...args: A
): Promise<Awaited<R>> {
	const wrapped = new Function(
		"...___a",
		`const ___d = ___a.pop();
     const api = window.MMA;
     (async () => { try { ___d(await (${fn.toString()})(api, ...___a)); } catch(e) { ___d({ __withApiError: (e && e.message) || String(e) }); } })();`,
	);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callback is serialized and re-evaluated in the browser; this bridge can't be statically typed
	const result = (await browser.executeAsync(wrapped as any, ...args)) as unknown;
	if (result !== null && typeof result === "object" && "__withApiError" in result) {
		throw new Error(String((result as { __withApiError: unknown }).__withApiError));
	}
	return result as Awaited<R>;
}

export async function waitForReady() {
	await browser.waitUntil(async () => browser.execute(() => window.MMA?.ready === true), {
		timeout: 30000,
		timeoutMsg: "App did not boot in time",
	});
}

/**
 * Clear a controlled (React) input reliably. WebdriverIO's clearValue() only mutates the
 * DOM value without firing input/change events, so a React-controlled field (e.g. a tag
 * filter or map search) keeps its old state and stays applied. Select-all + Backspace sends
 * real keystrokes that fire onChange — what a user actually does to empty a field.
 */
export async function clearInput(selector: string) {
	const el = await browser.$(selector);
	await el.click();
	await browser.keys(["Control", "a"]);
	await browser.keys("Backspace");
}

export async function createAndOpenMap(name: string): Promise<string> {
	const id = await withApi(async (api, n) => {
		const map = await api.cmd.storeCreateMap(n, null);
		await api._test.openMap(map.meta.id);
		return map.meta.id;
	}, name);
	// The editor mounts asynchronously after open and runs init effects (render fill,
	// plugin activation). Seeding/selecting before that settles is racy, so gate here
	// centrally: wait for the editor DOM, then a short settle for its post-mount effects.
	// (helpers.ts is exempt from the no-fixed-sleep rule; this is the one sanctioned spot.)
	await browser
		.$(".page-map-editor")
		.waitForExist({ timeout: 10000, timeoutMsg: "map editor never mounted after open" });
	await browser.pause(300);
	return id;
}

/**
 * Mocha fixture for the standard describe lifecycle: boot, create + open a map before the
 * block, close + delete it after. Returns a ref whose `id` is filled in by the before hook.
 *
 * Usage: `const map = useMap("E2E Tags");` then `map.id` inside tests.
 * Pass `{ closeLocation: true }` when the block leaves a location open.
 */
export function useMap(name: string, opts: { closeLocation?: boolean } = {}) {
	const ref = { id: "" };
	before(async () => {
		await waitForReady();
		ref.id = await createAndOpenMap(name);
	});
	after(async () => {
		if (opts.closeLocation) await closeLocation();
		await closeMap();
		await deleteMap(ref.id);
	});
	return ref;
}

export async function openMap(id: string) {
	await withApi(async (api, mapId) => api._test.openMap(mapId), id);
}

export async function closeMap() {
	const err = await withApi(async (api) => {
		try {
			await api._test.closeMap();
			return null;
		} catch (e) {
			return (e && (e as Error).message) || String(e);
		}
	});
	// Surface instead of swallowing: a failed close means state silently not persisted,
	// which corrupts every downstream close/reopen assertion in undiagnosable ways.
	if (err != null) throw new Error(`closeMap failed: ${err}`);
}

export async function deleteMap(id: string) {
	await withApi(async (api, mapId) => {
		try {
			await api.cmd.storeDeleteMap(mapId);
		} catch {
			// best-effort cleanup: map may already be deleted/closed
		}
	}, id);
}

export async function flushAndWait() {
	await withApi(async (api) => api.flushSave());
}

/** Open a location in the editor via the test API. */
export async function openLocation(id: number) {
	await withApi(async (api, locId) => {
		await api.setActiveLocation(locId, false);
	}, id);
}

/** Close the active location (return to overview) via the test API. */
export async function closeLocation() {
	await withApi(async (api) => {
		await api.setActiveLocation(null);
	});
}

// --- Location helpers ---

export { createLocation };

export function randomLatLng(): { lat: number; lng: number } {
	return { lat: Math.random() * 180 - 90, lng: Math.random() * 360 - 180 };
}

export function randomHeading(): { heading: number } {
	return { heading: Math.random() * 360 };
}

export async function addLocs(locs: Location[]): Promise<number[]> {
	return withApi(async (api, locations) => {
		await api.addLocations(locations);
		return locations.map((l) => l.id);
	}, locs);
}

type LocSpec = Partial<Location> & { lat: number; lng: number };

/** Build `n` locations, `fn(i)` supplying each one's fields. */
export function makeLocs(n: number, fn: (i: number) => LocSpec): Location[] {
	return Array.from({ length: n }, (_, i) => createLocation(fn(i)));
}

/** Build `n` locations via `fn(i)` and add them in one batch. Returns the assigned ids. */
export async function seedLocs(n: number, fn: (i: number) => LocSpec): Promise<number[]> {
	return addLocs(makeLocs(n, fn));
}

export async function getLoc(id: number): Promise<Location> {
	const loc = await withApi(async (api, locId) => api.fetchLocation(locId), id);
	if (loc == null) throw new Error(`Location ${id} not found`);
	return loc;
}

/** Like getLoc but returns null instead of throwing — for asserting a location was removed. */
export async function getLocOrNull(id: number): Promise<Location | null> {
	return withApi(async (api, locId) => api.fetchLocation(locId), id);
}

export async function getAllLocs(): Promise<Location[]> {
	return withApi(async (api) => api.fetchAllLocations());
}

export async function getLocCount(): Promise<number> {
	return withApi(async (api) => (await api.cmd.storeGetSummary()).locationCount);
}

/** Add selections to the live map. */
export async function select(...selector: Selector[]) {
	await withApi(async (api, p) => api.addSelections(p), selector);
}

/** Add selections and return how many locations they resolve to. */
export async function selectCount(...selector: Selector[]): Promise<number> {
	return withApi(async (api, p) => {
		await api.addSelections(p);
		return api.getMapState().selectedLocationIds.size;
	}, selector);
}

export async function refreshSelections(): Promise<number[]> {
	return withApi(async (api) => {
		const sels = api
			.getActiveSelections()
			.map((s) => ({ key: s.key, selector: s.selector, color: s.color }));
		if (sels.length === 0) return [] as number[];
		await api.cmd.storeSyncSelections(sels);
		return api.resolveIds(api.currentSelection());
	});
}

export async function createTag(
	name: string,
): Promise<{ id: number; name: string; color: string }> {
	return withApi(async (api, n) => (await api.createTags([n]))[0], name);
}

// --- Deterministic waits (replace fixed browser.pause sleeps) ---
// Each polls the real post-condition via the MMA API or DOM, so it finishes as soon as
// the condition holds and fails loud (not silently) if it never does.

const WAIT = { timeout: 5000, interval: 50 } as const;

/** Wait until the active location id equals `id` (null = back to overview). */
export async function waitForActive(id: number | null) {
	await browser.waitUntil(
		() => withApi((api, target) => (api.getMapState().activeLocation?.id ?? null) === target, id),
		{ ...WAIT, timeoutMsg: `active location never became ${id}` },
	);
}

/** Wait until the store's work area matches (e.g. "overview" | "location"). */
export async function updateMapSettings(patch: Record<string, unknown>) {
	await withApi(async (api, p) => {
		const map = api.getMapState().map!;
		await api.updateMapMeta({ settings: { ...map.meta.settings, ...p } });
		return "ok";
	}, patch);
}

export async function registerFields(defs: Record<string, ExtraFieldDef>) {
	await withApi(async (api, d) => {
		const map = api.getMapState().map!;
		const cur = map.meta.extra?.fields ?? {};
		await api.updateMapMeta({
			extra: { ...map.meta.extra, fields: { ...cur, ...d } },
		});
		return "ok";
	}, defs);
}

/** Wait for the date count badge to show a positive number;
 *  the default is deliberately far above the shared WAIT timeout. */
export async function waitForDates(timeout = 30_000) {
	await browser.waitUntil(
		async () => {
			const badge = await browser.$(".location-preview__date .badge--number");
			if (!(await badge.isExisting())) return false;
			return parseInt(await badge.getText()) > 0;
		},
		{ timeout, timeoutMsg: "Date picker never populated with dates" },
	);
}

export async function waitForPreview() {
	const el = await browser.$(".location-preview");
	await el.waitForExist({ timeout: 5000 });
}

export async function waitForWorkArea(area: string) {
	await browser.waitUntil(() => withApi((api, a) => api.getMapState().workArea === a, area), {
		...WAIT,
		timeoutMsg: `workArea never became ${area}`,
	});
}

/** Wait until the live location count equals `n`. */
export async function waitForLocCount(n: number) {
	await browser.waitUntil(async () => (await getLocCount()) === n, {
		...WAIT,
		timeoutMsg: `location count never reached ${n}`,
	});
}

/** Wait until location `id` exists (post-save), optionally satisfying `predicate`. */
export async function waitForSave(id: number, predicate?: (l: Location) => boolean) {
	await browser.waitUntil(
		async () => {
			const l = await getLocOrNull(id);
			return l != null && (predicate ? predicate(l) : true);
		},
		{ ...WAIT, timeoutMsg: `location ${id} never satisfied the save predicate` },
	);
}

/** Wait until location `id` has (or lacks) a flag bit. */
export async function waitForFlag(id: number, flag: number, set = true) {
	await waitForSave(id, (l) => ((l.flags & flag) !== 0) === set);
}

/** Wait until at least `min` elements match `selector` (dropdowns, lists, dialogs). */
export async function waitForOptions(selector: string, min = 1) {
	await browser.waitUntil(async () => (await (await browser.$$(selector)).length) >= min, {
		...WAIT,
		timeoutMsg: `selector ${selector} never had >= ${min} elements`,
	});
}
