import { memoOnRefs } from "@/lib/util/memoOnRefs";
import type { Selection, Selector } from "@/bindings.gen";
import { applySelectionUpdate, getActiveSelections, getMapState } from "@/store/useMapStore";
import {
	addSelection,
	buildSelection,
	removeSelection,
	replaceSelection,
	tagIdOf,
	tagSelector,
	type SelectionPatch,
} from "@/store/selections";

/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
export function updateFilterSelection(oldKey: string, selector: Selector) {
	return applySelectionUpdate((sels, ghosted): SelectionPatch => {
		const next = replaceSelection(sels, oldKey, selector);
		if (next.length !== sels.length) return { selections: next };
		let migrated: Set<string> | null = null;
		for (let i = 0; i < sels.length; i++) {
			if (next[i].key !== sels[i].key && ghosted.has(sels[i].key)) {
				migrated ??= new Set(ghosted);
				migrated.delete(sels[i].key);
				migrated.add(next[i].key);
			}
		}
		return migrated ? { selections: next, ghosted: migrated } : { selections: next };
	});
}

/** Toggle tag selections on or off for the given tags. */
export function toggleTagSelections(tagIds: number[]) {
	if (!getMapState().map || tagIds.length === 0) return;
	void applySelectionUpdate((sels) =>
		tagIds.reduce((result, tagId) => {
			const key = buildSelection(tagSelector(tagId)).key;
			return result.some((s) => s.key === key)
				? removeSelection(key)(result)
				: addSelection(tagSelector(tagId))(result);
		}, sels),
	);
}

/** Tag ids that currently have a top-level Tag selection active. */
export const getSelectedTagIds: () => ReadonlySet<number> = (() => {
	let prev: Set<number> | null = null;
	return memoOnRefs(
		() => [getMapState().selections] as const,
		(sels) => {
			const ids = new Set(
				sels.flatMap((s) => {
					const id = tagIdOf(s.selector);
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
export const getSelectedTagIdsDeep: () => readonly number[] = memoOnRefs(
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
