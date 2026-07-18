/**
 * Bootstrap Baidu Street View: official-pipeline inject + enrichment + coverage.
 * Rendering uses the Google singleton via BAIDU: inject — no MMA PanoProvider.
 */
import { initBaiduCoverage } from "@/lib/sv/baidu/coverage";
import { registerBaiduEnrichment } from "@/lib/sv/baidu/enrich";
import { installBaiduGoogleBridge } from "@/lib/sv/baidu/inject";
import { loadOpenSV } from "@/lib/sv/opensv";

let started = false;
let teardown: (() => void) | null = null;

export function startBaiduProvider(): () => void {
	if (started) return () => {};
	started = true;

	registerBaiduEnrichment();
	const unbindCoverage = initBaiduCoverage();
	let unbindBridge: (() => void) | null = null;
	void loadOpenSV()
		.then(() => installBaiduGoogleBridge())
		.then((u) => {
			unbindBridge = u;
		})
		.catch(() => {
			/* opensv may not be ready yet; resolvePano installs again */
		});

	teardown = () => {
		unbindBridge?.();
		unbindCoverage();
		started = false;
		teardown = null;
	};

	return teardown;
}

export function stopBaiduProvider(): void {
	teardown?.();
}
