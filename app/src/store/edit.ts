import type { Selector } from "@/types";
import type { MutationResult, Work, WorkResult } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { getMapState, mutate } from "./useMapStore";
import { invalidateMapList } from "./mapList";
import * as autosave from "./autosave";

const NO_WORK: WorkResult = { mutation: { version: 0, keys: [] }, changed: 0, failed: [] };

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

/** Edit an interned field's value records in one undoable step. */
export function values(
	...[field, edits]: Parameters<typeof cmd.storeEditValues>
): Promise<MutationResult> {
	return mutate(() => cmd.storeEditValues(field, edits));
}

/** Run `op` across every location `selector` matches, in one undoable step. @unstable */
export function work(selector: Selector, op: Work): Promise<WorkResult> {
	return mutate(() => cmd.storeWork(selector, op), NO_WORK);
}
