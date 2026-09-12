import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { phaseRate, type PhaseRate } from "@/lib/util/util";


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

/** Observed locations/second for the rate label, phase-anchored like the bulk modal's
 *  meter; null while inactive or before a rate is observable. The count itself renders
 *  raw: finds arrive in waves, and the honest display jumps with them. */
export function useFoundRate(count: number, target: number, active: boolean): number | null {
	const anchor = useRef<PhaseRate | null>(null);
	const [rate, setRate] = useState<number | null>(null);

	useEffect(() => {
		if (!active) {
			anchor.current = null;
			setRate(null);
			return;
		}
		const r = phaseRate(anchor.current, count, target, performance.now());
		anchor.current = r.state;
		setRate(r.rate);
	}, [count, target, active]);

	return rate;
}
