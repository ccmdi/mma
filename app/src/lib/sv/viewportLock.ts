import { normalizeHeading } from "@/lib/geo/geo";
import { emit as emitEvent } from "@/lib/events";
import { svMetadata } from "@/lib/sv/query";
import type { CameraFrame } from "@/bindings.gen";
import type { PanoViewer } from "@/lib/sv/pano";

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
	const frame = data.cameraFrame;
	frameCache.set(panoId, frame);
	return frame;
}

export async function applyViewportLock(viewer: PanoViewer) {
	if (!locked) return;
	const panoId = viewer.panoId();
	if (!panoId) return;
	const look = viewer.reserveLook();
	const frame = await getCameraFrame(panoId);
	if (!frame || !locked || viewer.panoId() !== panoId) return;
	look({
		heading: normalizeHeading(frame.heading + relHeading),
		pitch: frame.pitch + relPitch,
		zoom: lockedZoom,
	});
}

export async function toggleViewportLock(viewer: PanoViewer): Promise<boolean> {
	if (locked) {
		locked = false;
		emitEvent("viewport-lock:changed");
		return false;
	}
	const panoId = viewer.panoId();
	if (!panoId) return false;
	const { heading, pitch } = viewer.pov();
	const frame = await getCameraFrame(panoId);
	if (!frame) return false;
	relHeading = normalizeHeading(heading - frame.heading);
	relPitch = pitch - frame.pitch;
	lockedZoom = viewer.zoom();
	locked = true;
	emitEvent("viewport-lock:changed");
	return true;
}

export function clearViewportLock() {
	if (!locked) return;
	locked = false;
	emitEvent("viewport-lock:changed");
}
