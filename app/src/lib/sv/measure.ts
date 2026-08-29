import { useEffect } from "react";
import type { LatLng } from "@/types";
import type { MapHost } from "@/lib/map/host";
import { addClickInterceptor } from "@/lib/map/mapState";
import { latLngToWorld } from "@/lib/geo/mercator";
import { distMeters } from "@/lib/geo/geo";
import { formatDistance } from "@/lib/util/format";
import { emit as emitEvent, useEventValue } from "@/lib/events";

// --- Measure tool state ---

/** Screen-pixel hit radius of a node -- also its drawn radius, so what you see is
 *  what you can grab. */
export const MEASURE_NODE_PX = 6;

interface MeasureState {
	/** Placed nodes, [lng, lat]. The line spans these and nothing else -- no segment
	 *  chases the cursor. */
	points: number[][];
	isMeasuring: boolean;
}

let mState: MeasureState = { points: [], isMeasuring: false };
let dragIndex: number | null = null;
let suppressClick = false;
let segments: { at: number[]; label: string }[] = [];
let segmentsFor: number[][] | null = null;

function commit(next: Partial<MeasureState>) {
	mState = { ...mState, ...next };
	emitEvent("measure:changed");
}

export function startMeasure(latLng: LatLng) {
	dragIndex = null;
	suppressClick = false;
	commit({ points: [[latLng.lng, latLng.lat]], isMeasuring: true });
}

export function endMeasure() {
	if (!mState.isMeasuring) return;
	dragIndex = null;
	commit({ points: [], isMeasuring: false });
}

export function addMeasurePoint(latLng: LatLng) {
	if (!mState.isMeasuring) return;
	commit({ points: [...mState.points, [latLng.lng, latLng.lat]] });
}

export function moveMeasureNode(index: number, latLng: LatLng) {
	if (index < 0 || index >= mState.points.length) return;
	const points = [...mState.points];
	points[index] = [latLng.lng, latLng.lat];
	commit({ points });
}

export function getMeasurePoints(): number[][] {
	return mState.points;
}

/** One label per segment, at its midpoint. Rebuilt only when the points change, and
 *  there are never many of them. */
export function getMeasureSegments(): { at: number[]; label: string }[] {
	if (segmentsFor !== mState.points) {
		const pts = mState.points;
		segments = [];
		for (let i = 1; i < pts.length; i++) {
			const [aLng, aLat] = pts[i - 1];
			const [rawLng, bLat] = pts[i];
			// Take the short way round so a segment across the antimeridian labels mid-span.
			const bLng = Math.abs(rawLng - aLng) > 180 ? rawLng + (rawLng < aLng ? 360 : -360) : rawLng;
			segments.push({
				at: [(aLng + bLng) / 2, (aLat + bLat) / 2],
				label: formatDistance(
					distMeters({ lat: aLat, lng: aLng }, { lat: pts[i][1], lng: pts[i][0] }),
				),
			});
		}
		segmentsFor = pts;
	}
	return segments;
}

/** Total great-circle length of the placed path. */
export function measureLength(): number {
	const pts = mState.points;
	let total = 0;
	for (let i = 1; i < pts.length; i++) {
		total += distMeters(
			{ lat: pts[i - 1][1], lng: pts[i - 1][0] },
			{ lat: pts[i][1], lng: pts[i][0] },
		);
	}
	return total;
}

/** Index of the node within grab range of `ll`, latest first so stacked nodes peel off. */
function hitNode(host: MapHost, ll: LatLng): number | null {
	const scale = 2 ** host.getZoom();
	const a = latLngToWorld(ll);
	for (let i = mState.points.length - 1; i >= 0; i--) {
		const b = latLngToWorld({ lat: mState.points[i][1], lng: mState.points[i][0] });
		if (Math.hypot((a.x - b.x) * scale, (a.y - b.y) * scale) <= MEASURE_NODE_PX) return i;
	}
	return null;
}

export function useIsMeasuring(): boolean {
	return useEventValue("measure:changed", () => mState.isMeasuring);
}

export function useMeasureLength(): number {
	return useEventValue("measure:changed", measureLength);
}

/** `useIsMeasuring` for the map surface, which also owns ending the measurement. */
export function useMeasure(): boolean {
	const isMeasuring = useIsMeasuring();
	useEffect(() => () => endMeasure(), []);
	return isMeasuring;
}

/** Binds the drawing interaction while a measurement is running: click to place a node,
 *  drag a node to move it, Escape to finish. */
export function useMeasureInteraction(host: MapHost | null) {
	const isMeasuring = useIsMeasuring();

	useEffect(() => {
		if (!host || !isMeasuring) return;

		const offClick = addClickInterceptor((lat, lng) => {
			if (suppressClick) suppressClick = false;
			else addMeasurePoint({ lat, lng });
			return true;
		});

		// Raw DOM events, not host events: the engine's gesture handler stops emitting map
		// mousemove the instant a button goes down, which strands the node after one frame.
		const div = host.container;
		const at = (e: PointerEvent): LatLng | null => {
			const r = div.getBoundingClientRect();
			return host.containerPxToLatLng(e.clientX - r.left, e.clientY - r.top);
		};

		// Panning is disabled on hover rather than on press: by mousedown the engine has
		// already claimed the gesture and won't give it up.
		let armed = false;
		const arm = (v: boolean) => {
			if (armed === v) return;
			armed = v;
			host.setDraggable(!v);
			host.setCursor(v ? "pointer" : null);
		};

		const onDown = (e: PointerEvent) => {
			// A drag's click doesn't always fire (the engine drops it after real movement);
			// a new gesture starting means the stale flag must not eat this one's click.
			suppressClick = false;
			if (e.button !== 0) return;
			const ll = at(e);
			dragIndex = ll ? hitNode(host, ll) : null;
		};

		const onMove = (e: PointerEvent) => {
			const ll = at(e);
			if (!ll) return;
			if (dragIndex === null) {
				arm(hitNode(host, ll) !== null);
				return;
			}
			moveMeasureNode(dragIndex, ll);
		};

		const onUp = () => {
			if (dragIndex === null) return;
			dragIndex = null;
			suppressClick = true;
		};

		// Bubble phase: an Escape aimed at something above us (dialogs preventDefault in
		// capture, open inputs stopPropagation) must not also discard the measurement.
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			endMeasure();
		};

		const ac = new AbortController();
		const { signal } = ac;
		div.addEventListener("pointerdown", onDown, { signal });
		// On window, so a drag that runs past the map edge keeps tracking.
		window.addEventListener("pointermove", onMove, { signal });
		window.addEventListener("pointerup", onUp, { signal });
		document.addEventListener("keydown", onKey, { signal });

		return () => {
			offClick();
			ac.abort();
			dragIndex = null;
			host.setDraggable(true);
			host.setCursor(null);
		};
	}, [host, isMeasuring]);
}

// --- Lat/lng anchor state ---

let anchor: LatLng | null = null;

export function setLatLngAnchor(v: LatLng | null) {
	anchor = v;
	emitEvent("anchor:changed");
}

export function getLatLngAnchor() {
	return anchor;
}
