import { Maps } from "./maps";
import { Store } from "@/store/store";
import { Mutation } from "@/store/mutation";
import type { Selector } from "@/types";
import type { Target, Work, WorkResult } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

export const Edit = {
	/** Edit locations on a map or in a pending layer. Rows refer to interned values such as tags
	 *  by their ids in `records`, matched to the map's by name. Map changes are undoable in that
	 *  map. @unstable */
	locations: (
		target: Target,
		edits: Parameters<typeof cmd.storeEdit>[1],
		records: Parameters<typeof cmd.storeEdit>[2] = {},
	) => {
		return Mutation.run(() => cmd.storeEdit(target, edits, records));
	},
	/** Patch a map's metadata and persist it: the open map's unless the patch names an `id`.
	 *  Settings merge key by key, so send only the keys that change. */
	meta: async (
		patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & { id?: string },
	): Promise<void> => {
		const { mapId } = Store.get();
		const id = patch.id ?? mapId;
		if (!id) return;
		const result = await cmd.storeUpdateMapMeta({ ...patch, id });
		if (result) await Mutation.settle(result.mutation);
		await Maps.invalidate();
	},
	/** Edit an interned field's value records in one undoable step. */
	values: (...[field, edits]: Parameters<typeof cmd.storeEditValues>) => {
		return Mutation.run(() => cmd.storeEditValues(field, edits));
	},
	/** Run `op` across every location `selector` matches, in one undoable step. @unstable */
	work: (selector: Selector, op: Work): Promise<WorkResult> => {
		return Mutation.run(() => cmd.storeWork(selector, op), {
			...Mutation.none(),
			changed: 0,
			failed: [],
		});
	},
};
