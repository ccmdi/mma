import { imageKeyToPanoId } from "@/lib/sv/svMeta";
import { fovToZoom, schemeBase } from "@/lib/util/util";
import { LocationFlag } from "@/types";
import type { Location } from "@/bindings.gen";
import type { SvProvider } from "@/lib/sv/providers/types";
import { providerToWireSource } from "@/lib/sv/providers/types";
import { fetchBaiduMeta } from "@/lib/sv/baidu/api";
import {
	expandBaiduShortUrl,
	isBaiduMapsHost,
	isBaiduShortHost,
	parseBaiduMapsUrl,
} from "@/lib/sv/baidu/shareLink";
import { META_OPEN } from "@/lib/sv/lookaround/api";
import { headingPitchDeg } from "@/lib/sv/lookaround/panoExtra";
import { getClosestPano } from "@/lib/sv/lookaround/tile";
import { isLookmapHost, parseLookmapUrl } from "@/lib/sv/lookaround/shareLink";
import { fetchTencentMeta } from "@/lib/sv/tencent/api";
import { isTencentShareHost, parseTencentShareUrl } from "@/lib/sv/tencent/shareLink";
import { normalizeStoragePanoId } from "@/lib/sv/providers/panoIdStorage";

/** A single location parsed out of a pasted Maps URL or a bare coordinate. */
export type ParsedLocation = Pick<
	Location,
	"lat" | "lng" | "heading" | "pitch" | "zoom" | "panoId" | "flags" | "provider"
> & {
	/** Tag names */
	tags: string[];
};

async function resolveShortUrl(url: URL): Promise<URL> {
	const id = url.pathname.split("/").at(-1);
	if (!id) return url;
	const source = url.hostname === "maps.app.goo.gl" ? "mapsapp" : undefined;
	// Routed through the Tauri `googl` URI-scheme handler (resolves the redirect
	// server-side), so it works in dev and release.
	const proxyUrl = `${schemeBase("googl")}${id}${source ? `?source=${source}` : ""}`;
	const res = await fetch(proxyUrl, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error("Failed to resolve short URL");
	return new URL(await res.json());
}

function parseExpandedMapsUrl(url: URL): ParsedLocation | null {
	let params: URLSearchParams | null = null;
	if (url.hash) params = new URLSearchParams(url.hash.slice(1));
	params ??= new URLSearchParams();

	const tags = params.has("extra[tags]")
		? params.getAll("extra[tags]")
		: url.searchParams.getAll("extra[tags]");
	const panoFlags =
		(params.get("extra[loadMode]") ?? url.searchParams.get("extra[loadMode]")) === "latLng"
			? LocationFlag.None
			: LocationFlag.LoadAsPanoId;

	if (url.hostname.startsWith("www.google.") && url.pathname.startsWith("/maps")) {
		const m =
			/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)a,(-?\d+(?:\.\d+)?)y(?:,(-?\d+(?:\.\d+)?)h)?,(-?\d+(?:\.\d+)?)t(?:,-?\d+(?:\.\d+)?r)?\/data=(?:.*?)!1s([0-9a-zA-Z_-]+)!2e(\d+)/.exec(
				url.pathname,
			);
		if (m) {
			const lat = parseFloat(m[1] ?? "");
			const lng = parseFloat(m[2] ?? "");
			const zoom = m[4] ? fovToZoom(parseFloat(m[4])) : 0;
			const heading = m[5] ? parseFloat(m[5]) : 0;
			const pitch = m[6] ? parseFloat(m[6]) - 90 : 0;
			const rawId = m[7] ?? null;
			const type = m[8] ? parseInt(m[8], 10) : 0;
			const panoId = rawId ? imageKeyToPanoId([type === 0 ? 2 : type, rawId]) : null;
			return {
				lat,
				lng,
				heading,
				pitch,
				zoom,
				panoId,
				provider: "google",
				flags: panoId ? panoFlags : LocationFlag.None,
				tags,
			};
		}

		if (url.searchParams.get("map_action") === "pano") {
			const vp = url.searchParams.get("viewpoint");
			if (!vp) return null;
			const parts = vp.split(",");
			const lat = parseFloat(parts[0] ?? "");
			const lng = parseFloat(parts[1] ?? "");
			const heading = parseFloat(url.searchParams.get("heading") ?? "0");
			const pitch = parseFloat(url.searchParams.get("pitch") ?? "0");
			const panoId = url.searchParams.get("pano") || null;
			const zoom = fovToZoom(parseFloat(url.searchParams.get("fov") ?? "90"));
			return {
				lat,
				lng,
				heading,
				pitch,
				zoom,
				panoId,
				provider: "google",
				flags: panoId ? panoFlags : LocationFlag.None,
				tags,
			};
		}

		if (url.searchParams.get("layer") === "c" && url.searchParams.has("cbll")) {
			const cbll = url.searchParams.get("cbll")?.split(",");
			if (cbll) {
				const lat = parseFloat(cbll[0] ?? "");
				const lng = parseFloat(cbll[1] ?? "");
				return {
					lat,
					lng,
					heading: 0,
					pitch: 0,
					zoom: 0,
					panoId: null,
					provider: "google",
					flags: LocationFlag.None,
					tags,
				};
			}
		}
	} else if (url.hostname.startsWith("artsandculture.google.") && url.searchParams.has("sv_pid")) {
		const lat = parseFloat(url.searchParams.get("sv_lat") ?? "0");
		const lng = parseFloat(url.searchParams.get("sv_lng") ?? "0");
		const heading = parseFloat(url.searchParams.get("sv_h") ?? "0");
		const pitch = parseFloat(url.searchParams.get("s_p") ?? "0");
		const panoId = url.searchParams.get("sv_pid");
		const zoom = parseFloat(url.searchParams.get("sv_z") ?? "0");
		return {
			lat,
			lng,
			heading,
			pitch,
			zoom,
			panoId,
			provider: "google",
			flags: LocationFlag.LoadAsPanoId,
			tags,
		};
	}

	return null;
}

