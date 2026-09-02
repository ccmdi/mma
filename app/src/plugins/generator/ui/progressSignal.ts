import { useSyncExternalStore } from "react";

// Throttled progress signal. The engine calls `tickProgress()` per found pano; bursts are
// coalesced to one render per animation frame, and only the region list subscribes, so a
// count tick no longer force-re-renders the whole generator sidebar.
let tick = 0;
let listeners: (() => void)[] = [];
let scheduled = false;

export function tickProgress(): void {
	if (scheduled) return;
	scheduled = true;
	requestAnimationFrame(() => {
		scheduled = false;
		tick++;
		for (const l of listeners) l();
	});
}

function subscribe(fn: () => void): () => void {
	listeners.push(fn);
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

/** Re-render the caller on throttled (per-frame) generation progress ticks. */
export function useProgressTick(): void {
	useSyncExternalStore(subscribe, () => tick);
}
