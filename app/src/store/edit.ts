import { Maps } from "./maps";
import { Store } from "@/store/store";
import { Mutation } from "@/store/mutation";
import type { Selector } from "@/types";
import type { Work, WorkResult } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

const NO_WORK: WorkResult = { mutation: { version: 0, keys: [] }, changed: 0, failed: [] };

export const Edit = {
	/** Edit locations on the map or in a pending layer. Map changes are undoable. @unstable */
	locations: (...[target, edits, opts]: Parameters<typeof cmd.storeEdit>) => {
		return Mutation.run(() => cmd.storeEdit(target, edits, opts));
	},
	/** Patch a map's metadata and persist it: the open map's unless the patch names an `id`.
	 *  Settings merge key by key, so send only the keys that change. */
	meta: async (
		patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & { id?: string },
	): Promise<void> => {
		const { mapId } = Store.get();
		const id = patch.id ?? mapId;
		if (!id) return;
		const { mutation } = await cmd.storeUpdateMapMeta({ ...patch, id });
		if (mutation.version) await Mutation.settle(mutation);
		await Maps.invalidate();
	},
	/** Edit an interned field's value records in one undoable step. */
	values: (...[field, edits]: Parameters<typeof cmd.storeEditValues>) => {
		return Mutation.run(() => cmd.storeEditValues(field, edits));
	},
	/** Run `op` across every location `selector` matches, in one undoable step. @unstable */
	work: (selector: Selector, op: Work): Promise<WorkResult> => {
		return Mutation.run(() => cmd.storeWork(selector, op), NO_WORK);
	},
};
