import { google } from "./opensv";
import { createSyncStore } from "@/lib/util/syncStore";

interface CameraFrame {
	heading: number;
	pitch: number;
}

let locked = false;
let relHeading = 0;
let relPitch = 0;
let lockedZoom = 0;

let svService: google.maps.StreetViewService | null = null;
const frameCache = new Map<string, CameraFrame>();

const {
	subscribe: subscribeViewportLock,
	getSnapshot: getViewportLockSnapshot,
	notify,
} = createSyncStore();
export { subscribeViewportLock, getViewportLockSnapshot };

export function isViewportLocked() {
	return locked;
}

export function getViewportLockInfo() {
	if (!locked) return null;
	return { relHeading, relPitch, lockedZoom };
}

function norm(deg: number) {
	return ((((deg + 180) % 360) + 360) % 360) - 180;
}

async function getCameraFrame(panoId: string): Promise<CameraFrame | null> {
	if (frameCache.has(panoId)) return frameCache.get(panoId)!;
	if (!google?.maps) return null;
	svService ??= new google.maps.StreetViewService();
	return new Promise((resolve) => {
		svService!.getPanorama(
			{ pano: panoId },
			(
				data: google.maps.StreetViewPanoramaData | null,
				status: google.maps.StreetViewStatusString,
			) => {
				if (status !== google.maps.StreetViewStatus.OK || !data?.tiles) return resolve(null);
				const t = data.tiles;
				const heading = Number(t.centerHeading ?? t.originHeading ?? 0);
				const originPitch = Number(t.originPitch ?? 0);
				const originPitchYaw = Number(t.originPitchYaw);
				let pitch = -originPitch;
				if (!Number.isNaN(originPitchYaw)) {
					pitch *= Math.cos(((heading - originPitchYaw) * Math.PI) / 180);
				}
				const frame = { heading, pitch };
				frameCache.set(panoId, frame);
				resolve(frame);
			},
		);
	});
}

export async function applyViewportLock(pano: google.maps.StreetViewPanorama) {
	if (!locked) return;
	const panoId = pano.getPano?.();
	if (!panoId) return;
	const frame = await getCameraFrame(panoId);
	if (!frame || !locked || pano.getPano?.() !== panoId) return;
	pano.setPov({
		heading: norm(frame.heading + relHeading),
		pitch: frame.pitch + relPitch,
	});
	pano.setZoom(lockedZoom);
}

export async function toggleViewportLock(pano: google.maps.StreetViewPanorama): Promise<boolean> {
	if (locked) {
		locked = false;
		notify();
		return false;
	}
	const pov = pano.getPov?.();
	const panoId = pano.getPano?.();
	if (!pov || !panoId) return false;
	const frame = await getCameraFrame(panoId);
	if (!frame) return false;
	relHeading = norm(pov.heading - frame.heading);
	relPitch = (pov.pitch ?? 0) - frame.pitch;
	lockedZoom = pano.getZoom?.() ?? 0;
	locked = true;
	notify();
	return true;
}

export function clearViewportLock() {
	if (!locked) return;
	locked = false;
	notify();
}
