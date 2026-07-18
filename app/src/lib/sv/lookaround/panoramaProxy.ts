/**
 * Duck-typed StreetViewPanorama over the Look Around PhotoSphere viewer.
 *
 * Warm path mirrors lookaround-map: a single vendor `updateMarkers` fetch
 * (`/closest?radius=100&limit=1000&meta=cam,ele,tz`) feeds movement markers,
 * alternate dates, and MMA links ? no second plugin-side closest sweep.
 */
import { getActiveLocation } from "@/store/useMapStore";
import { log } from "@/lib/util/log";
import type { LookaroundPano } from "./api";
import { META_OPEN } from "./api";
import { getClosestPano, rememberPanos } from "./tile";
import {
	buildLinksFromNearby,
	formatImageDateYm,
	getAlternativeDates,
	inferCameraType,
	panoHeightM,
	panoTimestampMs,
} from "./panoExtra";
import { patchLocationExtra } from "./patchExtra";
import type { PanoViewerHandle } from "./viewer";

type ListenerMap = Map<string, Set<() => void>>;

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

/** Matches the app's `PanoDateEntry` structurally. */
export interface PanoDateEntry {
	pano: string;
	timestamp: number;
	cameraType?: string;
}

export type LookAroundViewerLike = PanoViewerHandle;

export interface LookAroundPanoramaProxy {
	panorama: google.maps.StreetViewPanorama & { __destroyProxy?: () => void };
	getAlternateDates(): PanoDateEntry[];
	subscribeAlternateDates(cb: () => void): () => void;
	getAltitude(): number | null;
	spawnPanoId: string;
	destroy(): void;
}

function readLatLng(latLng: google.maps.LatLng | google.maps.LatLngLiteral): {
	lat: number;
	lng: number;
} | null {
	const lat = typeof latLng.lat === "function" ? latLng.lat() : latLng.lat;
	const lng = typeof latLng.lng === "function" ? latLng.lng() : latLng.lng;
	if (typeof lat !== "number" || typeof lng !== "number") return null;
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng };
}

function toGoogleLatLng(lat: number, lng: number): google.maps.LatLng {
	const g = (globalThis as { google?: typeof google }).google;
	if (g?.maps?.LatLng) return new g.maps.LatLng(lat, lng);
	return {
		lat: () => lat,
		lng: () => lng,
		toJSON: () => ({ lat, lng }),
	} as google.maps.LatLng;
}

function normDeg(d: number): number {
	return ((d % 360) + 360) % 360;
}

function cameraLabel(pano: LookaroundPano): string {
	return inferCameraType(pano);
}

function buildDateEntries(ref: LookaroundPano, nearby: LookaroundPano[]): PanoDateEntry[] {
	const alts = getAlternativeDates(ref, nearby);
	const dates: PanoDateEntry[] = [];
	const seen = new Set<string>();
	const push = (p: LookaroundPano) => {
		const ts = panoTimestampMs(p);
		if (ts == null || seen.has(p.panoid)) return;
		seen.add(p.panoid);
		dates.push({ pano: p.panoid, timestamp: ts, cameraType: cameraLabel(p) });
	};
	push(ref);
	for (const a of alts) push(a);
	dates.sort((a, b) => a.timestamp - b.timestamp);
	return dates;
}

function entryForPano(p: LookaroundPano): PanoDateEntry | null {
	const ts = panoTimestampMs(p);
	if (ts == null) return null;
	return { pano: p.panoid, timestamp: ts, cameraType: cameraLabel(p) };
}

/** Keep the live pano in the date list so camera badges stay accurate while moving. */
function withCurrentPanoEntry(entries: PanoDateEntry[], current: LookaroundPano): PanoDateEntry[] {
	const entry = entryForPano(current);
	if (!entry) return entries;
	const idx = entries.findIndex((e) => e.pano === current.panoid);
	if (idx >= 0) {
		const next = [...entries];
		next[idx] = { ...next[idx]!, ...entry };
		return next;
	}
	return [...entries, entry].sort((a, b) => a.timestamp - b.timestamp);
}

