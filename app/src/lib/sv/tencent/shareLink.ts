import { TENCENT_SHARE_BASE } from "./endpoints";
import { stripTencent } from "./prefix";

export function buildTencentShareUrl(svid: string, heading = 0, pitch = 0): string {
	const url = new URL(TENCENT_SHARE_BASE);
	const hash = new URLSearchParams();
	hash.set("pano", stripTencent(svid));
	hash.set("heading", String(heading));
	hash.set("pitch", String(pitch));
	url.hash = hash.toString();
	return url.href;
}

function parseNum(raw: string | null | undefined, fallback = 0): number {
	if (raw == null || raw === "") return fallback;
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : fallback;
}

export function isTencentShareHost(hostname: string): boolean {
	return (
		hostname === "qq-map.netlify.app" ||
		(hostname.includes("qq") && hostname.includes("map"))
	);
}

export type ParsedTencentShareUrl = {
	panoId: string | null;
	heading: number;
	pitch: number;
};

/** Parse qq-map.netlify.app or qq* hosts with `#pano=` hash params. */
export function parseTencentShareUrl(url: URL): ParsedTencentShareUrl | null {
	if (!isTencentShareHost(url.hostname)) return null;
	const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
	if (!hash) return null;
	const params = new URLSearchParams(hash);
	const pano = params.get("pano");
	if (!pano) return null;
	return {
		panoId: stripTencent(pano),
		heading: parseNum(params.get("heading")),
		pitch: parseNum(params.get("pitch")),
	};
}
