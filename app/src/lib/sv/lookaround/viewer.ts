import { getGoogleMap } from "@/lib/map/mapState";
import type { LookaroundPano } from "./api";
import { LookaroundApi, META_OPEN } from "./api";
import { getClosestPano, resolvePanoForLocation } from "./tile";

export const InitialOrientation = {
	North: 0,
	Road: 1,
} as const;

export const AdditionalMetadata = {
	Orientation: "ori",
	CameraMetadata: "cam",
	Elevation: "ele",
	TimeZone: "tz",
} as const;

/** lookaround-map ImageFormat.JPEG — lookmap serves JPEG faces. */
const ImageFormatJpeg = 0;

export interface PanoViewerHandle {
	navigateTo(
		pano: LookaroundPano,
		resetView?: boolean,
		showLoader?: boolean,
		position?: { yaw: number; pitch: number },
	): Promise<void>;
	destroy(): void;
	getPosition(): { yaw: number; pitch: number };
	getZoomLevel(): number;
	rotate(position: { yaw?: number | string; pitch?: number | string }): void;
	zoom(level: number): void;
	addEventListener(name: string, cb: (...args: unknown[]) => void): void;
	removeEventListener(name: string, cb: (...args: unknown[]) => void): void;
	alternativeDatesChangedCallback: (dates: LookaroundPano[]) => void;
	nearbyPanosChangedCallback: (ref: LookaroundPano, nearby: LookaroundPano[]) => void;
	currentPano?: LookaroundPano;
}

export type ViewerBases = {
	/** lookmap.skzk.dev — `/pano/...` and `/closest` metadata. */
	lookmapBaseUrl: string;
};

/**
 * PSV checks `getComputedStyle(container).getPropertyValue('--psv-*-loaded')`.
 * Those vars live on `.psv-container` in the CSS, but the check runs on our host
 * before that class exists — set them inline (CSS loads with the viewer chunk).
 */
function ensurePsvCssVars(container: HTMLElement): void {
	container.style.setProperty("--psv-core-loaded", "true");
	container.style.setProperty("--psv-markers-plugin-loaded", "true");
	container.style.setProperty("--psv-compass-plugin-loaded", "true");
}

/** Ensure cam/ele/ori/tz for the viewer (lookmap META_OPEN). Skip when already complete. */
export async function enrichPanoForViewer(seed: LookaroundPano): Promise<LookaroundPano> {
	const needsCam = !seed.cameraMetadata?.length || seed.heading == null;
	const needsEle = seed.elevation == null && seed.altitude == null;
	const needsTz = !seed.timezone;
	if (!needsCam && !needsEle && !needsTz) return seed;
	const pano = await resolvePanoForLocation(seed.lat, seed.lon, seed.panoid, META_OPEN);
	if (!pano) throw new Error("Look Around returned no panorama metadata");
	return { ...seed, ...pano };
}

export async function openPanoAtLatLng(
	container: HTMLElement,
	bases: ViewerBases,
	lat: number,
	lng: number,
): Promise<PanoViewerHandle> {
	const pano = await getClosestPano(lat, lng, META_OPEN);
	if (!pano) {
		throw new Error("No Apple Look Around coverage near this location");
	}
	return openPano(container, bases, pano);
}

export async function openPano(
	container: HTMLElement,
	bases: ViewerBases,
	pano: LookaroundPano,
): Promise<PanoViewerHandle> {
	const full = await enrichPanoForViewer(pano);
	// Default elevation so movement markers never compute NaN ENU / SVG arcs.
	if (full.elevation == null && full.altitude == null) full.elevation = 0;
	else if (full.elevation == null) full.elevation = full.altitude;

	ensurePsvCssVars(container);
	container.replaceChildren();
	ensurePsvCssVars(container);

	// Dynamic import keeps three.js + PSV out of the MapEditor chunk until an Apple pin opens.
	const { createPanoViewer, InitialOrientation: Ori } = await import("./psv/createPanoViewer");

	const viewer = await createPanoViewer({
		container,
		initialPano: full,
		initialOrientation: Ori.Road,
		apiBaseUrl: bases.lookmapBaseUrl,
		canMove: true,
		canMoveWithKeyboard: true,
		compassEnabled: false,
		imageFormat: ImageFormatJpeg,
	});

	const handle = viewer as unknown as PanoViewerHandle;
	handle.currentPano = full;
	return handle;
}

export function mapCenter(): { lat: number; lng: number } | null {
	const map = getGoogleMap();
	if (!map) return null;
	const c = map.getCenter();
	if (!c) return null;
	return { lat: c.lat(), lng: c.lng() };
}

export { LookaroundApi };
