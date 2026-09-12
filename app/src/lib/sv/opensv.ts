/* eslint-disable @typescript-eslint/no-explicit-any */
import { schemeBase } from "@/lib/util/util";

let loaded = false;
let loading: Promise<void> | null = null;

export let google: typeof globalThis.google;

export function loadOpenSV(): Promise<void> {
	if (loaded) return Promise.resolve();
	if (loading) return loading;
	loading = (async () => {
		const res = await fetch("/opensv/opensv.js");
		let src = await res.text();
		src = src.replace(/https:\/\/lh[3-6]\.ggpht\.com\/jsapi2\/a\/b\/c\//g, schemeBase("svtile"));
		const blob = new Blob([src], { type: "application/javascript" });
		const url = URL.createObjectURL(blob);
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement("script");
			script.src = url;
			script.onload = () => {
				URL.revokeObjectURL(url);
				loaded = true;
				google = (window as any).google;
				resolve();
			};
			script.onerror = reject;
			document.head.appendChild(script);
		});
	})();
	return loading;
}
