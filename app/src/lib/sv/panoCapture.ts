import { google } from "@/lib/sv/opensv";
import { singletonDiv } from "@/lib/sv/panoSingleton";
import type { PanoView } from "@/types";

const PANO_LOAD_TIMEOUT_MS = 15_000;
const CANVAS_SETTLE_TIMEOUT_MS = 3_000;
const CANVAS_QUIET_MS = 400;
const CANVAS_SAMPLE_INTERVAL_MS = 100;
// Slight oversize so fractional-DPR rounding can never undershoot the target buffer.
const HOST_OVERSCAN = 1.01;

// --- Live viewer capture ---

/** The live viewer's WebGL scene canvas, or null before first render. */
export function getPanoCanvas(): HTMLCanvasElement | null {
	return sceneCanvas(singletonDiv);
}

/** Source rect of the largest centered region matching the target aspect. */
export function coverCrop(
	srcW: number,
	srcH: number,
	dstW: number,
	dstH: number,
): { sx: number; sy: number; sw: number; sh: number } {
	const scale = Math.max(dstW / srcW, dstH / srcH);
	const sw = dstW / scale;
	const sh = dstH / scale;
	return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/** Cover-crop the live scene canvas into an exact width x height canvas; null until the
 *  viewer holds a rendered frame. */
export function captureLivePano(width: number, height: number): HTMLCanvasElement | null {
	const source = getPanoCanvas();
	if (!source) return null;
	const out = drawScaled(source, width, height);
	return out && hasImagery(out) ? out : null;
}

// --- Offscreen fixed-resolution render ---

/** Freeze the live viewer camera before offscreen rendering starts. */
export function snapshotPanoView(panorama: google.maps.StreetViewPanorama): PanoView {
	const panoId = panorama.getPano();
	const pov = panorama.getPov();
	const zoom = panorama.getZoom();
	if (
		!panoId ||
		!pov ||
		!Number.isFinite(pov.heading) ||
		!Number.isFinite(pov.pitch) ||
		!Number.isFinite(zoom)
	) {
		throw new Error("Street View is not ready");
	}
	return { panoId, heading: pov.heading, pitch: pov.pitch, zoom };
}

/** Render `view` in a hidden viewer and return an exact width x height canvas at
 *  native source quality, independent of the on-screen viewer's size or UI. */
export async function renderPanoView(
	view: PanoView,
	width: number,
	height: number,
): Promise<HTMLCanvasElement> {
	if (!google?.maps) throw new Error("OpenSV is not loaded");
	const dpr =
		Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
			? window.devicePixelRatio
			: 1;
	const { container, host } = createHost(width, height, dpr);

	try {
		const panorama = new google.maps.StreetViewPanorama(host, {
			pano: view.panoId,
			pov: { heading: view.heading, pitch: view.pitch },
			zoom: view.zoom,
			disableDefaultUI: true,
			linksControl: false,
			clickToGo: false,
			showRoadLabels: false,
			scrollwheel: false,
			motionTracking: false,
			visible: true,
		});
		await waitForPanoReady(panorama, view.panoId);

		const canvas = await waitForStableCanvas(host);
		if (canvas.width < width || canvas.height < height) {
			throw new Error(`WebGL drawing buffer is only ${canvas.width}x${canvas.height}`);
		}
		const scaled = drawScaled(canvas, width, height);
		if (!scaled) throw new Error("Could not create output canvas");
		return scaled;
	} finally {
		container.remove();
	}
}

// --- Shared internals ---

function drawScaled(
	source: HTMLCanvasElement,
	width: number,
	height: number,
): HTMLCanvasElement | null {
	const { sx, sy, sw, sh } = coverCrop(source.width, source.height, width, height);
	const out = document.createElement("canvas");
	out.width = width;
	out.height = height;
	const ctx = out.getContext("2d");
	if (!ctx) return null;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
	return out;
}

function createHost(
	width: number,
	height: number,
	dpr: number,
): { container: HTMLDivElement; host: HTMLDivElement } {
	const container = document.createElement("div");
	container.setAttribute("aria-hidden", "true");
	Object.assign(container.style, {
		position: "fixed",
		top: "0",
		left: "0",
		width: "1px",
		height: "1px",
		pointerEvents: "none",
		overflow: "hidden",
		zIndex: "-1",
	});
	const host = document.createElement("div");
	Object.assign(host.style, {
		position: "absolute",
		top: "0",
		left: "0",
		width: `${(width * HOST_OVERSCAN) / dpr}px`,
		height: `${(height * HOST_OVERSCAN) / dpr}px`,
	});
	container.appendChild(host);
	document.body.appendChild(container);
	return { container, host };
}

function waitForPanoReady(panorama: google.maps.StreetViewPanorama, panoId: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = () => {
			if (panorama.getPano() !== panoId || panorama.getStatus() !== "OK") return;
			window.clearTimeout(timer);
			listener.remove();
			resolve();
		};
		const listener = panorama.addListener("status_changed", finish);
		const timer = window.setTimeout(() => {
			listener.remove();
			reject(new Error("Timed out waiting for the offscreen pano to load"));
		}, PANO_LOAD_TIMEOUT_MS);
		finish();
	});
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Hash of a downsampled frame, or null while it is still blank or a solid fill. */
export function frameFingerprint(pixels: Uint8ClampedArray): number | null {
	let hash = 2166136261;
	let min = 255;
	let max = 0;
	let visible = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];
		if (pixels[i + 3] > 0) visible++;
		min = Math.min(min, r, g, b);
		max = Math.max(max, r, g, b);
		hash = Math.imul(hash ^ r, 16777619);
		hash = Math.imul(hash ^ g, 16777619);
		hash = Math.imul(hash ^ b, 16777619);
	}
	return visible > pixels.length / 8 && max - min > 4 ? hash >>> 0 : null;
}

