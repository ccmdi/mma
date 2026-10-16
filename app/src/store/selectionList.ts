import { Store } from "./store";
import { Mutation } from "./mutation";
import { memoOnRefs } from "@/lib/util/memoOnRefs";
import type { ListedSelection, Selection } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { emit as emitEvent } from "@/lib/events";
import { selection } from "./selections";
import type { Selector } from "@/types";
import { tagIdOf } from "@/store/selections";

export const SelectionList = {
	/** The listed selections, in list order. */
	listed: memoOnRefs(
		() => [Store.get().selectionRows, Store.get().selectionOrder] as const,
		(rows, order): ListedSelection[] =>
			order.map((key) => {
				const row = rows[key];
				if (!row) throw new Error(`the selection order names ${key}, which no row holds`);
				return row;
			}),
	),
	/** Tag ids with a top-level listed tag selection, including ghosted selections. */
	tagIds: (() => {
		let prev: Set<number> | null = null;
		return memoOnRefs(
			(): [ListedSelection[]] => [SelectionList.listed()],
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
		(): [ListedSelection[]] => [SelectionList.listed()],
		(rows) => rows.filter((r) => !r.ghosted).map((r) => r.selection),
	),
	/** Update and resolve the listed selections. Wrap an op in `{ kind: "active", op }` to affect only active selections. @unstable */
	update: async (op: import("@/bindings.gen").SelectionOp) => {
		await SelectionList.run(() => cmd.storeEditSelections(op));
	},
	/** Run a mutation that may change the listed selections, and announce the change when it
	 *  does. @unstable */
	run: async (write: () => Promise<Mutation>) => {
		if (!Store.get().map) return;
		const before = SelectionList.listed();
		await Mutation.run(write);
		if (SelectionList.listed() === before) return;
		emitEvent("selection:change", SelectionList.active());
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
			await SelectionList.update({
				kind: "active",
				op: { kind: "set", selections: [selection({ type: "Manual", locations: ids })] },
			});
		return { picked: ids.length, results };
	},
};
