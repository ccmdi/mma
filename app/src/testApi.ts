import { SelectionList } from "@/store/selectionList";
import { Maps } from "@/store/maps";
import { Mutation } from "@/store/mutation";
import { Query } from "@/store/query";
import { cmd } from "@/lib/commands";
import { goTo } from "@/store/router";
import { Edit } from "@/store/edit";
import { mapOpen } from "@/lib/util/debug";

/** Deterministic wrappers the e2e suite drives, mounted as `MMA._test`. App code never calls them. @api @unstable */
export const _test = {
	mapOpen,

	/** Force a full selection re-resolve and return the selected IDs. */
	syncSelections: async (): Promise<{ ids: number[] }> => {
		const rows = SelectionList.listed();
		if (rows.length === 0) return { ids: [] };
		await Edit.selections({ kind: "set", selections: rows.map((r) => r.selection) });
		return { ids: await Query.read({ type: "Selected" }, { kind: "ids" }) };
	},

	/** Open a map by id and navigate to it. */
	openMap: async (id: string) => {
		// Await the real store op for a deterministic completion signal, THEN sync the
		// URL — by which point the router's reconcile is a no-op (state already matches),
		// so no second fire-and-forget openMap can interleave with the next test step.
		await Maps.open(id);
		goTo({ type: "editor", mapId: id });
	},

	/** Close the current map and return to the map list. */
	closeMap: async () => {
		await Maps.close();
		goTo({ type: "list" });
	},

	/** Delete a map by id. */
	deleteMap: (id: string) => Maps.remove(id),

	/** Import locations from pasted text and commit them to the map. */
	importPaste: async (text: string) => {
		await cmd.storeImportPreview({ text });
		const r = await cmd.storeImportFile([], [], []);
		await Mutation.settle(r.mutation);
		return [r];
	},

	/** Import a previewed file, optionally assigning tags. */
	importFile: async (droppedFields: string[], tagNames: string[] = []) => {
		const r = await cmd.storeImportFile(droppedFields, tagNames, []);
		await Mutation.settle(r.mutation);
		return r;
	},
};
