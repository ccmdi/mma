import type { Selector } from "@/types";
import type { FieldValuesPatch, Work, WorkResult } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { getMapState, mutate } from "./useMapStore";
import { invalidateMapList } from "./mapList";
import * as autosave from "./autosave";

const NO_WORK: WorkResult = { mutation: { version: 0, added: [] }, changed: 0, failed: [] };

/** Apply edits to the map or a pending layer. Map changes are undoable. @unstable */
export function rows(...[target, edits, opts]: Parameters<typeof cmd.storeEdit>) {
	return mutate(() => cmd.storeEdit(target, edits, opts));
}

/** Patch a map's metadata and persist it: the open map's unless the patch names an `id`. */
export async function meta(
	patch: Omit<Parameters<typeof cmd.storeUpdateMapMeta>[0], "id"> & { id?: string },
): Promise<void> {
	const { mapId } = getMapState();
	const id = patch.id ?? mapId;
	if (!id) return;
	await cmd.storeUpdateMapMeta({ ...patch, id });
	autosave.schedule();
	await invalidateMapList();
}

/** Create, patch, or reorder value records in one undoable step.
 * Returns resolved ids for `create`, in request order. */
export async function values(field: string, patch: FieldValuesPatch): Promise<number[]> {
	if (!patch.create?.length && !patch.update?.length && !patch.reorder) return [];
	let ids: number[] = [];
	await mutate(async () => {
		const r = await cmd.storePatchFieldValues(field, patch);
		ids = r.resolved;
		return { mutation: r.mutation };
	});
	return ids;
}

/** Run `op` across every location `selector` matches, in one undoable step. @unstable */
export function work(selector: Selector, op: Work): Promise<WorkResult> {
	return mutate(() => cmd.storeWork(selector, op), NO_WORK);
}
