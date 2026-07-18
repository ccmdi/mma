/**
 * Bootstrap Tencent Street View: official-pipeline inject + enrichment + coverage.
 */
import { initTencentCoverage } from "@/lib/sv/tencent/coverage";
import { registerTencentEnrichment } from "@/lib/sv/tencent/enrich";
import { installTencentGoogleBridge } from "@/lib/sv/tencent/inject";
import { loadOpenSV } from "@/lib/sv/opensv";

let started = false;
let teardown: (() => void) | null = null;

export function startTencentProvider(): () => void {
	if (started) return () => {};
	started = true;

	registerTencentEnrichment();
	const unbindCoverage = initTencentCoverage();
	let unbindBridge: (() => void) | null = null;
	void loadOpenSV()
		.then(() => installTencentGoogleBridge())
		.then((u) => {
			unbindBridge = u;
		})
		.catch(() => {
			/* opensv may not be ready yet */
		});

	teardown = () => {
		unbindBridge?.();
		unbindCoverage();
		started = false;
		teardown = null;
	};

	return teardown;
}

export function stopTencentProvider(): void {
	teardown?.();
}
