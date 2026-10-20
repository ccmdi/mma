// Test-only API, mounted as `MMA._test`. Deterministic wrappers the e2e suite
// drives; never called by app code.
import { SelectionList } from "@/store/selectionList";
import { Maps } from "@/store/maps";
import { Mutation } from "@/store/mutation";
import { Query } from "@/store/query";
import { cmd } from "@/lib/commands";
import { goTo } from "@/store/router";

export { mapOpen } from "@/lib/util/debug";

/** Force a full selection re-resolve and return the selected IDs. */
export async function syncSelections(): Promise<{ ids: number[] }> {
	const rows = SelectionList.listed();
	if (rows.length === 0) return { ids: [] };
	await Mutation.settle(
		await cmd.storeEditSelections({ kind: "set", selections: rows.map((r) => r.selection) }),
	);
	return { ids: await Query.read({ type: "Selected" }, { kind: "ids" }) };
}

/** Open a map by id and navigate to it. */
export async function openMap(id: string) {
	// Await the real store op for a deterministic completion signal, THEN sync the
	// URL — by which point the router's reconcile is a no-op (state already matches),
	// so no second fire-and-forget openMap can interleave with the next test step.
	await Maps.open(id);
	goTo({ type: "editor", mapId: id });
}

/** Close the current map and return to the map list. */
export async function closeMap() {
	await Maps.close();
	goTo({ type: "list" });
}

/** Delete a map by id. */
export function deleteMap(id: string) {
	return Maps.remove(id);
}

/** Import locations from pasted text and commit them to the map. */
export async function importPaste(text: string) {
	await cmd.storeImportPreview({ text });
	const r = await cmd.storeImportFile([], [], []);
	await Mutation.settle(r.mutation);
	return [r];
}

/** Import a previewed file, optionally assigning tags. */
export async function importFile(droppedFields: string[], tagNames: string[] = []) {
	const r = await cmd.storeImportFile(droppedFields, tagNames, []);
	await Mutation.settle(r.mutation);
	return r;
}
