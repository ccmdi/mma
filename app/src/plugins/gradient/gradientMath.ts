import type { FieldDef, KeySpec, PartitionBucket, SelectionInput } from "@/bindings.gen";
import type { RGB } from "@/lib/util/color";
import { ymOrdinal } from "@/lib/util/date";
import { partitionLabel } from "@/lib/util/format";
import { selection } from "@/store/selections";

export function lerp(a: RGB, b: RGB, t: number): RGB {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

export function gradientColor(stops: RGB[], t: number): RGB {
	if (t <= 0) return stops[0];
	if (t >= 1) return stops[stops.length - 1];
	const segment = t * (stops.length - 1);
	const i = Math.floor(segment);
	return lerp(stops[i], stops[Math.min(i + 1, stops.length - 1)], segment - i);
}

export function isNumericField(def: FieldDef | undefined): boolean {
	if (!def) return false;
	return def.type === "number" || def.type === "date";
}

// Numeric position of a categorical value, for proportional (not ordinal) gradient
// mapping. Months ("YYYY-MM") become an ordinal month count; numeric strings their
// value. Returns null for non-numeric categories (caller falls back to even spacing).
export function fieldScale(value: string, type: string | undefined): number | null {
	if (type === "month") return ymOrdinal(value);
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : null;
}

// Colour partition groups along the ramp: numeric bins use ordinal position;
// numeric categories use their scale; other categories are evenly spaced.
// Whole-map bins and values become live filters; scoped or projected groups use fixed ids.

export function colorPartition(
	groups: PartitionBucket[],
	opts: {
		fieldKey: string;
		fieldType: string | undefined;
		spec: KeySpec;
		stops: RGB[];
		narrowed: boolean;
		ordinal: boolean;
		eqFilter: boolean;
	},
): SelectionInput[] {
	// Numeric bins keep their empties for the pivot; an empty selection is noise here.
	groups = groups.filter((g) => g.ids.length > 0);
	if (groups.length === 0) return [];
	const { fieldKey, fieldType, spec, stops, narrowed, ordinal, eqFilter } = opts;
	const n = groups.length;
	const evenSpaced = (i: number) => (n === 1 ? 0.5 : i / (n - 1));

	let ts: number[];
	if (ordinal) {
		ts = groups.map((_, i) => evenSpaced(i));
	} else {
		const scales = groups.map((g) => fieldScale(g.key, fieldType));
		const proportional = n > 1 && scales.every((s) => s !== null);
		if (proportional) {
			const lo = Math.min(...(scales as number[]));
			const hi = Math.max(...(scales as number[]));
			ts = scales.map((s, i) => (hi > lo ? ((s as number) - lo) / (hi - lo) : evenSpaced(i)));
		} else {
			ts = groups.map((_, i) => evenSpaced(i));
		}
	}

	return groups.map((g, i): SelectionInput => {
		const color = gradientColor(stops, ts[i]);
		if (!narrowed && g.bin) {
			const [lo, hi] = g.bin;
			const test = { op: "between", lo, hi } as const;
			return { ...selection({ type: "Filter", field: fieldKey, test }), color };
		}
		if (!narrowed && eqFilter) {
			const test = { op: "eq", value: g.key } as const;
			return { ...selection({ type: "Filter", field: fieldKey, test }), color };
		}
		const name = partitionLabel(g.key, spec);
		return { ...selection({ type: "Locations", locations: g.ids, name }), color };
	});
}
