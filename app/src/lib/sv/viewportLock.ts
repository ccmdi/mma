import { normalizeHeading } from "@/lib/geo/geo";
import { emit as emitEvent } from "@/lib/events";
import { svMetadata } from "@/lib/sv/query";
import { cameraFrame } from "@/lib/sv/getMetadata";

interface CameraFrame {
	heading: number;
	pitch: number;
}

let locked = false;
let relHeading = 0;
let relPitch = 0;
let lockedZoom = 0;

const frameCache = new Map<string, CameraFrame>();

export function isViewportLocked() {
	return locked;
}

export function getViewportLockInfo() {
	if (!locked) return null;
	return { relHeading, relPitch, lockedZoom };
}

async function getCameraFrame(panoId: string): Promise<CameraFrame | null> {
	const cached = frameCache.get(panoId);
	if (cached) return cached;
	const [data] = await svMetadata([panoId]);
	if (!data) return null;
	const frame = cameraFrame(data);
	frameCache.set(panoId, frame);
	return frame;
}

export async function applyViewportLock(pano: google.maps.StreetViewPanorama) {
	if (!locked) return;
	const panoId = pano.getPano?.();
	if (!panoId) return;
	const frame = await getCameraFrame(panoId);
	if (!frame || !locked || pano.getPano?.() !== panoId) return;
	pano.setPov({
		heading: normalizeHeading(frame.heading + relHeading),
		pitch: frame.pitch + relPitch,
	});
	pano.setZoom(lockedZoom);
}

export async function toggleViewportLock(pano: google.maps.StreetViewPanorama): Promise<boolean> {
	if (locked) {
		locked = false;
		emitEvent("viewport-lock:changed");
		return false;
	}
	const pov = pano.getPov?.();
	const panoId = pano.getPano?.();
	if (!pov || !panoId) return false;
	const frame = await getCameraFrame(panoId);
	if (!frame) return false;
	relHeading = normalizeHeading(pov.heading - frame.heading);
	relPitch = (pov.pitch ?? 0) - frame.pitch;
	lockedZoom = pano.getZoom?.() ?? 0;
	locked = true;
	emitEvent("viewport-lock:changed");
	return true;
}

export function clearViewportLock() {
	if (!locked) return;
	locked = false;
	emitEvent("viewport-lock:changed");
}
