import { Store } from "./store";
import { Mutation } from "./mutation";
import { memoOnRefs } from "@/lib/util/memoOnRefs";
import type { Selection } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { refreshPolygonFills } from "@/lib/render/polygonFills";
import { emit as emitEvent } from "@/lib/events";
import { selection, onActive, setSelections } from "./selections";
import type { Selector } from "@/types";
import type { MutationResult } from "@/bindings.gen";
import { tagIdOf } from "@/store/selections";

/** Tag ids that have a top-level Tag selection listed, ghosted or not. */
const getSelectedTagIds: () => ReadonlySet<number> = (() => {
	let prev: Set<number> | null = null;
	return memoOnRefs(
		() => [Store.get().selectionList] as const,
		(rows) => {
			const ids = new Set(
				rows.flatMap((r) => {
					const id = tagIdOf(r.selection.selector);
					return id == null ? [] : [id];
				}),
			);
			if (prev && prev.symmetricDifference(ids).size === 0) return prev;
			prev = ids;
			return ids;
		},
	);
})();

/** Tag ids of every Tag leaf in the active selection tree, in list order.
 *  Includes composite children, excludes ghosted selections; ids may repeat. */
const getSelectedTagIdsDeep: () => readonly number[] = memoOnRefs(
	() => [getActiveSelections()] as const,
	(sels) => {
		const out: number[] = [];
		const walk = (list: Selection[]) => {
			for (const s of list) {
				const id = tagIdOf(s.selector);
				if (id != null) out.push(id);
				if ("selections" in s.selector) walk(s.selector.selections);
			}
		};
		walk(sels);
		return out;
	},
);

/** The selection: every listed selection that is not ghosted. */
const getActiveSelections: () => Selection[] = memoOnRefs(
	() => [Store.get().selectionList] as const,
	(rows) => rows.filter((r) => !r.ghosted).map((r) => r.selection),
);

/** Update and resolve the listed selections. Use `onActive` to affect only active selections. @unstable */
async function applySelectionUpdate(op: import("@/bindings.gen").SelectionOp) {
	await updateSelections(() => cmd.storeEditSelections(op));
}

/** Undo the last selection change without undoing data edits. @unstable */
async function restoreSelections() {
	await updateSelections(() => cmd.storeStep("undo", "selections"));
}

/** Redo the last undone selection change without redoing data edits. @unstable */
async function redoSelections() {
	await updateSelections(() => cmd.storeStep("redo", "selections"));
}

async function updateSelections(write: () => Promise<MutationResult>) {
	if (!Store.get().map) return;
	await Mutation.run(write);
	await refreshPolygonFills(Store.get().selectionList);
	emitEvent("selection:change", getActiveSelections());
}

async function select<R extends number[] | { ids: number[] }>(
	pick: (selector: Selector) => Promise<R>,
	perSelection = false,
): Promise<{ picked: number; results: R[] }> {
	const active = getActiveSelections();
	const buckets: Selector[] =
		perSelection && active.length >= 2 ? active.map((s) => s.selector) : [{ type: "Selected" }];
	const results = await Promise.all(buckets.map(pick));
	const ids = [...new Set(results.flatMap((r) => (Array.isArray(r) ? r : r.ids)))];
	if (ids.length)
		await applySelectionUpdate(
			onActive(setSelections([selection({ type: "Manual", locations: ids })])),
		);
	return { picked: ids.length, results };
}

export const SelectionList = {
	/** Tag ids with a top-level listed tag selection, including ghosted selections. */
	tagIds: getSelectedTagIds,
	/** Tag ids from active selection leaves, including repeated ids and composite children. */
	tagIdsDeep: getSelectedTagIdsDeep,
	/** Listed selections that are not ghosted. */
	active: getActiveSelections,
	update: applySelectionUpdate,
	undo: restoreSelections,
	redo: redoSelections,
	select,
};