async function parseLookmapLocation(url: URL): Promise<ParsedLocation | null> {
	const pov = parseLookmapUrl(url);
	if (!pov) return null;

	let lat = pov.lat;
	let lng = pov.lng;
	let heading = pov.heading;
	let pitch = pov.pitch;
	let panoId: string | null = null;

	try {
		const pano = await getClosestPano(lat, lng, META_OPEN);
		if (pano) {
			panoId = pano.panoid;
			lat = pano.lat;
			lng = pano.lon;
			// Keep share-link POV when present; only fill from pano when both are 0.
			if (heading === 0 && pitch === 0) {
				const povFromPano = headingPitchDeg(pano);
				heading = povFromPano.heading;
				pitch = povFromPano.pitch;
			}
		}
	} catch {
		/* keep POV-only pin */
	}

	return {
		lat,
		lng,
		heading,
		pitch,
		zoom: 0,
		panoId,
		provider: "apple" satisfies SvProvider,
		flags: panoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
		tags: [],
	};
}

async function parseBaiduLocation(url: URL): Promise<ParsedLocation | null> {
	const parsed = parseBaiduMapsUrl(url);
	if (!parsed) return null;

	let { lat, lng, heading, pitch } = parsed;
	const { panoId } = parsed;

	if (panoId) {
		try {
			// Prefer sdata when online, but fall back to path coords quickly when offline.
			const meta = await Promise.race([
				fetchBaiduMeta(panoId),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
			]);
			if (meta) {
				lat = meta.lat;
				lng = meta.lng;
				// Prefer URL POV when the share link included heading/pitch.
				if (heading === 0 && pitch === 0) {
					heading = meta.heading;
					pitch = meta.pitch;
				}
			}
		} catch {
			/* fall through to path coords */
		}
	}

	if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		return null;
	}

	return {
		lat,
		lng,
		heading,
		pitch,
		zoom: 0,
		panoId,
		provider: "baidu",
		flags: panoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
		tags: [],
	};
}

async function parseTencentLocation(url: URL): Promise<ParsedLocation | null> {
	const parsed = parseTencentShareUrl(url);
	if (!parsed?.panoId) return null;

	let lat: number | null = null;
	let lng: number | null = null;
	let heading = parsed.heading;
	const pitch = parsed.pitch;
	const panoId = parsed.panoId;

	try {
		const meta = await fetchTencentMeta(panoId);
		if (meta) {
			lat = meta.lat;
			lng = meta.lng;
			if (heading === 0 && pitch === 0) {
				heading = meta.heading;
			}
		}
	} catch {
		/* need meta for coords */
	}

	if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		return null;
	}

	return {
		lat,
		lng,
		heading,
		pitch,
		zoom: 0,
		panoId,
		provider: "tencent",
		flags: LocationFlag.LoadAsPanoId,
		tags: [],
	};
}

// One coordinate component: signed degrees, optional `°`, optional minutes (with
// `'`/`′`) and seconds (with `"`/`″`), optional N/S/E/W hemisphere. Markers are
// required for DMS/DDM so bare integers can't masquerade as degrees+minutes.
const COORD_COMPONENT = String.raw`([+-]?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*(?:(\d+(?:\.\d+)?)\s*["″]?)?)?\s*([NSEWnsew])?`;
const COORD_PAIR = new RegExp(`^${COORD_COMPONENT}\\s*[, ]\\s*${COORD_COMPONENT}$`);

