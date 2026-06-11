import type { Tag } from "@/bindings.gen";
import type { TagSortMode } from "@/types";

/** Base URL for a Tauri custom URI scheme. Windows WebView2 uses http://<scheme>.localhost/. */
export function schemeBase(scheme: string): string {
	return navigator.platform.startsWith("Win")
		? `http://${scheme}.localhost/`
		: `${scheme}://localhost/`;
}

export function mmaBufUrl(path: string): string {
	return schemeBase("mma-buf") + path.replace(/\\/g, "/");
}

export function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && isFinite(v);
}

// Order strings with embedded numbers by numeric value, not lexically
export function compareNatural(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

export interface NumericBuckets {
	count: number;
	min: number;
	max: number;
	bounds: [number, number][];
	labels: string[];
	bucketIndex(value: number): number;
}

// Split a numeric range into `count` equal-width buckets (a histogram axis).
// Non-finite values are ignored; returns null if there's no spread to bucket.
export function bucketize(values: number[], count: number): NumericBuckets | null {
	if (count < 1) return null;
	let min = Infinity;
	let max = -Infinity;
	let any = false;
	for (const n of values) {
		if (!Number.isFinite(n)) continue;
		any = true;
		if (n < min) min = n;
		if (n > max) max = n;
	}
	if (!any || min === max) return null;
	const step = (max - min) / count;
	const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
	const bounds: [number, number][] = [];
	const labels: string[] = [];
	for (let i = 0; i < count; i++) {
		const lo = min + step * i;
		const hi = i === count - 1 ? max : min + step * (i + 1);
		bounds.push([lo, hi]);
		labels.push(`${fmt(lo)}–${fmt(hi)}`);
	}
	return {
		count,
		min,
		max,
		bounds,
		labels,
		bucketIndex(value: number): number {
			if (value <= min) return 0;
			if (value >= max) return count - 1;
			const idx = Math.floor((value - min) / step);
			return idx < 0 ? 0 : idx >= count ? count - 1 : idx;
		},
	};
}

export function sortTagsByMode(tags: Tag[], mode: TagSortMode, counts: Record<number, number>): Tag[] {
	const sorted = [...tags];
	if (mode === "name") return sorted.sort((a, b) => a.name.localeCompare(b.name));
	if (mode === "amount") return sorted.sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));
	return sorted.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

// FOV (degrees) → zoom level
export function fovToZoom(fov: number): number {
	return -Math.log2((4 / 3) * Math.tan((Math.PI * fov) / 360)) + 1;
}
