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

/** Displayed-count motion for a growing counter: an odometer advancing at the observed
 *  locations/second (phase-anchored like the bulk modal's meter) and clamped to the real
 *  count, so display speed tracks generation speed. Snaps on resets, while inactive, or
 *  before a rate is observable. */
export function useCountMotion(
	count: number,
	target: number,
	active: boolean,
): { shown: number; rate: number | null } {
	const anchor = useRef<PhaseRate | null>(null);
	const shownRef = useRef(count);
	const [shown, setShown] = useState(count);
	const [rate, setRate] = useState<number | null>(null);

	useEffect(() => {
		if (!active) {
			anchor.current = null;
			shownRef.current = count;
			setShown(count);
			setRate(null);
			return;
		}
		const r = phaseRate(anchor.current, count, target, performance.now());
		anchor.current = r.state;
		setRate(r.rate);
		if (count <= shownRef.current || r.rate == null) {
			shownRef.current = count;
			setShown(count);
			return;
		}
		let raf = 0;
		let last = performance.now();
		const step = (now: number) => {
			shownRef.current = Math.min(shownRef.current + (r.rate! * (now - last)) / 1000, count);
			last = now;
			setShown(Math.floor(shownRef.current));
			if (shownRef.current < count) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame(raf);
	}, [count, target, active]);

	return { shown: Math.min(shown, count), rate };
}
