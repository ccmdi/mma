/** Baidu Street View public CDN endpoints (no API key). */

export const BAIDU_SEARCH_URL = "https://mapsv0.bdimg.com/?qt=qsdata";
export const BAIDU_META_URL = "https://mapsv0.bdimg.com/?qt=sdata";
export const BAIDU_PANO_BASE = "https://mapsv0.bdimg.com/";
export const BAIDU_COVERAGE_UDT = "20200825";

export function baiduPanoTileHost(shard: 0 | 1 = 0): string {
	return `https://mapsv${shard}.bdimg.com/`;
}

/**
 * Deterministic shard pick from the resource key (NOT random). Warming
 * (`new Image()` prefetch) and the actual render call `getTileUrl` with the
 * same arguments at different times — if the shard were random, the two
 * calls would build different URLs and the browser HTTP cache would never
 * hit, silently defeating all prefetch/warm work.
 */
function shardFor(...parts: (string | number)[]): 0 | 1 {
	let h = 0;
	for (const part of parts) {
		const s = String(part);
		for (let i = 0; i < s.length; i += 1) {
			h = (h * 31 + s.charCodeAt(i)) | 0;
		}
	}
	return (h & 1) as 0 | 1;
}

export function baiduCoverageTileUrl(x: number, y: number, z: number): string {
	const s = Math.abs(x) % 2;
	return `https://mapsv${s}.bdimg.com/tile/?udt=${BAIDU_COVERAGE_UDT}&qt=tile&styles=pl&x=${x}&y=${y}&z=${z}`;
}

export function baiduPanoTileUrl(sid: string, zoom: number, x: number, y: number): string {
	const url = new URL(baiduPanoTileHost(shardFor(sid)));
	url.searchParams.set("qt", "pdata");
	url.searchParams.set("sid", sid);
	url.searchParams.set("pos", `${y}_${x}`);
	url.searchParams.set("z", String(zoom + 1));
	return url.href;
}

/** Fast 2:1 preview render — perspective (rectilinear), not sphere-mapped. */
export function baiduPr3dThumbUrl(
	panoid: string,
	opts?: {
		heading?: number;
		pitch?: number;
		width?: number;
		height?: number;
		fovy?: number;
		quality?: number;
	},
): string {
	const url = new URL(baiduPanoTileHost(shardFor(panoid)));
	url.searchParams.set("qt", "pr3d");
	url.searchParams.set("fovy", String(opts?.fovy ?? 125));
	url.searchParams.set("quality", String(opts?.quality ?? 100));
	url.searchParams.set("panoid", panoid);
	url.searchParams.set("heading", String(opts?.heading ?? 0));
	url.searchParams.set("pitch", String(opts?.pitch ?? 0));
	url.searchParams.set("width", String(opts?.width ?? 1024));
	url.searchParams.set("height", String(opts?.height ?? 512));
	return url.href;
}

export function baiduShareUrl(sid: string, heading = 0, pitch = 0): string {
	const url = new URL(
		"https://map.baidu.com/?newmap=1&shareurl=1&panotype=street&l=21&tn=B_NORMAL_MAP&sc=0",
	);
	url.searchParams.set("panoid", sid);
	url.searchParams.set("pid", sid);
	url.searchParams.set("heading", String(heading));
	url.searchParams.set("pitch", String(pitch));
	return url.href;
}
