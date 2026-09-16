import type { LatLng } from "@/types";
import type { HoneycombRun } from "@/bindings.gen";
import type { PointSource } from "./types";

/** Hands out `points` front to back. */
export function pointsInOrder(points: LatLng[]): PointSource {
	let next = 0;
	return (n) => {
		const batch = points.slice(next, next + n);
		next += batch.length;
		return batch;
	};
}

/** Every point of the grid runs exactly once, in random order, without laying them all out. */
export function gridPointSource(runs: HoneycombRun[]): PointSource {
	const ends: number[] = [];
	let total = 0;
	for (const run of runs) ends.push((total += run.count));
	const swapped = new Map<number, number>();
	let left = total;
	return (n) => {
		const batch: LatLng[] = [];
		for (; batch.length < n && left > 0; left--) {
			const slot = Math.floor(Math.random() * left);
			const index = swapped.get(slot) ?? slot;
			swapped.set(slot, swapped.get(left - 1) ?? left - 1);
			swapped.delete(left - 1);
			let lo = 0;
			let hi = runs.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (ends[mid] > index) hi = mid;
				else lo = mid + 1;
			}
			const run = runs[lo];
			batch.push({ lat: run.lat, lng: run.lng + (index - (ends[lo] - run.count)) * run.lngStep });
		}
		return batch;
	};
}