export function createLookAroundPanoramaProxy(
	viewer: LookAroundViewerLike,
	initial: LookaroundPano,
): LookAroundPanoramaProxy {
	let pano = initial;
	const spawnPanoId = initial.panoid;
	viewer.currentPano = initial;
	const listeners: ListenerMap = new Map();
	let zoom = 1;

	const panoById = new Map<string, LookaroundPano>([[initial.panoid, initial]]);
	const dateListeners = new Set<() => void>();

	const seedTs = panoTimestampMs(initial);
	let alternateDates: PanoDateEntry[] =
		seedTs != null
			? [{ pano: initial.panoid, timestamp: seedTs, cameraType: cameraLabel(initial) }]
			: [];

	let links: google.maps.StreetViewLink[] = [];

	const emit = (event: string) => {
		const set = listeners.get(event);
		if (!set) return;
		for (const cb of [...set]) cb();
	};

	const onPsvPosition = () => emit("pov_changed");
	const onPsvZoom = () => {
		zoom = viewer.getZoomLevel() / 50;
		emit("zoom_changed");
	};

	viewer.addEventListener("position-updated", onPsvPosition);
	viewer.addEventListener("zoom-updated", onPsvZoom);

	const applyNearby = (ref: LookaroundPano, nearby: LookaroundPano[]) => {
		rememberPanos([ref, ...nearby]);
		for (const p of nearby) panoById.set(p.panoid, p);
		panoById.set(ref.panoid, ref);
		if (ref.panoid === pano.panoid) {
			pano = { ...pano, ...ref };
			viewer.currentPano = pano;
		}
		panoById.set(pano.panoid, pano);
		alternateDates = withCurrentPanoEntry(buildDateEntries(pano, nearby), pano);
		links = buildLinksFromNearby(pano, nearby);
		for (const cb of [...dateListeners]) cb();
		emit("links_changed");

		// Altitude only ??do not rewrite spawn cameraType from a historical neighbor.
		const active = getActiveLocation();
		if (active) {
			const height = panoHeightM(pano);
			const patch: Record<string, unknown> = {};
			if (height != null) patch.altitude = height;
			if (pano.timezone) patch.timezone = pano.timezone;
			const ts = panoTimestampMs(pano);
			if (ts != null && pano.panoid === spawnPanoId) {
				patch.imageDate = formatImageDateYm(ts, pano.timezone);
				patch.datetime = Math.floor(ts / 1000);
			}
			if (Object.keys(patch).length) void patchLocationExtra(active, patch);
		}
	};

	viewer.nearbyPanosChangedCallback = (ref, nearby) => {
		applyNearby(ref, nearby);
	};

	// Fallback if an older viewer.js has no nearbyPanosChangedCallback wiring.
	viewer.alternativeDatesChangedCallback = (dates) => {
		for (const d of dates) {
			const ts = panoTimestampMs(d);
			if (ts == null) continue;
			panoById.set(d.panoid, d);
			if (!alternateDates.some((e) => e.pano === d.panoid)) {
				alternateDates.push({
					pano: d.panoid,
					timestamp: ts,
					cameraType: cameraLabel(d),
				});
			}
		}
		alternateDates.sort((a, b) => a.timestamp - b.timestamp);
		alternateDates = withCurrentPanoEntry(alternateDates, pano);
		for (const cb of [...dateListeners]) cb();
	};

	const origNavigate = viewer.navigateTo?.bind(viewer);
	if (origNavigate) {
		viewer.navigateTo = async (next, resetView) => {
			try {
				await origNavigate(next, resetView);
			} catch (e) {
				log.warn("[lookaround] navigateTo (vendor markers) failed:", e);
			}
			pano = next;
			viewer.currentPano = next;
			panoById.set(next.panoid, next);
			alternateDates = withCurrentPanoEntry(alternateDates, next);
			for (const cb of [...dateListeners]) cb();
			// Vendor updateMarkers already runs inside navigateTo ? no second /closest.
			emit("pano_changed");
			emit("position_changed");
			emit("status_changed");
		};
	}

	const boot = () => {
		for (const cb of [...dateListeners]) cb();
		emit("status_changed");
		emit("pov_changed");
		// Vendor createPanoViewer already kicked updateMarkers(initial) ??wait for callback.
	};
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => setTimeout(boot, 0));
	} else {
		setTimeout(boot, 0);
	}

	const api = {
		getPov: () => {
			const pos = viewer.getPosition();
			return {
				heading: normDeg(pos.yaw * RAD2DEG),
				pitch: pos.pitch * RAD2DEG,
			};
		},
		setPov: (pov: google.maps.StreetViewPov) => {
			viewer.rotate({
				yaw: (pov.heading ?? 0) * DEG2RAD,
				pitch: (pov.pitch ?? 0) * DEG2RAD,
			});
			emit("pov_changed");
		},
		getZoom: () => zoom,
		setZoom: (z: number) => {
			zoom = z;
			viewer.zoom(Math.max(0, Math.min(100, z * 50)));
			emit("zoom_changed");
		},
		getPosition: () => toGoogleLatLng(pano.lat, pano.lon),
		setPosition: (latLng: google.maps.LatLng | google.maps.LatLngLiteral) => {
			const ll = readLatLng(latLng);
			if (!ll) return;
			void getClosestPano(ll.lat, ll.lng, META_OPEN).then((next) => {
				if (next) void viewer.navigateTo?.(next, false);
			});
		},
		getPano: () => pano.panoid,
		setPano: (id: string) => {
			const target = panoById.get(id);
			if (!target || target.panoid === pano.panoid) return;
			void viewer.navigateTo?.(target, false);
		},
		getLocation: () =>
			({
				description: "Apple Look Around",
				pano: pano.panoid,
				latLng: api.getPosition(),
			}) as google.maps.StreetViewLocation,
		getLinks: () => links,
		getStatus: () => "OK" as google.maps.StreetViewStatus,
		setVisible: (_v: boolean) => {},
		getVisible: () => true,
		setOptions: (_opts: google.maps.StreetViewPanoramaOptions) => {},
		addListener: (eventName: string, handler: () => void) => {
			let set = listeners.get(eventName);
			if (!set) {
				set = new Set();
				listeners.set(eventName, set);
			}
			set.add(handler);
			if (eventName === "status_changed") {
				queueMicrotask(() => handler());
			}
			return { remove: () => set!.delete(handler) } as google.maps.MapsEventListener;
		},
		__destroyProxy: () => {
			viewer.removeEventListener("position-updated", onPsvPosition);
			viewer.removeEventListener("zoom-updated", onPsvZoom);
			viewer.alternativeDatesChangedCallback = () => {};
			viewer.nearbyPanosChangedCallback = () => {};
			listeners.clear();
			dateListeners.clear();
		},
	};

	return {
		panorama: api as unknown as google.maps.StreetViewPanorama & { __destroyProxy?: () => void },
		getAlternateDates: () => withCurrentPanoEntry(alternateDates, pano),
		subscribeAlternateDates: (cb: () => void) => {
			dateListeners.add(cb);
			queueMicrotask(() => cb());
			return () => dateListeners.delete(cb);
		},
		getAltitude: () => panoHeightM(pano),
		spawnPanoId,
		destroy: () => api.__destroyProxy(),
	};
}
