import { normalizeHeading } from "@/lib/geo/geo";

const TWEEN_DURATION = 160;

export function tweenPov(
	pano: google.maps.StreetViewPanorama,
	target: { heading: number; pitch: number },
	onComplete?: () => void,
): () => void {
	const from = pano.getPov();
	const dh = normalizeHeading(from.heading - target.heading);
	const dp = from.pitch - target.pitch;
	const start = performance.now();
	let id = 0;
	function tick(now: number) {
		const t = Math.min((now - start) / TWEEN_DURATION, 1);
		const e = t * (2 - t);
		pano.setPov({
			heading: target.heading + dh * (1 - e),
			pitch: target.pitch + dp * (1 - e),
		});
		if (t < 1) {
			id = requestAnimationFrame(tick);
		} else {
			onComplete?.();
		}
	}
	id = requestAnimationFrame(tick);
	return () => cancelAnimationFrame(id);
}
