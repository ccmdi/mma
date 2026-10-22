import { Maps } from "./maps";
import { Store } from "@/store/store";
import { Mutation } from "@/store/mutation";
import type { Selector } from "@/types";
import type { Edits, Target, Work, WorkResult } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

type Of<K extends string> = Extract<Edits, Record<K, unknown>>[K];

const noLocations = () => ({ mutation: Mutation.none(), invalidated: [] });

/** Edit map locations, metadata, value records, and selections. @api */
export const Edit = {
	/** Edit locations on a map or in a pending layer, with the rows themselves or the session
	 *  they were uploaded to (see `storeUploadBegin`). Rows refer to interned values such as tags
	 *  by their ids in `records`, matched to the map's by name. Map changes are undoable in that
	 *  map. @unstable */
	locations: (
		target: Target,
		edits: Of<"locations">["edits"],
		records: Of<"locations">["records"] = {},
	) => Mutation.run(() => cmd.storeEdit({ locations: { target, edits, records } }), noLocations()),
	/** Patch a map's metadata and persist it: the open map's unless the patch names an `id`.
	 *  Settings merge key by key, so send only the keys that change. */
	meta: async (
		patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & { id?: string },
	): Promise<void> => {
		const { mapId } = Store.get();
		const id = patch.id ?? mapId;
		if (!id) return;
		await Mutation.write(() => cmd.storeUpdateMapMeta({ ...patch, id }));
		await Maps.invalidate();
	},
	/** Edit an interned field's value records in one undoable step. */
	values: (field: string, edits: Of<"values">["edits"]) =>
		Mutation.run(() => cmd.storeEdit({ values: { field, edits } })),
	/** Edit the selection list. Wrap an op in `{ kind: "active", op }` to affect only active
	 *  selections. @unstable */
	selections: (op: Of<"selections">) => Mutation.run(() => cmd.storeEdit({ selections: op })),
	/** Run `op` across every location `selector` matches on a map or in a pending layer. Map
	 *  changes are one undoable step. @unstable */
	work: (selector: Selector, op: Work, target: Target = { kind: "map" }): Promise<WorkResult> => {
		return Mutation.run(() => cmd.storeWork(target, selector, op), {
			mutation: Mutation.none(),
			changed: 0,
			failed: [],
		});
	},
};
