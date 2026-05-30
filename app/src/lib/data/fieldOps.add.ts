/**
 * Pure planning logic for bulk metadata-field operations (rename / merge / delete / set).
 * These compute the `extra` replacement blobs and selection-reference rewrites; the store
 * orchestrates IPC, definitions, and persistence. Kept side-effect-free for testability.
 */

import type { Location, MapData } from "@/types";
import type { Selection, SelectionProps } from "@/store/selections";
import { buildSelection } from "@/store/selections";

/** When a move target already holds a value, which field's value survives. */
export type MergeWinner = "from" | "to";

/** A planned change to one location's `extra` (the full replacement blob). */
export interface ExtraUpdate {
	id: number;
	extra: Record<string, unknown>;
}

/**
 * Rename/merge field `from` into `to`. Rename and merge are the same operation —
 * "rename" is just the case where no location already has `to`. When a location has
 * both keys, `winner` decides which value survives under the `to` key.
 * Returns updates only for locations that actually change.
 */
export function planFieldMove(
	locations: Location[],
	from: string,
	to: string,
	winner: MergeWinner,
): ExtraUpdate[] {
	if (from === to || !to) return [];
	const updates: ExtraUpdate[] = [];
	for (const loc of locations) {
		const extra = loc.extra;
		if (!extra || !(from in extra)) continue;
		const next = { ...extra };
		const fromVal = next[from];
		const hasTo = to in next;
		delete next[from];
		if (!hasTo || winner === "from") next[to] = fromVal;
		// winner === "to" with existing target: keep `next[to]` untouched
		updates.push({ id: loc.id, extra: next });
	}
	return updates;
}

/** Remove field `key` from every location that has it. */
export function planFieldDelete(locations: Location[], key: string): ExtraUpdate[] {
	const updates: ExtraUpdate[] = [];
	for (const loc of locations) {
		if (!loc.extra || !(key in loc.extra)) continue;
		const next = { ...loc.extra };
		delete next[key];
		updates.push({ id: loc.id, extra: next });
	}
	return updates;
}

/** Set field `key` to `value` on the given locations, skipping those already equal. */
export function planFieldSet(locations: Location[], key: string, value: unknown): ExtraUpdate[] {
	const updates: ExtraUpdate[] = [];
	for (const loc of locations) {
		if (loc.extra && loc.extra[key] === value) continue;
		updates.push({ id: loc.id, extra: { ...(loc.extra ?? {}), [key]: value } });
	}
	return updates;
}

/**
 * Rewrite Filter `field` references in a selection tree: `from` → `to`, or drop the
 * Filter when `to` is null (field deleted). Composites collapse if emptied, or unwrap
 * to their sole survivor (matching the rest of the selection engine's semantics).
 */
function rewriteSelection(
	map: MapData,
	sel: Selection,
	from: string,
	to: string | null,
): Selection | null {
	const p = sel.props;
	if (p.type === "Filter") {
		if (p.field !== from) return sel;
		return to === null ? null : buildSelection(map, { ...p, field: to });
	}
	if ("selections" in p) {
		const children = p.selections
			.map((c) => rewriteSelection(map, c, from, to))
			.filter((c): c is Selection => c !== null);
		if (children.length === 0) return null;
		if (children.length === 1 && p.type !== "Invert") return children[0];
		return buildSelection(map, { ...p, selections: children } as SelectionProps);
	}
	return sel;
}

export function rewriteSelectionFields(
	map: MapData,
	selections: Selection[],
	from: string,
	to: string | null,
): Selection[] {
	return selections
		.map((s) => rewriteSelection(map, s, from, to))
		.filter((s): s is Selection => s !== null);
}