/** Parse a single bare coordinate pair in decimal, DMS, or DDM form into a
 * single location. Returns null if the text isn't a recognizable lat/lng pair.
 * Examples: `41.17, 14.04`, `41.17 14.04`, `40°26'46"N 79°58'56"W`,
 * `40°26.7'N, 79°58.9'W`, `14.04 E, 41.17 N`. */
export function parseCoordinates(input: string): ParsedLocation | null {
	const m = COORD_PAIR.exec(input.trim());
	if (!m) return null;

	const component = (deg: string, min: string, sec: string, hemi: string) => {
		let val =
			parseFloat(deg) + (min ? parseFloat(min) / 60 : 0) + (sec ? parseFloat(sec) / 3600 : 0);
		const h = hemi?.toUpperCase();
		if (h === "S" || h === "W") val = -Math.abs(val);
		const axis = h === "N" || h === "S" ? "lat" : h === "E" || h === "W" ? "lng" : null;
		return { val, axis };
	};

	const a = component(m[1]!, m[2]!, m[3]!, m[4]!);
	const b = component(m[5]!, m[6]!, m[7]!, m[8]!);

	// Lat first by default; explicit hemispheres can flip the order (e.g. lng, lat).
	const swap = a.axis === "lng" || b.axis === "lat";
	const lat = swap ? b.val : a.val;
	const lng = swap ? a.val : b.val;
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

	return {
		lat,
		lng,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		provider: "google",
		flags: LocationFlag.None,
		tags: [],
	};
}

const URL_LINE = /^https?:\/\//;

/** Parse a multi-line paste as a list of Maps URLs. Returns parsed locations
 * (in input order) for all lines that resolved, via a concurrency-5 worker pool. */
export async function parseUrlList(input: string): Promise<ParsedLocation[]> {
	const lines = input
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0 || !URL_LINE.test(lines[0]!)) return [];

	const results: (ParsedLocation | null)[] = new Array(lines.length);
	let next = 0;
	const worker = async () => {
		while (next < lines.length) {
			const i = next++;
			results[i] = await parseMapsUrl(lines[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(5, lines.length) }, worker));
	return results.filter((r): r is ParsedLocation => r != null);
}

/** Serialize parsed locations as a standard import file (the same JSON shape the
 * importer already parses), so they can enter the staged import flow. */
export function parsedLocationsToImportJson(locs: ParsedLocation[], name: string): string {
	const customCoordinates = locs.map((l) => {
		// Importer semantics: top-level panoId implies LoadAsPanoId; extra.panoId doesn't.
		const storagePanoId = normalizeStoragePanoId(l.panoId);
		const loadAsPano = storagePanoId != null && (l.flags & LocationFlag.LoadAsPanoId) !== 0;
		const extra: Record<string, unknown> = {};
		if (l.tags.length > 0) extra.tags = l.tags;
		if (storagePanoId != null && !loadAsPano) extra.panoId = storagePanoId;
		const provider = (l.provider ?? "google") as SvProvider;
		const source = providerToWireSource(provider);
		return {
			lat: l.lat,
			lng: l.lng,
			heading: l.heading,
			pitch: l.pitch,
			zoom: l.zoom,
			...(loadAsPano ? { panoId: storagePanoId } : {}),
			...(source ? { source } : {}),
			...(Object.keys(extra).length > 0 ? { extra } : {}),
		};
	});
	return JSON.stringify({ name, customCoordinates });
}

export async function parseMapsUrl(input: string): Promise<ParsedLocation | null> {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return null;
	}

	try {
		if (url.hostname === "goo.gl" && url.pathname.startsWith("/maps/")) {
			url = await resolveShortUrl(url);
		} else if (url.hostname === "maps.app.goo.gl") {
			url = await resolveShortUrl(url);
		} else if (isBaiduShortHost(url.hostname)) {
			const expanded = await expandBaiduShortUrl(url);
			if (!expanded) return null;
			url = expanded;
		}
	} catch {
		return null;
	}

	if (isLookmapHost(url.hostname)) {
		return parseLookmapLocation(url);
	}
	if (isBaiduMapsHost(url.hostname)) {
		return parseBaiduLocation(url);
	}
	if (isTencentShareHost(url.hostname)) {
		return parseTencentLocation(url);
	}

	return parseExpandedMapsUrl(url);
}
