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

async function updateSelections(write: () => Promise<MutationResult>) {
	if (!Store.get().map) return;
	await Mutation.run(write);
	await refreshPolygonFills(Store.get().selectionList);
	emitEvent("selection:change", SelectionList.active());
}

export const SelectionList = {
	/** Tag ids with a top-level listed tag selection, including ghosted selections. */
	tagIds: (() => {
		let prev: Set<number> | null = null;
		return memoOnRefs(
			() => [Store.get().selectionList] as const,
			(rows): ReadonlySet<number> => {
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
	})(),
	/** Tag ids from active selection leaves, including repeated ids and composite children. */
	tagIdsDeep: memoOnRefs(
		(): [Selection[]] => [SelectionList.active()],
		(sels): readonly number[] => {
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
	),
	/** Listed selections that are not ghosted. */
	active: memoOnRefs(
		() => [Store.get().selectionList] as const,
		(rows) => rows.filter((r) => !r.ghosted).map((r) => r.selection),
	),
	/** Update and resolve the listed selections. Use `onActive` to affect only active selections. @unstable */
	update: async (op: import("@/bindings.gen").SelectionOp) => {
		await updateSelections(() => cmd.storeEditSelections(op));
	},
	/** Undo the last selection change without undoing data edits. @unstable */
	undo: async () => {
		await updateSelections(() => cmd.storeStep("undo", "selections"));
	},
	/** Redo the last undone selection change without redoing data edits. @unstable */
	redo: async () => {
		await updateSelections(() => cmd.storeStep("redo", "selections"));
	},
	select: async <R extends number[] | { ids: number[] }>(
		pick: (selector: Selector) => Promise<R>,
		perSelection = false,
	): Promise<{ picked: number; results: R[] }> => {
		const active = SelectionList.active();
		const buckets: Selector[] =
			perSelection && active.length >= 2 ? active.map((s) => s.selector) : [{ type: "Selected" }];
		const results = await Promise.all(buckets.map(pick));
		const ids = [...new Set(results.flatMap((r) => (Array.isArray(r) ? r : r.ids)))];
		if (ids.length)
			await SelectionList.update(
				onActive(setSelections([selection({ type: "Manual", locations: ids })])),
			);
		return { picked: ids.length, results };
	},
};
