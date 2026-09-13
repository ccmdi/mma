import { useEffect, useRef, useState } from "react";
import { phaseRate, type PhaseRate } from "@/lib/util/util";

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
