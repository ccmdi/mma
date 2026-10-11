import { Store } from "./store";
import { Edit } from "./edit";
import type { HeldValue } from "@/bindings.gen";
import { memoOnRefs } from "@/lib/util/memoOnRefs";
import { colorForName } from "@/lib/util/color";
import { selection, tagSelector } from "./selections";

export type Tag = import("@/types").Tag;

const NO_VALUES: Record<string, HeldValue | null> = {};

/** Per-tag location counts, keyed by numeric id. */
const counts: () => Record<number, number> = memoOnRefs(
	() => [Store.get().fieldValues["tags"] ?? NO_VALUES] as const,
	(values) =>
		Object.fromEntries(Object.entries(values).map(([k, v]) => [Number(k), v?.count ?? 0])),
);

/** Tag records with visibility based on location references.
 * Missing metadata uses a generated name and colour. */
const all: () => Record<number, Tag> = memoOnRefs(
	() => [Store.get().fieldValues["tags"] ?? NO_VALUES] as const,
	(values) => {
		const out: Record<number, Tag> = {};
		for (const [k, v] of Object.entries(values)) {
			if (!v) continue;
			const id = Number(k);
			const rec = v.record ?? {};
			const name = typeof rec.name === "string" && rec.name ? rec.name : `Tag ${id}`;
			out[id] = {
				id,
				name,
				color: typeof rec.color === "string" ? rec.color : colorForName(name),
				visible: v.count > 0,
				order: typeof rec.order === "number" ? rec.order : null,
				doclinks: Array.isArray(rec.doclinks) ? (rec.doclinks as string[]) : [],
			};
		}
		return out;
	},
);

/** Tags that exist from the user's point of view: the ones something carries. Raw
 *  `tags` also holds dark metadata ghosts (count=0, visible=false) - almost nothing
 *  should enumerate those. */
const visible: () => Tag[] = memoOnRefs(
	() => [all()] as const,
	(tags) => Object.values(tags).filter((t) => t.visible !== false),
);

/** Look up a tag record, including unreferenced tags. */
function get(id: number): Tag | undefined {
	return all()[id];
}

/** Tag names for the given ids, skipping any that no longer resolve. */
function names(ids: number[]): string[] {
	return ids.map((id) => all()[id]?.name).filter((n): n is string => n != null);
}

/** Remove tags from every location in one undoable step.
 * Unreferenced tags are hidden; undo restores them. */
function remove(tagIds: number[]) {
	return Edit.work(
		{ type: "Union", selections: tagIds.map((id) => selection(tagSelector(id))) },
		{ kind: "listSet", key: "tags", add: [], remove: tagIds },
	);
}

export const Tag = {
	/** Per-tag location counts, keyed by numeric id. */
	counts,
	/** Tag records, including unreferenced records and generated display defaults. */
	all,
	/** Tag records referenced by at least one location. */
	visible,
	get,
	names,
	remove,
};
