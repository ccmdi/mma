/** Tencent Street View public CDN endpoints (no API key). */

export const TENCENT_SEARCH_URL = "https://sv.map.qq.com/xf?output=json";
export const TENCENT_META_URL = "https://sv.map.qq.com/sv?output=json";
export const TENCENT_TILE_BASE = "https://sv{s}.map.qq.com/tile?from=web";
export const TENCENT_THUMB_BASE =
	"https://sv{s}.map.qq.com/thumb?x=0&y=0&from=html5&level=0";
export const TENCENT_SHARE_BASE = "https://qq-map.netlify.app";
export const TENCENT_COVERAGE_PMTILES =
	"https://qq-map-temporary.map-making.app/lines.pmtiles";

function subdomain(base: string, seed: number): string {
	return base.replace("{s}", String(seed % 4));
}

export function tencentPanoTileUrl(
	svid: string,
	level: number,
	x: number,
	y: number,
): string {
	const url = new URL(subdomain(TENCENT_TILE_BASE, x));
	url.searchParams.set("x", String(x));
	url.searchParams.set("y", String(y));
	url.searchParams.set("level", String(level));
	url.searchParams.set("svid", svid);
	return url.href;
}

export function tencentThumbUrl(svid: string): string {
	const seed = Number(svid.slice(16, 18));
	const url = new URL(subdomain(TENCENT_THUMB_BASE, Number.isFinite(seed) ? seed : 0));
	url.searchParams.set("svid", svid);
	return url.href;
}

/** Full-size preview thumb for bulk / single download (download.js parity). */
export function tencentDownloadThumbUrl(svid: string): string {
	const seed = Number(svid.slice(16, 18));
	const url = new URL(
		subdomain("https://sv{s}.map.qq.com/thumb?from=web", Number.isFinite(seed) ? seed : 0),
	);
	url.searchParams.set("level", "2");
	url.searchParams.set("svid", svid);
	return url.href;
}

export function tencentShareUrl(svid: string, heading = 0, pitch = 0): string {
	const url = new URL(TENCENT_SHARE_BASE);
	const hash = new URLSearchParams();
	hash.set("pano", svid);
	hash.set("heading", String(heading));
	hash.set("pitch", String(pitch));
	url.hash = hash.toString();
	return url.href;
}
