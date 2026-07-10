// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient module decl must be referenced so dts-bundle-generator pulls it into plugin type-gen
/// <reference path="../../types/measuretool.d.ts" />
import { useSyncExternalStore, useEffect, useState, useCallback } from "react";
import MeasureToolClass from "measuretool-googlemaps-v3";
import type { LatLng, Bounds } from "@/types";
import { isWorldBounds, scoreTupleToBounds } from "@/types";
import type { Location } from "@/bindings.gen";
import { createSyncStore } from "@/lib/util/syncStore";
import { useCurrentMap } from "@/store/useMapStore";
import { cmd } from "@/lib/commands";
import { subscribeMany, LOCATION_DATA_EVENTS } from "@/lib/events";

// --- Measure tool state ---

interface MeasureState {
	instance: InstanceType<typeof MeasureToolClass> | null;
	isMeasuring: boolean;
}

let mState: MeasureState = { instance: null, isMeasuring: false };
const mStore = createSyncStore();
function mSnap() {
	return mState;
}

function createInstance(map: google.maps.Map) {
	const mt = new MeasureToolClass(map, {
		contextMenu: false,
		showSegmentLength: false,
	});
	mt.addListener("measure_start", () => {
		mState = { ...mState, isMeasuring: true };
		mStore.notify();
	});
	mt.addListener("measure_end", () => {
		mState = { ...mState, isMeasuring: false };
		mStore.notify();
		queueMicrotask(() => map.setOptions({ draggableCursor: "crosshair" }));
	});
	return mt;
}

export function startMeasure(map: google.maps.Map, latLng: LatLng) {
	let { instance } = mState;
	if (!instance) {
		instance = createInstance(map);
		mState = { ...mState, instance };
		mStore.notify();
	}
	instance.start([latLng]);
}

export function endMeasure() {
	mState.instance?.end();
}

export function useMeasureState() {
	return useSyncExternalStore(mStore.subscribe, mSnap);
}

export function useMeasure() {
	const s = useMeasureState();
	useEffect(() => () => endMeasure(), []);
	return s;
}

// --- Lat/lng anchor state ---

let anchor: LatLng | null = null;
const aStore = createSyncStore();
function aSnap() {
	return anchor;
}

export function setLatLngAnchor(v: LatLng | null) {
	anchor = v;
	aStore.notify();
}

export function useLatLngAnchor() {
	return useSyncExternalStore(aStore.subscribe, aSnap);
}

export const subscribeLatLngAnchor = aStore.subscribe;

export function getLatLngAnchor() {
	return anchor;
}

// --- Context menu target ---

export interface ContextMenuTarget {
	location: Location | null;
	latLng: LatLng;
}

let cmTarget: ContextMenuTarget = { location: null, latLng: { lat: 0, lng: 0 } };

export function openContextMenuLatLng(latLng: LatLng) {
	cmTarget = { location: null, latLng };
}

export function openContextMenuLocation(loc: Location) {
	cmTarget = { location: loc, latLng: { lat: loc.lat, lng: loc.lng } };
}

export function getContextMenuTarget() {
	return cmTarget;
}

// --- Formatting utilities ---

const kmFmt = new Intl.NumberFormat(["en"], {
	style: "unit",
	unit: "kilometer",
	maximumFractionDigits: 2,
});
const mFmt = new Intl.NumberFormat(["en"], {
	style: "unit",
	unit: "meter",
	maximumFractionDigits: 0,
});

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
const TURF_EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in km between two [lng, lat] points (turf-compatible). */
function haversineKm(a: [number, number], b: [number, number]): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(b[1] - a[1]);
	const dLng = toRad(b[0] - a[0]);
	const lat1 = toRad(a[1]);
	const lat2 = toRad(b[1]);
	const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
	return (2 * TURF_EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))) / 1000;
}

export function bboxToMaxError(bbox: Bbox): number {
	const diagonalKm = haversineKm([bbox[0], bbox[1]], [bbox[2], bbox[3]]);
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
	const bbox: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
	for (const l of locations) {
		if (l.lng < bbox[0]) bbox[0] = l.lng;
		if (l.lat < bbox[1]) bbox[1] = l.lat;
		if (l.lng > bbox[2]) bbox[2] = l.lng;
		if (l.lat > bbox[3]) bbox[3] = l.lat;
	}
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
	const map = useCurrentMap();
	const raw = map?.meta.scoreBounds ?? "auto";
	const bounds: "auto" | Bounds = typeof raw === "string" ? "auto" : scoreTupleToBounds(raw);
	const isAuto = bounds === "auto";
	const [autoBbox, setAutoBbox] = useState<Bbox | null>(null);

	const refresh = useCallback(async () => {
		const res = await cmd.storeBounds(false);
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
