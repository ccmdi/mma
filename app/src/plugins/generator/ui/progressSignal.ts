import { useEffect, useRef, useState } from "react";

const WINDOW_MS = 10_000;
const TICK_MS = 500;

/** Observed locations/second over the last ten seconds for the rate label; null while
 *  inactive or before a rate is observable. Quiet stretches read as a falling rate
 *  rather than freezing the last good one. The count itself renders raw: finds arrive
 *  in waves, and the honest display jumps with them. */
export function useFoundRate(count: number, active: boolean): number | null {
	const samples = useRef<{ t: number; count: number }[]>([]);
	const latest = useRef(count);
	latest.current = count;
	const [rate, setRate] = useState<number | null>(null);

	useEffect(() => {
		if (!active) {
			samples.current = [];
			setRate(null);
			return;
		}
		const tick = () => {
			const now = performance.now();
			const s = samples.current;
			if (s.length > 0 && latest.current < s[s.length - 1].count) s.length = 0;
			s.push({ t: now, count: latest.current });
			while (s.length > 1 && now - s[0].t > WINDOW_MS) s.shift();
			const dt = (now - s[0].t) / 1000;
			const dd = latest.current - s[0].count;
			setRate(dt >= 0.25 && dd >= 0 ? dd / dt : null);
		};
		tick();
		const iv = setInterval(tick, TICK_MS);
		return () => clearInterval(iv);
	}, [active]);

	return rate;
}
