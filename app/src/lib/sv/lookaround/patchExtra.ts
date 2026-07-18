import type { Location } from "@/bindings.gen";
import { updateLocations } from "@/store/useMapStore";

/** Shallow-merge keys into location.extra (null values delete keys). */
export async function patchLocationExtra(
	loc: Location,
	patch: Record<string, unknown>,
): Promise<void> {
	if (!Object.keys(patch).length) return;
	await updateLocations([{ id: loc.id, patch: { extra: patch } }], { undoable: false });
}
