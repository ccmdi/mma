import { schemeBase } from "@/lib/util/util";
import { bd09McToGcj02 } from "@/lib/geo/chinaCrs";
import { baiduShareUrl } from "./endpoints";
import { stripBaidu } from "./prefix";

/** Baidu Maps share URL for a pano (matches altproviders translatePanoUrl). */
export function buildBaiduShareUrl(sid: string, heading = 0, pitch = 0): string {
	return baiduShareUrl(stripBaidu(sid), heading, pitch);
}

const shortLinkCache = new Map<string, string>();

/** Test helper — drop cached short links. */
export function clearBaiduShortLinkCache(): void {
	shortLinkCache.clear();
}

/**
 * Shorten a Baidu Maps share URL via j.map.baidu.com (proxied through the
 * Tauri `bmaps` scheme — same pattern as Google `gmaps` short links).
 */
export async function shortenBaiduShareUrl(longUrl: string): Promise<string> {
	let cacheKey: string;
	try {
		cacheKey = new URL(longUrl).searchParams.get("panoid") ?? longUrl;
	} catch {
		cacheKey = longUrl;
	}
	const hit = shortLinkCache.get(cacheKey);
	if (hit) return hit;

	const apiUrl =
		`${schemeBase("bmaps")}?url=${encodeURIComponent(longUrl)}` +
		`&web=true&pcevaname=pc4.1&newfrom=zhuzhan_webmap`;

	try {
		const res = await fetch(apiUrl, {
			method: "GET",
			credentials: "omit",
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return longUrl;
		const data = (await res.json()) as { url?: string };
		if (typeof data?.url === "string" && data.url.startsWith("http")) {
			shortLinkCache.set(cacheKey, data.url);
			return data.url;
		}
	} catch {
		/* fall through */
	}
	return longUrl;
}

export function isBaiduMapsHost(hostname: string): boolean {
	return (
		hostname === "map.baidu.com" ||
		hostname === "www.map.baidu.com" ||
		hostname.endsWith(".map.baidu.com") ||
		hostname === "j.map.baidu.com"
	);
}

export function isBaiduShortHost(hostname: string): boolean {
	return hostname === "j.map.baidu.com";
}

/**
 * Expand a `j.map.baidu.com/...` short link to its long `map.baidu.com` URL
 * via the Tauri `bmaps` scheme (reads the redirect Location header).
 */
export async function expandBaiduShortUrl(shortUrl: string | URL): Promise<URL | null> {
	let url: URL;
	try {
		url = typeof shortUrl === "string" ? new URL(shortUrl.trim()) : shortUrl;
	} catch {
		return null;
	}
	if (!isBaiduShortHost(url.hostname)) return null;
	const path = url.pathname.replace(/^\//, "");
	if (!path) return null;

	const proxyUrl = `${schemeBase("bmaps")}${path}?mma_resolve=1`;
	try {
		const res = await fetch(proxyUrl, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const target = (await res.json()) as string;
		if (typeof target !== "string" || !target.startsWith("http")) return null;
		return new URL(target);
	} catch {
		return null;
	}
}

function parseNum(raw: string | null | undefined, fallback = 0): number {
	if (raw == null || raw === "") return fallback;
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : fallback;
}

/** Parse `@x,y,...` BD-09MC meters from a Baidu Maps path segment. */
function parseBaiduPathMeters(pathname: string): { lng: number; lat: number } | null {
	const m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(pathname);
	if (!m) return null;
	const x = parseFloat(m[1]!);
	const y = parseFloat(m[2]!);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	// Path coords are meters (same units as qsdata), not sdata centimeters.
	const [lng, lat] = bd09McToGcj02([x, y]);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lng, lat };
}

export type ParsedBaiduMapsUrl = {
	panoId: string | null;
	lat: number | null;
	lng: number | null;
	heading: number;
	pitch: number;
};

/**
 * Parse a long Baidu Maps Street View URL (query and/or hash panoid).
 * Lat/lng come from path `@x,y` when present; callers should prefer sdata.
 */
export function parseBaiduMapsUrl(url: URL): ParsedBaiduMapsUrl | null {
	if (!isBaiduMapsHost(url.hostname) || isBaiduShortHost(url.hostname)) return null;

	const hashParams = url.hash
		? new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash)
		: null;
	const q = url.searchParams;

	const panoId =
		hashParams?.get("panoid") ||
		hashParams?.get("pid") ||
		q.get("panoid") ||
		q.get("pid") ||
		null;

	const heading = parseNum(hashParams?.get("heading") ?? q.get("heading"));
	const pitch = parseNum(hashParams?.get("pitch") ?? q.get("pitch"));
	const fromPath = parseBaiduPathMeters(url.pathname);

	if (!panoId && !fromPath) return null;

	return {
		panoId: panoId ? stripBaidu(panoId) : null,
		lat: fromPath?.lat ?? null,
		lng: fromPath?.lng ?? null,
		heading,
		pitch,
	};
}
