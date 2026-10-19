import type { Patch, Selector } from "@/types";
import { Store } from "./store";
import { Edit } from "./edit";
import type { HeldValue } from "@/bindings.gen";
import { memoOnRefs } from "@/lib/util/memoOnRefs";
import { colorForName } from "@/lib/util/color";
import { selection, tagSelector, any, all as and } from "./selections";

export type Tag = import("@/types").Tag;
type TagCreate = Pick<Tag, "name"> & Partial<Omit<Tag, "id" | "name" | "visible">>;

const NO_VALUES: Record<string, HeldValue | null> = {};

export const Tag = {
	/** Per-tag location counts, keyed by numeric id. */
	counts: memoOnRefs(
		() => [Store.get().fieldValues["tags"] ?? NO_VALUES] as const,
		(values): Record<number, number> =>
			Object.fromEntries(Object.entries(values).map(([k, v]) => [Number(k), v?.count ?? 0])),
	),
	/** Tag records, including unreferenced records. */
	all: memoOnRefs(
		() => [Store.get().fieldValues["tags"] ?? NO_VALUES] as const,
		(values): Record<number, Tag> => {
			const out: Record<number, Tag> = {};
			for (const [k, v] of Object.entries(values)) {
				const rec = v?.record;
				const name = rec?.name;
				if (!v || !rec || typeof name !== "string" || !name) continue;
				const id = Number(k);
				out[id] = {
					id,
					name,
					color: typeof rec.color === "string" ? rec.color : colorForName(name),
					visible: v.count > 0,
					order: typeof rec.order === "number" ? rec.order : null,
					doclinks: Array.isArray(rec.doclinks)
						? rec.doclinks.filter((link): link is string => typeof link === "string")
						: [],
				};
			}
			return out;
		},
	),
	/** Tag records referenced by at least one location. */
	visible: memoOnRefs(
		(): [Record<number, Tag>] => [Tag.all()],
		(tags): Tag[] => Object.values(tags).filter((t) => t.visible !== false),
	),
	/** Look up a tag record, including unreferenced tags. */
	get: (id: number): Tag | undefined => {
		return Tag.all()[id];
	},
	/** Tag names for the given ids, skipping any that no longer resolve. */
	names: (ids: number[]): string[] => {
		return ids.map((id) => Tag.all()[id]?.name).filter((n): n is string => n != null);
	},
	/** Remove tags from every location in one undoable step.
	 * Unreferenced tags are hidden; undo restores them. */
	remove: (tagIds: number[]) => {
		return Edit.work(
			{ type: "Union", selections: tagIds.map((id) => selection(tagSelector(id))) },
			{ kind: "listSet", key: "tags", add: [], remove: tagIds },
		);
	},
	/** Update tag display records in one undoable edit. */
	update: (updates: Patch<Tag>[]) => {
		return Edit.values(
			"tags",
			updates.map((put) => ({ put })),
		);
	},
	/** Get or create tag records by name and return their ids. */
	create: async (records: TagCreate[]): Promise<number[]> => {
		const result = await Edit.values(
			"tags",
			records.map((record) => ({ add: { ...record, id: 0 } })),
		);
		return result.keys;
	},
	/** Set tag display order from an ordered list of ids. */
	reorder: (ids: number[]) => {
		return Tag.update(ids.map((id, order) => ({ id, order })));
	},
	/** Move matching locations to a tag with the given name, optionally within a selector. */
	rename: async (ids: number[], name: string, scope: Selector | null = null) => {
		const [target] = await Tag.create([{ name }]);
		const sources = ids.filter((id) => id !== target);
		if (!sources.length) return;
		const carriers = any(...sources.map(tagSelector));
		await Edit.work(scope ? and(carriers, scope) : carriers, {
			kind: "listSet",
			key: "tags",
			add: [target],
			remove: sources,
		});
	},
	/** Get or create tag records and assign them to matching locations. */
	assign: async (selector: Selector, records: TagCreate[]) => {
		const add = await Tag.create(records);
		return Edit.work(selector, { kind: "listSet", key: "tags", add, remove: [] });
	},
};
