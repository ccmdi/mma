import { useEffect, useState, useCallback } from "react";
import type { LatLng, Bounds } from "@/types";
import { isWorldBounds, scoreTupleToBounds } from "@/types";
import { fetchBounds, useMapState } from "@/store/useMapStore";
import { subscribeMany, LOCATION_DATA_EVENTS } from "@/lib/events";
import { distMeters } from "@/lib/geo/geo";
import { boundsOfCoords } from "@/lib/map/host";
import { localeFormat } from "@/lib/util/format";

// --- Formatting utilities ---

const kmFmt = localeFormat<number>(
	(l) => new Intl.NumberFormat(l, { style: "unit", unit: "kilometer", maximumFractionDigits: 2 }),
);
const mFmt = localeFormat<number>(
	(l) => new Intl.NumberFormat(l, { style: "unit", unit: "meter", maximumFractionDigits: 0 }),
);

export function formatDistance(meters: number): string {
	return meters > 1000 ? kmFmt.format(meters / 1000) : mFmt.format(meters);
}

const SCORE_BASE = 0.99866017;
const DEFAULT_MAX_ERROR = 185.34781;

export function computeScore(
	distanceMeters: number,
	maxErrorDistance: number = DEFAULT_MAX_ERROR,
): number {
	if (distanceMeters <= 25) return 5000;
	const scale = maxErrorDistance * Math.log(SCORE_BASE) * -1e4;
	return Math.round(5000 * SCORE_BASE ** (distanceMeters / scale));
}

// --- Score bounds resolution ---

// World bounds constant (ACW): the resolved max-error for the whole world.
export const WORLD_MAX_ERROR = DEFAULT_MAX_ERROR;
type Bbox = [minLng: number, minLat: number, maxLng: number, maxLat: number];
const BBOX_TO_ERROR_DIVISOR = 7.458421;

export function bboxToMaxError(bbox: Bbox): number {
	const diagonalKm =
		distMeters({ lat: bbox[1], lng: bbox[0] }, { lat: bbox[3], lng: bbox[2] }) / 1000;
	return diagonalKm / BBOX_TO_ERROR_DIVISOR / -1e4 / Math.log(SCORE_BASE);
}

export function padBbox(bbox: Bbox): Bbox {
	const pad = 0.01;
	// An antimeridian-crossing box arrives as west > east; unwrap east past 180 so
	// the midpoint/pad math stays monotonic (haversine downstream is periodic-safe).
	const east = bbox[2] < bbox[0] ? bbox[2] + 360 : bbox[2];
	const out: Bbox = [bbox[0], bbox[1], east, bbox[3]];
	const cx = (out[0] + out[2]) / 2;
	const cy = (out[1] + out[3]) / 2;
	if (cx - pad < out[0]) out[0] = cx - pad;
	if (cy - pad < out[1]) out[1] = cy - pad;
	if (cx + pad > out[2]) out[2] = cx + pad;
	if (cy + pad > out[3]) out[3] = cy + pad;
	return out;
}

export function locationsBbox(locations: LatLng[]): Bbox {
	const b = boundsOfCoords(locations);
	const bbox: Bbox = b
		? [b.west, b.south, b.east, b.north]
		: [Infinity, Infinity, -Infinity, -Infinity];
	return padBbox(bbox);
}

export function resolveScoreMaxError(bounds: "auto" | Bounds, locations: LatLng[]): number {
	if (bounds === "auto") {
		return locations.length > 1 ? bboxToMaxError(locationsBbox(locations)) : 25;
	}
	if (isWorldBounds(bounds)) return WORLD_MAX_ERROR;
	return bboxToMaxError([bounds.west, bounds.south, bounds.east, bounds.north]);
}

export function resolveScoreMaxErrorFromBounds(
	bounds: "auto" | Bounds,
	autoLocationsBbox: Bbox | null,
): number {
	if (bounds === "auto") {
		return autoLocationsBbox ? bboxToMaxError(padBbox(autoLocationsBbox)) : 25;
	}
	if (isWorldBounds(bounds)) return WORLD_MAX_ERROR;
	return bboxToMaxError([bounds.west, bounds.south, bounds.east, bounds.north]);
}

/**
 * Reactive resolved max-error distance for the current map's score bounds.
 * In `"auto"` mode it tracks the locations' bounding box via the cheap
 * `store_bounds` command and refreshes on location mutations. This is the single
 * value that drives both the Scoring editor display and the measurement score.
 */
export function useScoreMaxError(): number {
	const map = useMapState((s) => s.map);
	const raw = map?.meta.scoreBounds ?? "auto";
	const bounds: "auto" | Bounds = typeof raw === "string" ? "auto" : scoreTupleToBounds(raw);
	const isAuto = bounds === "auto";
	const [autoBbox, setAutoBbox] = useState<Bbox | null>(null);

	const refresh = useCallback(async () => {
		const res = await fetchBounds({ type: "Everything" });
		setAutoBbox(res ?? null);
	}, []);

	useEffect(() => {
		if (!isAuto) return;
		void refresh();
		return subscribeMany(LOCATION_DATA_EVENTS, () => void refresh());
	}, [isAuto, refresh]);

	if (isAuto) return resolveScoreMaxErrorFromBounds("auto", autoBbox);
	return resolveScoreMaxErrorFromBounds(bounds, null);
}
