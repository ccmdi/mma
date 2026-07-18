/**
 * Bootstrap Apple Look Around as a first-class in-app Street View provider:
 * pano provider, enrichment, SV-style line coverage + deck.gl panorama dots.
 * Map clicks are unified in mapClick via location.provider — no click interceptor.
 */
import { initCoverage } from "@/lib/sv/lookaround/coverage";
import { registerLookAroundEnrichment } from "@/lib/sv/lookaround/enrich";
import { registerLookAroundPanoProvider } from "@/lib/sv/lookaround/panoProvider";

let started = false;
let teardown: (() => void) | null = null;

export function startLookAroundProvider(): () => void {
	if (started) return () => {};
	started = true;

	registerLookAroundEnrichment();
	const unbindPano = registerLookAroundPanoProvider();
	const unbindCoverage = initCoverage();

	teardown = () => {
		unbindCoverage();
		unbindPano();
		started = false;
		teardown = null;
	};

	return teardown;
}

export function stopLookAroundProvider(): void {
	teardown?.();
}
