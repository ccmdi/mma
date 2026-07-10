import type { ExtraFieldDef, PartitionBucket, SelectionProps } from "@/bindings.gen";

export function lerp(
	a: [number, number, number],
	b: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

export function gradientColor(
	stops: [number, number, number][],
	t: number,
): [number, number, number] {
	if (t <= 0) return stops[0];
	if (t >= 1) return stops[stops.length - 1];
	const segment = t * (stops.length - 1);
	const i = Math.floor(segment);
	return lerp(stops[i], stops[Math.min(i + 1, stops.length - 1)], segment - i);
}

export function isNumericField(def: ExtraFieldDef | undefined): boolean {
	if (!def) return false;
	return def.type === "number" || def.type === "date";
}

// Numeric position of a categorical value, for proportional (not ordinal) gradient
// mapping. Months ("YYYY-MM") become an ordinal month count; numeric strings their
// value. Returns null for non-numeric categories (caller falls back to even spacing).
export function fieldScale(value: string, type: string | undefined): number | null {
	if (type === "month") {
		const [y, m] = value.split("-").map(Number);
		return Number.isFinite(y) && Number.isFinite(m) ? y * 12 + (m - 1) : null;
	}
	const n = Number(value);
	return value.trim() !== "" && Number.isFinite(n) ? n : null;
}

export interface GradientSelection {
	props: SelectionProps;
	key: string;
	color: [number, number, number];
}

// Color a partition's groups along the ramp and turn each into a selection — the
// gradient sink over the shared `partition()` kernel.
//
// Coloring: numeric range bins color by ordinal position (`ordinal`). Categorical groups
// color proportionally when every key has a numeric scale (e.g. months, numeric strings),
// else by even spacing.
//
// Selection shape (`key` mirrors the engine's key, for setSelectionColors):
//   - unscoped numeric bin  -> live Filter `between` (re-evaluates against the whole map)
//   - unscoped value group  -> live Filter `eq`
//   - everything else       -> static Locations (projections can't be expressed as a Filter;
//                              scoped groups are inherently a fixed id subset)
export function colorPartition(
	groups: PartitionBucket[],
	opts: {
		fieldKey: string;
		fieldType: string | undefined;
		stops: [number, number, number][];
		scoped: boolean;
		ordinal: boolean;
		eqFilter: boolean;
	},
): GradientSelection[] {
	if (groups.length === 0) return [];
	const { fieldKey, fieldType, stops, scoped, ordinal, eqFilter } = opts;
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

	return groups.map((g, i) => {
		const color = gradientColor(stops, ts[i]);
		if (!scoped && g.bin) {
			const [lo, hi] = g.bin;
			return {
				props: { type: "Filter", field: fieldKey, op: "between", value: lo, value2: hi },
				key: `filter:${fieldKey}:between:${lo}:${hi}`,
				color,
			};
		}
		if (!scoped && eqFilter) {
			return {
				props: { type: "Filter", field: fieldKey, op: "eq", value: g.key, value2: null },
				key: `filter:${fieldKey}:eq:${g.key}`,
				color,
			};
		}
		return {
			props: { type: "Locations", locations: g.ids, name: g.key },
			key: g.ids.join(","),
			color,
		};
	});
}
