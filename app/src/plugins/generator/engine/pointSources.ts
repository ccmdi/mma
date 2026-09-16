import type { LatLng } from "@/types";
import type { HoneycombRun } from "@/bindings.gen";
import type { PointSource } from "./types";

/** Hands out `points` front to back. */
export function pointsInOrder(points: LatLng[]): PointSource {
	let next = 0;
	return async (n) => {
		const batch = points.slice(next, next + n);
		next += batch.length;
		return batch;
	};
}

/** Serves points as a producer emits them, so draws can start before it finishes. Draws come
 *  uniformly at random from everything emitted so far, converging on a full shuffle once the
 *  producer is done. */
export function streamedPoints(
	produce: (emit: (points: LatLng[]) => void) => Promise<void>,
): PointSource {
	const buffer: LatLng[] = [];
	let state: "producing" | "done" | { error: unknown } = "producing";
	let wake!: () => void;
	let more = new Promise<void>((resolve) => (wake = resolve));
	const signal = () => {
		wake();
		more = new Promise<void>((resolve) => (wake = resolve));
	};
	produce((points) => {
		buffer.push(...points);
		signal();
	}).then(
		() => {
			state = "done";
			signal();
		},
		(error: unknown) => {
			state = { error };
			signal();
		},
	);
	return async (n) => {
		while (buffer.length === 0) {
			if (state === "done") return [];
			if (state !== "producing") throw state.error;
			await more;
		}
		const drawn: LatLng[] = new Array(Math.min(n, buffer.length));
		for (let k = 0; k < drawn.length; k++) {
			const i = (Math.random() * buffer.length) | 0;
			drawn[k] = buffer[i];
			buffer[i] = buffer[buffer.length - 1];
			buffer.pop();
		}
		return drawn;
	};
}

/** Every point of the grid runs exactly once, in random order, without laying them all out. */
export function gridPointSource(runs: HoneycombRun[]): PointSource {
	const ends: number[] = [];
	let total = 0;
	for (const run of runs) ends.push((total += run.count));
	const swapped = new Map<number, number>();
	let left = total;
	return async (n) => {
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
