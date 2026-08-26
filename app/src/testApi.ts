// Test-only API, mounted as `MMA._test`. Deterministic wrappers the e2e suite
// drives; never called by app code.

import {
	openMap as storeOpenMap,
	closeMap as storeCloseMap,
	mutate,
	getMapState,
	scopeIds,
} from "@/store/useMapStore";
import * as mapList from "@/store/mapList";
import { cmd } from "@/lib/commands";
import { goTo } from "@/store/router";

/** Forces a full selection re-resolve in Rust and returns the raw selected IDs.
 *  App code reads `getMapState().selectedLocationIds` — mutations already sync
 *  selections via MutationResult. */
export async function syncSelections(): Promise<{ ids: number[] }> {
	const { selections, ghostedSelections } = getMapState();
	if (selections.length === 0) return { ids: [] };
	await cmd.storeSyncSelections(
		selections.map((s) => ({
			key: s.key,
			props: s.props,
			color: s.color,
			ghosted: ghostedSelections.has(s.key),
		})),
	);
	return { ids: await scopeIds({ kind: "selected" }) };
}

export async function openMap(id: string) {
	// Await the real store op for a deterministic completion signal, THEN sync the
	// URL — by which point the router's reconcile is a no-op (state already matches),
	// so no second fire-and-forget openMap can interleave with the next test step.
	await storeOpenMap(id);
	goTo({ type: "editor", mapId: id });
}

export async function closeMap() {
	await storeCloseMap();
	goTo({ type: "list" });
}

export function deleteMap(id: string) {
	return mapList.deleteMap(id);
}

export async function importPaste(text: string) {
	await cmd.storeImportPastePreview(text);
	const r = await cmd.storeImportFile([], null);
	await mutate(() => Promise.resolve(r));
	return [r];
}

export async function importFile(droppedFields: string[], tagName?: string) {
	const r = await cmd.storeImportFile(droppedFields, tagName ?? null);
	await mutate(() => Promise.resolve(r));
	return r;
}
