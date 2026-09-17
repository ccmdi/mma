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

const COMPACT_EVERY = 256;

/** Serves points as a producer emits them, so draws can start before it finishes. Draws come
 *  uniformly at random from everything emitted so far, converging on a full shuffle once the
 *  producer is done. A batch may carry a key, and `retire` withdraws that key's undrawn
 *  points, so a producer can replace a region's points with better ones. */
export function streamedPoints(
	produce: (
		emit: (points: LatLng[], key?: number) => void,
		retire: (key: number) => void,
	) => Promise<void>,
): PointSource {
	const buffer: LatLng[] = [];
	const keys: number[] = [];
	const retired = new Set<number>();
	let retires = 0;
	let state: "producing" | "done" | { error: unknown } = "producing";
	let wake!: () => void;
	let more = new Promise<void>((resolve) => (wake = resolve));
	const signal = () => {
		wake();
		more = new Promise<void>((resolve) => (wake = resolve));
	};
	const compact = () => {
		let w = 0;
		for (let i = 0; i < buffer.length; i++) {
			if (!retired.has(keys[i])) {
				buffer[w] = buffer[i];
				keys[w] = keys[i];
				w++;
			}
		}
		buffer.length = w;
		keys.length = w;
		retired.clear();
	};
	produce(
		(points, key = -1) => {
			for (const p of points) {
				buffer.push(p);
				keys.push(key);
			}
			signal();
		},
		(key) => {
			retired.add(key);
			if (++retires % COMPACT_EVERY === 0) compact();
		},
	).then(
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
		const drawn: LatLng[] = [];
		while (drawn.length < n) {
			if (buffer.length === 0) {
				if (drawn.length > 0) break;
				if (state === "done") return drawn;
				if (state !== "producing") throw state.error;
				await more;
				continue;
			}
			const i = (Math.random() * buffer.length) | 0;
			const p = buffer[i];
			const k = keys[i];
			buffer[i] = buffer[buffer.length - 1];
			keys[i] = keys[keys.length - 1];
			buffer.pop();
			keys.pop();
			if (!retired.has(k)) drawn.push(p);
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
