import { runConcurrent } from "@/lib/util/concurrent";
import { LocationFlag } from "@/bindings.consts";
import type { ParsedLocation } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

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
	if (lines.length === 0 || !URL_LINE.test(lines[0])) return [];

	const results: (ParsedLocation | null)[] = new Array(lines.length);
	await runConcurrent(
		lines,
		async (line, i) => {
			results[i] = await cmd.parseMapsUrl(line);
		},
		{ concurrency: 5 },
	);
	return results.filter((r): r is ParsedLocation => r != null);
}

/** Serialize parsed locations as a standard import file (the same JSON shape the
 * importer already parses), so they can enter the staged import flow. */
export function parsedLocationsToImportJson(locs: ParsedLocation[], name: string): string {
	const customCoordinates = locs.map((l) => {
		// Importer semantics: top-level panoId implies LoadAsPanoId; extra.panoId doesn't.
		const loadAsPano = l.panoId != null && (l.flags & LocationFlag.LoadAsPanoId) !== 0;
		const extra: Record<string, unknown> = {};
		if (l.tags.length > 0) extra.tags = l.tags;
		if (l.panoId != null && !loadAsPano) extra.panoId = l.panoId;
		return {
			lat: l.lat,
			lng: l.lng,
			heading: l.heading,
			pitch: l.pitch,
			zoom: l.zoom,
			...(loadAsPano ? { panoId: l.panoId } : {}),
			...(Object.keys(extra).length > 0 ? { extra } : {}),
		};
	});
	return JSON.stringify({ name, customCoordinates });
}

