import { useEffect } from "react";
import type { LatLng } from "@/types";
import type { MapHost } from "@/lib/map/mapHost";
import { bindNodePath } from "@/lib/map/nodePath";
import { distMeters } from "@/lib/geo/geo";
import { formatDistance } from "@/lib/util/format";
import { emit as emitEvent, useEventValue } from "@/lib/events";

interface MeasureState {
	/** Placed nodes, [lng, lat]. The line spans these and nothing else -- no segment
	 *  chases the cursor. */
	points: number[][];
	isMeasuring: boolean;
}

let mState: MeasureState = { points: [], isMeasuring: false };
let segments: { at: number[]; label: string }[] = [];
let segmentsFor: number[][] | null = null;
let anchor: LatLng | null = null;

function commit(next: Partial<MeasureState>) {
	mState = { ...mState, ...next };
	emitEvent("measure:changed");
}

/** The map's distance tool: a path of placed nodes and its length, plus the lat/lng
 *  anchor lines. */
export const Measure = {
	start: (latLng: LatLng) => {
		commit({ points: [[latLng.lng, latLng.lat]], isMeasuring: true });
	},

	end: () => {
		if (!mState.isMeasuring) return;
		commit({ points: [], isMeasuring: false });
	},

	add: (latLng: LatLng) => {
		if (!mState.isMeasuring) return;
		commit({ points: [...mState.points, [latLng.lng, latLng.lat]] });
	},

	move: (index: number, latLng: LatLng) => {
		if (index < 0 || index >= mState.points.length) return;
		const points = [...mState.points];
		points[index] = [latLng.lng, latLng.lat];
		commit({ points });
	},

	remove: (index: number) => {
		if (index < 0 || index >= mState.points.length) return;
		commit({ points: mState.points.toSpliced(index, 1) });
	},

	points: (): number[][] => mState.points,

	/** One label per segment, at its midpoint. Rebuilt only when the points change, and
	 *  there are never many of them. */
	segments: (): { at: number[]; label: string }[] => {
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
	},

	/** Total great-circle length of the placed path. */
	length: (): number => {
		const pts = mState.points;
		let total = 0;
		for (let i = 1; i < pts.length; i++) {
			total += distMeters(
				{ lat: pts[i - 1][1], lng: pts[i - 1][0] },
				{ lat: pts[i][1], lng: pts[i][0] },
			);
		}
		return total;
	},

	useActive: (): boolean => useEventValue("measure:changed", () => mState.isMeasuring),

	useLength: (): number => useEventValue("measure:changed", Measure.length),

	/** Binds the drawing interaction while a measurement is running: click to place a node,
	 *  drag a node to move it, click or Backspace/Delete to remove one, Escape to finish. */
	useInteraction: (host: MapHost | null) => {
		const isMeasuring = Measure.useActive();

		useEffect(() => {
			if (!host || !isMeasuring) return;
			return bindNodePath(host, {
				points: Measure.points,
				add: Measure.add,
				move: Measure.move,
				remove: Measure.remove,
				cancel: Measure.end,
			});
		}, [host, isMeasuring]);
	},

	anchor: (): LatLng | null => anchor,

	setAnchor: (v: LatLng | null) => {
		anchor = v;
		emitEvent("anchor:changed");
	},
};
