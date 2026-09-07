// Test-only API, mounted as `MMA._test`. Deterministic wrappers the e2e suite
// drives; never called by app code.

import {
	closeMap as storeCloseMap,
	currentSelection,
	getMapState,
	mutate,
	openMap as storeOpenMap,
	resolveIds,
} from "@/store/useMapStore";
import * as mapList from "@/store/mapList";
import { cmd } from "@/lib/commands";
import { goTo } from "@/store/router";

/** Run a single procedure over a selector. */
export { runProcedure, procedureEntry } from "@/lib/data/procedures";

/** Force a full selection re-resolve and return the selected IDs. */
export async function syncSelections(): Promise<{ ids: number[] }> {
	const { selections, ghostedSelections } = getMapState();
	if (selections.length === 0) return { ids: [] };
	await cmd.storeSyncSelections(
		selections.map((s) => ({
			key: s.key,
			selector: s.selector,
			color: s.color,
			ghosted: ghostedSelections.has(s.key),
		})),
	);
	return { ids: await resolveIds(currentSelection()) };
}

/** Open a map by id and navigate to it. */
export async function openMap(id: string) {
	// Await the real store op for a deterministic completion signal, THEN sync the
	// URL — by which point the router's reconcile is a no-op (state already matches),
	// so no second fire-and-forget openMap can interleave with the next test step.
	await storeOpenMap(id);
	goTo({ type: "editor", mapId: id });
}

/** Close the current map and return to the map list. */
export async function closeMap() {
	await storeCloseMap();
	goTo({ type: "list" });
}

/** Delete a map by id. */
export function deleteMap(id: string) {
	return mapList.deleteMap(id);
}

/** Import locations from pasted text and commit them to the map. */
export async function importPaste(text: string) {
	await cmd.storeImportPastePreview(text);
	const r = await cmd.storeImportFile([], null);
	await mutate(() => Promise.resolve(r));
	return [r];
}

/** Import a previewed file, optionally assigning a tag. */
export async function importFile(droppedFields: string[], tagName?: string) {
	const r = await cmd.storeImportFile(droppedFields, tagName ?? null);
	await mutate(() => Promise.resolve(r));
	return r;
}
