import type { ChangeEvent, ListedSelection, PatchOp } from "@/bindings.gen";

export const add = (path: string, value: unknown): PatchOp => ({
	op: "add",
	path,
	value,
});
export const replace = (path: string, value: unknown): PatchOp => ({
	op: "replace",
	path,
	value,
});
export const remove = (path: string): PatchOp => ({ op: "remove", path });

/** A change event that moved no rows and patched the derived state with `patch`. */
export const changeEvent = (
	patch: PatchOp[] = [],
	version = 0,
	keys: Partial<Pick<ChangeEvent, "added" | "updated" | "removed">> = {},
): ChangeEvent => ({
	version,
	added: [],
	updated: [],
	removed: [],
	...keys,
	patch,
});

/** The derived state that lists `rows`, in order. */
export const listedState = (rows: ListedSelection[]) => ({
	selectionRows: Object.fromEntries(rows.map((row) => [row.selection.key, row])),
	selectionOrder: rows.map((row) => row.selection.key),
});