function sceneCanvas(host: HTMLElement): HTMLCanvasElement | null {
	const canvas = host.querySelector<HTMLCanvasElement>("canvas.widget-scene-canvas");
	return canvas && canvas.width > 0 && canvas.height > 0 ? canvas : null;
}

function hasImagery(canvas: HTMLCanvasElement): boolean {
	const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
	return !!pixels && frameFingerprint(pixels) !== null;
}

/** Poll the scene canvas until its content holds still for CANVAS_QUIET_MS.
 *  A fresh offscreen pano loads low-res and sharpens as tiles arrive; there is
 *  no completion event, so quiescence is the only "done" signal. */
async function waitForStableCanvas(host: HTMLElement): Promise<HTMLCanvasElement> {
	const sample = document.createElement("canvas");
	sample.width = 64;
	sample.height = 36;
	const ctx = sample.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Could not inspect the OpenSV canvas");

	const settleDeadline = Date.now() + CANVAS_SETTLE_TIMEOUT_MS;
	let latest: HTMLCanvasElement | null = null;
	let previous: number | null = null;
	let unchangedSince = 0;
	while (Date.now() < settleDeadline) {
		await nextFrame();
		const canvas = sceneCanvas(host);
		if (canvas) {
			ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
			const fingerprint = frameFingerprint(
				ctx.getImageData(0, 0, sample.width, sample.height).data,
			);
			if (fingerprint !== null) {
				latest = canvas;
				const now = Date.now();
				if (fingerprint !== previous) {
					previous = fingerprint;
					unchangedSince = now;
				} else if (now - unchangedSince >= CANVAS_QUIET_MS) {
					return canvas;
				}
			}
		}
		await delay(CANVAS_SAMPLE_INTERVAL_MS);
	}

	if (latest) return latest;
	throw new Error("OpenSV did not render offscreen imagery");
}

export function canvasToBlob(
	canvas: HTMLCanvasElement,
	type = "image/png",
	quality?: number,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Canvas encoding failed"));
			},
			type,
			quality,
		);
	});
}
