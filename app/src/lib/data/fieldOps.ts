/**
 * Field helpers for the selection-reference rewrites that follow a field move and the
 * partition projections. Every bulk field mutation (set, expression, rename/merge,
 * delete) runs in Rust (`store_apply_field_op`); nothing here plans per-location
 * patches. Side-effect-free.
 */

import type { Location, ExtraFieldType, Selection, Selector } from "@/bindings.gen";
import { buildSelection } from "@/store/selections";
import { isBuiltinField } from "@/lib/data/fieldDefRegistry";
import { msg } from "@/lib/i18n";

/** Read field `key` from a location: built-in keys read the top-level property,
 *  everything else reads from `extra`. */
export function fieldValue(loc: Location, key: string): unknown {
	return isBuiltinField(key) ? (loc as unknown as Record<string, unknown>)[key] : loc.extra?.[key];
}

/** Every `extra` key present on any of `locs`. */
export function extraKeysOf(locs: readonly Location[]): Set<string> {
	const keys = new Set<string>();
	for (const loc of locs) {
		if (loc.extra) for (const k of Object.keys(loc.extra)) keys.add(k);
	}
	return keys;
}

/**
 * Rewrite Filter `field` references in a selection tree: `from` → `to`, or drop the
 * Filter when `to` is null (field deleted). Composites collapse if emptied, or unwrap
 * to their sole survivor (matching the rest of the selection engine's semantics).
 */
function rewriteSelection(sel: Selection, from: string, to: string | null): Selection | null {
	const p = sel.selector;
	if (p.type === "Filter") {
		if (p.field !== from) return sel;
		return to === null ? null : buildSelection({ ...p, field: to });
	}
	if ("selections" in p) {
		const children = p.selections
			.map((c) => rewriteSelection(c, from, to))
			.filter((c): c is Selection => c !== null);
		if (children.length === 0) return null;
		if (children.length === 1 && p.type !== "Invert") return children[0];
		return buildSelection({ ...p, selections: children } as Selector);
	}
	return sel;
}

// --- Tag projections: the catalog of grouping keys --------------------------------
// id/label/applicability only — drives the dropdowns. Key derivation runs in Rust
// (`selections.rs` KeySpec); ids line up 1:1 with the Rust `DatePart` variants.

interface FieldProjection {
	id: string;
	label: string;
	appliesTo: ExtraFieldType[];
	/** Date projections read in the location's own timezone when set — surfaces a toggle. */
	needsTz?: boolean;
}

const TAG_PROJECTIONS: FieldProjection[] = [
	{ id: "value", label: msg("Value"), appliesTo: ["string", "enum", "number", "month"] },
	{ id: "year", label: msg("Year"), appliesTo: ["date", "month"], needsTz: true },
	{ id: "yearMonth", label: msg("Year-month"), appliesTo: ["date"], needsTz: true },
	{ id: "day", label: msg("Exact day"), appliesTo: ["date"], needsTz: true },
	{ id: "monthOfYear", label: msg("Month of year"), appliesTo: ["date", "month"], needsTz: true },
	{ id: "hourOfDay", label: msg("Hour of day"), appliesTo: ["date"], needsTz: true },
];

/** Projections valid for a field type, in display order (first = dialog default). */
export function projectionsForType(type: ExtraFieldType): FieldProjection[] {
	return TAG_PROJECTIONS.filter((p) => p.appliesTo.includes(type));
}

// --- Partition: grouping runs in Rust (`store_partition`); these are the JS-side glue. ---

/** The synthetic "Range" option: numeric binning, which isn't a stateless projection. */
export const RANGE_ID = "range";

/** Dropdown options for a partition: the projection catalog plus "Range" for numbers (and
 *  dates too when `rangeForDates`). */
export function partitionKeyOptions(
	type: ExtraFieldType,
	rangeForDates: boolean,
): { id: string; label: string }[] {
	const projs = projectionsForType(type).map((p) => ({ id: p.id, label: p.label }));
	const hasRange = type === "number" || (rangeForDates && type === "date");
	return hasRange ? [{ id: RANGE_ID, label: msg("Range") }, ...projs] : projs;
}

export function rewriteSelectionFields(
	selections: Selection[],
	from: string,
	to: string | null,
): Selection[] {
	return selections
		.map((s) => rewriteSelection(s, from, to))
		.filter((s): s is Selection => s !== null);
}
