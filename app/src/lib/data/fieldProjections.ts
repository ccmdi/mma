import { PROJECTIONS } from "@/bindings.consts";
import type { FieldType } from "@/bindings.consts";
import { msg } from "@/lib/i18n";
import { log } from "@/lib/util/log";

// The catalog (ids, applicability, timezone need) is the Rust `PROJECTIONS` constant;
// key derivation runs in Rust too (`KeySpec`). Only the labels live here.

const PROJECTION_LABELS: Record<string, string> = {
	value: msg("Value"),
	year: msg("Year"),
	yearMonth: msg("Year-month"),
	day: msg("Exact day"),
	monthOfYear: msg("Month of year"),
	hourOfDay: msg("Hour of day"),
};

export interface FieldProjection {
	id: string;
	label: string;
	/** True when this projection uses the location's timezone. */
	needsTz: boolean;
}

/** Projections valid for a field type, in display order (first = dialog default). */
export function projectionsForType(type: FieldType): FieldProjection[] {
	return PROJECTIONS.filter((p) => (p.appliesTo as readonly FieldType[]).includes(type)).map(
		(p) => ({
			id: p.id,
			label: projectionLabel(p.id),
			needsTz: p.needsTz,
		}),
	);
}

// Render sites translate the returned label, so the raw id is a visible fallback, not a crash.
function projectionLabel(id: string): string {
	const label = PROJECTION_LABELS[id];
	if (!label && import.meta.env.DEV) log.warn(`[fields] projection "${id}" has no label`);
	return label ?? id;
}

/** The "Range" partition option (numeric binning). */
export const RANGE_ID = "range";

/** Partition-key dropdown options for a field type. */
export function partitionKeyOptions(
	type: FieldType,
	rangeForDates: boolean,
): { id: string; label: string }[] {
	const projs = projectionsForType(type).map((p) => ({ id: p.id, label: p.label }));
	const hasRange = type === "number" || (rangeForDates && type === "date");
	return hasRange ? [{ id: RANGE_ID, label: msg("Range") }, ...projs] : projs;
}
