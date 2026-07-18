/**
 * Map lookmap `/closest` pano JSON onto MMA location `extra` fields.
 * Enrich/export fields mirror Google SV semantics; `location.provider` + `location.panoId`
 * route the location to the Look Around viewer.
 */
import type { LookaroundPano } from "./api";
import type { LocationSvExtra } from "@/lib/sv/providers/types";
import { isAppleLocation } from "@/lib/sv/providers/types";

/** Google SV `PanoType.Official` — Apple Look Around panoramas are official coverage. */
const PANO_TYPE_OFFICIAL = 2;

/** Matches lookaround-map `CoverageType`. */
export const CoverageType = {
	Car: 2,
	Trekker: 3,
} as const;

export type LookAroundCameraType = "bigcam" | "smallcam" | "lowcam" | "backpack";

export { isAppleLocation as isLookAroundLocation };

function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
	return Math.abs(a - b) < epsilon;
}

/** Derive Apple camera hardware from lookmap cameraMetadata.cy / coverageType. */
export function inferCameraType(pano: LookaroundPano): LookAroundCameraType {
	if (pano.coverageType === CoverageType.Trekker) return "backpack";

	const cy = pano.cameraMetadata?.[0]?.cy;
	if (cy == null || !Number.isFinite(cy)) {
		return "bigcam";
	}

	if (approxEqual(cy, 0.27488935)) return "bigcam";
	if (approxEqual(cy, 0.30543262)) {
		if (pano.timestamp != null && pano.timestamp > 1_704_067_200_000) return "smallcam";
		if (pano.timezone === "Europe/Zurich") return "lowcam";
		return "smallcam";
	}
	if (approxEqual(cy, 0.36215582)) return "lowcam";
	return "bigcam";
}

export function panoHeightM(pano: LookaroundPano): number | null {
	for (const v of [pano.elevation, pano.altitude]) {
		if (typeof v === "number" && Number.isFinite(v)) return v;
	}
	return null;
}

/** Capture timestamp in ms (lookmap `timestamp`). */
export function panoTimestampMs(pano: LookaroundPano): number | null {
	if (typeof pano.timestamp === "number" && Number.isFinite(pano.timestamp) && pano.timestamp > 0) {
		return pano.timestamp;
	}
	return null;
}

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatFor(timezone: string | undefined): Intl.DateTimeFormat {
	const tz = timezone || "UTC";
	let fmt = dateFmtCache.get(tz);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeZone: tz });
		dateFmtCache.set(tz, fmt);
	}
	return fmt;
}

const ymFmtCache = new Map<string, Intl.DateTimeFormat>();

/** Google SV `imageDate` format: `YYYY-MM` in the pano timezone when known. */
export function formatImageDateYm(tsMs: number, timezone?: string | null): string {
	const tz = timezone || "UTC";
	try {
		let fmt = ymFmtCache.get(tz);
		if (!fmt) {
			fmt = new Intl.DateTimeFormat("en-CA", {
				timeZone: tz,
				year: "numeric",
				month: "2-digit",
			});
			ymFmtCache.set(tz, fmt);
		}
		return fmt.format(new Date(tsMs)).slice(0, 7);
	} catch {
		const d = new Date(tsMs);
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
	}
}

export function buildPanoExtra(pano: LookaroundPano): LocationSvExtra {
	const extra: LocationSvExtra = {};
	const height = panoHeightM(pano);
	if (height != null) extra.altitude = height;

	const tsMs = panoTimestampMs(pano);
	if (tsMs != null) {
		extra.imageDate = formatImageDateYm(tsMs, pano.timezone);
		extra.datetime = Math.floor(tsMs / 1000);
	}
	if (pano.timezone) extra.timezone = pano.timezone;

	extra.panoType = PANO_TYPE_OFFICIAL;

	if (pano.heading != null && Number.isFinite(pano.heading)) {
		const appleDeg = (pano.heading * 180) / Math.PI;
		extra.drivingDirection = appleHeadingToGoogle(appleDeg);
	}

	extra.cameraType = inferCameraType(pano);
	return extra;
}

export function headingPitchDeg(pano: LookaroundPano): { heading: number; pitch: number } {
	const appleDeg = pano.heading != null ? (pano.heading * 180) / Math.PI : 0;
	return {
		heading: appleHeadingToGoogle(appleDeg),
		pitch: pano.pitch != null ? (pano.pitch * 180) / Math.PI : 0,
	};
}

export function appleHeadingToGoogle(appleDeg: number): number {
	return (((-appleDeg) % 360) + 360) % 360;
}

export function googleHeadingToApple(googleDeg: number): number {
	return (((-googleDeg) % 360) + 360) % 360;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371000;
	const φ1 = (lat1 * Math.PI) / 180;
	const φ2 = (lat2 * Math.PI) / 180;
	const Δφ = ((lat2 - lat1) * Math.PI) / 180;
	const Δλ = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const φ1 = (lat1 * Math.PI) / 180;
	const φ2 = (lat2 * Math.PI) / 180;
	const Δλ = ((lon2 - lon1) * Math.PI) / 180;
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function getAlternativeDates(
	refPano: LookaroundPano,
	nearbyPanos: LookaroundPano[],
): LookaroundPano[] {
	const ts = panoTimestampMs(refPano);
	if (ts == null) return [];
	const MAX_DISTANCE_M = 20;
	const dateTimeFormat = dateTimeFormatFor(refPano.timezone);
	const refDate = dateTimeFormat.format(new Date(ts));
	const best = new Map<string, { pano: LookaroundPano; dist: number }>();

	for (const pano of nearbyPanos) {
		const pts = panoTimestampMs(pano);
		if (pts == null || pano.panoid === refPano.panoid) continue;
		const date = dateTimeFormat.format(new Date(pts));
		if (refDate === date) continue;
		const dist = haversineM(refPano.lat, refPano.lon, pano.lat, pano.lon);
		if (dist > MAX_DISTANCE_M) continue;
		const prev = best.get(date);
		if (!prev || prev.dist > dist) best.set(date, { pano, dist });
	}

	return [...best.values()]
		.map((v) => v.pano)
		.sort((a, b) => (panoTimestampMs(a) ?? 0) - (panoTimestampMs(b) ?? 0));
}

export function buildLinksFromNearby(
	ref: LookaroundPano,
	nearby: LookaroundPano[],
	maxLinks = 8,
): google.maps.StreetViewLink[] {
	const candidates: { link: google.maps.StreetViewLink; dist: number }[] = [];
	for (const n of nearby) {
		if (n.panoid === ref.panoid) continue;
		const dist = haversineM(ref.lat, ref.lon, n.lat, n.lon);
		if (dist < 3) continue;
		candidates.push({
			dist,
			link: {
				description: "",
				heading: bearingDeg(ref.lat, ref.lon, n.lat, n.lon),
				pano: n.panoid,
			},
		});
	}
	candidates.sort((a, b) => a.dist - b.dist);
	const kept: google.maps.StreetViewLink[] = [];
	for (const c of candidates) {
		const h = c.link.heading ?? 0;
		if (
			kept.some((k) => {
				const d = Math.abs((((k.heading ?? 0) - h + 540) % 360) - 180);
				return Math.abs(d) < 25;
			})
		) {
			continue;
		}
		kept.push(c.link);
		if (kept.length >= maxLinks) break;
	}
	return kept;
}
