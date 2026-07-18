/**
 * Apple Look Around render path for single / bulk panorama download.
 *
 * Equirectangular stitch follows streetlevel lookaround.reproject + equilib Equi2Equi:
 * https://github.com/sk-zk/streetlevel/blob/master/streetlevel/lookaround/reproject.py
 * https://github.com/haruishi43/equilib
 *
 *   full_width = round(face_width * (1024 / 5632)) * 16
 *   side faces: paste by angular extent (yaw / fovS / fovH / cy)
 *   top/bottom: center on transparent equirect, Equi2Equi(z_down=True)
 */
import type { Location } from "@/bindings.gen";
import { getApi, META_OPEN, type LookaroundPano } from "./api";
import { LOOKMAP_ORIGIN } from "./endpoints";
import { resolvePanoForLocation } from "./tile";
import { Face } from "./psv/enums";
import type { PanoDownloadConfig, RenderedPanoImage } from "@/lib/sv/panoDownloadTypes";
import { generatePerspectiveFromEquirect } from "@/lib/sv/panoDownloadShared";

const NUM_FACES = 6;
/** Native Apple HEIC face width at zoom 0 (streetlevel reproject constant). */
const NATIVE_FACE_WIDTH = 5632;
/**
 * Cap equirect width for interactive downloads.
 * streetlevel: zoom-0 16384×8192 ≈ 50s; 4096×2048 is ~16× fewer pixels.
 */
const MAX_EQUIRECT_WIDTH = 4096;

type FaceCam = NonNullable<LookaroundPano["cameraMetadata"]>[number];

/** Google UI zoom 1–5 → Apple face zoom 4–0 (lower = sharper). */
function googleZoomToFaceZoom(zoom: number): number {
	return Math.max(0, Math.min(5, 5 - Math.round(zoom)));
}

/** streetlevel: round(face_w * (1024 / 5632)) * 16 */
export function lookaroundEquirectSize(
	faceWidth: number,
	cap = MAX_EQUIRECT_WIDTH,
): { width: number; height: number } {
	let fullWidth = Math.round(faceWidth * (1024 / NATIVE_FACE_WIDTH)) * 16;
	if (fullWidth < 16) fullWidth = 16;
	if (cap > 0 && fullWidth > cap) fullWidth = Math.floor(cap / 16) * 16;
	return { width: fullWidth, height: fullWidth >> 1 };
}

export function lookaroundFaceUrl(
	panoid: string,
	buildId: string,
	faceZoom: number,
	faceIdx: number,
	baseUrl = LOOKMAP_ORIGIN,
): string {
	const origin = baseUrl.replace(/\/$/, "");
	return `${origin}/pano/${panoid}/${buildId}/${faceZoom}/${faceIdx}/`;
}

async function fetchFaceBitmap(url: string): Promise<ImageBitmap | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const resp = await fetch(url);
			if (!resp.ok) continue;
			return await createImageBitmap(await resp.blob());
		} catch {
			/* retry */
		}
	}
	return null;
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * equilib create_rotation_matrix(z_down=True): R = Rz(yaw) @ Ry(pitch) @ Rx(roll)
 * https://github.com/haruishi43/equilib/blob/master/equilib/numpy_utils/rotation.py
 */
function equilibRotation(yaw: number, pitch: number, roll: number): number[] {
	const cr = Math.cos(roll);
	const sr = Math.sin(roll);
	const cp = Math.cos(pitch);
	const sp = Math.sin(pitch);
	const cy = Math.cos(yaw);
	const sy = Math.sin(yaw);
	// Row-major 3×3
	return [
		cy * cp,
		cy * sp * sr - sy * cr,
		cy * sp * cr + sy * sr,
		sy * cp,
		sy * sp * sr + cy * cr,
		sy * sp * cr - cy * sr,
		-sp,
		cp * sr,
		cp * cr,
	];
}

/**
 * equilib Equi2Equi(z_down=True) reverse sample.
 * Grid: theta = x*2π/w - π, phi = y*π/h - π/2
 *        dir = (cosφ cosθ, cosφ sinθ, sinφ)
 * Sample: M = R @ dir; θ=atan2(My,Mx); φ=asin(Mz)
 */
function equi2EquiRotate(
	src: ImageData,
	yaw: number,
	pitch: number,
	roll: number,
): ImageData {
	const w = src.width;
	const h = src.height;
	const out = new ImageData(w, h);
	const sd = src.data;
	const od = out.data;
	const R = equilibRotation(yaw, pitch, roll);
	const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = R;

	for (let py = 0; py < h; py++) {
		const phi = (py * Math.PI) / h - Math.PI / 2;
		const cosPhi = Math.cos(phi);
		const sinPhi = Math.sin(phi);
		for (let px = 0; px < w; px++) {
			const theta = (px * 2 * Math.PI) / w - Math.PI;
			const x = cosPhi * Math.cos(theta);
			const y = cosPhi * Math.sin(theta);
			const z = sinPhi;

			const mx = r00 * x + r01 * y + r02 * z;
			const my = r10 * x + r11 * y + r12 * z;
			const mz = r20 * x + r21 * y + r22 * z;

			const thetaS = Math.atan2(my, mx);
			const phiS = Math.asin(Math.max(-1, Math.min(1, mz)));
			let ui = ((thetaS - Math.PI) * w) / (2 * Math.PI) + 0.5;
			let uj = ((phiS + Math.PI / 2) * h) / Math.PI + 0.5;
			ui = ((ui % w) + w) % w;
			uj = Math.min(h - 1, Math.max(0, uj));

			const sx = Math.min(w - 1, Math.max(0, Math.floor(ui)));
			const sy = Math.min(h - 1, Math.max(0, Math.floor(uj)));
			const si = (sy * w + sx) * 4;
			const di = (py * w + px) * 4;
			od[di] = sd[si]!;
			od[di + 1] = sd[si + 1]!;
			od[di + 2] = sd[si + 2]!;
			od[di + 3] = sd[si + 3]!;
		}
	}
	return out;
}

/**
 * streetlevel _project_top_or_bottom_face:
 * center face on transparent RGBA equirect, Equi2Equi with
 * yaw=-position.yaw, pitch=position.pitch, roll=position.roll, then alpha-paste.
 */
function projectTopOrBottomFace(
	dst: CanvasRenderingContext2D,
	face: ImageBitmap,
	cam: FaceCam,
	fullWidth: number,
	fullHeight: number,
): void {
	const fovS = cam.fovS ?? Math.PI / 2;
	const fovH = cam.fovH ?? Math.PI / 2;
	const scale = fullHeight / Math.PI;
	const faceWidth = Math.max(1, Math.ceil(fovS * scale));
	const faceHeight = Math.max(1, Math.ceil(fovH * scale));
	const x = Math.ceil((fullWidth - faceWidth) / 2);
	const y = Math.ceil((fullHeight - faceHeight) / 2);

	const layer = document.createElement("canvas");
	layer.width = fullWidth;
	layer.height = fullHeight;
	const lctx = layer.getContext("2d", { willReadFrequently: true })!;
	// Transparent clear (streetlevel RGBA (0,0,0,0))
	lctx.clearRect(0, 0, fullWidth, fullHeight);
	lctx.drawImage(face, x, y, faceWidth, faceHeight);
	const srcData = lctx.getImageData(0, 0, fullWidth, fullHeight);

	const rotated = equi2EquiRotate(
		srcData,
		-(cam.yaw ?? 0),
		cam.pitch ?? 0,
		cam.roll ?? 0,
	);

	// Alpha-composite onto destination (streetlevel paste with mask)
	const dest = dst.getImageData(0, 0, fullWidth, fullHeight);
	const dd = dest.data;
	const rd = rotated.data;
	for (let i = 0; i < rd.length; i += 4) {
		const a = rd[i + 3]!;
		if (a === 0) continue;
		dd[i] = rd[i]!;
		dd[i + 1] = rd[i + 1]!;
		dd[i + 2] = rd[i + 2]!;
		dd[i + 3] = 255;
	}
	dst.putImageData(dest, 0, 0);
}

/**
 * streetlevel _paste_side_face — resize face to angular extent and paste.
 * Wrap when the face crosses the 0/360 seam.
 */
function pasteSideFace(
	dst: CanvasRenderingContext2D,
	face: ImageBitmap,
	cam: FaceCam,
	fullWidth: number,
	fullHeight: number,
): void {
	const fovS = cam.fovS ?? Math.PI / 2;
	const fovH = cam.fovH ?? Math.PI / 2;
	const cy = cam.cy ?? 0;
	const yaw = cam.yaw ?? 0;
	const scale = fullHeight / Math.PI;

	let phiStart = Math.PI + yaw - fovS / 2;
	if (phiStart < 0) phiStart += 2 * Math.PI;
	const thetaStart = Math.PI / 2 - fovH / 2 - cy;
	const faceWidth = fovS * scale;
	const faceHeight = fovH * scale;
	const x = phiStart * scale;
	const y = thetaStart * scale;

	const tw = Math.max(1, Math.ceil(faceWidth));
	const th = Math.max(1, Math.ceil(faceHeight));
	const ix = Math.ceil(x);
	const iy = Math.ceil(y);
	dst.drawImage(face, ix, iy, tw, th);
	// streetlevel: wrap using original face.width — use scaled width (correct).
	if (x + faceWidth > fullWidth) {
		dst.drawImage(face, Math.ceil(x - fullWidth), iy, tw, th);
	}
}

/**
 * streetlevel to_equirectangular — canvas from face width, not Google worldSize.
 */
export function facesToEquirect(
	faces: ImageBitmap[],
	cams: FaceCam[],
): HTMLCanvasElement | null {
	if (faces.length < NUM_FACES || cams.length < NUM_FACES) return null;
	const faceSize = faces[0]?.width ?? 0;
	if (faceSize <= 0) return null;

	const { width: fullWidth, height: fullHeight } = lookaroundEquirectSize(faceSize);
	const canvas = document.createElement("canvas");
	canvas.width = fullWidth;
	canvas.height = fullHeight;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, fullWidth, fullHeight);

	// streetlevel: for faceIndex in range(5, -1, -1) — bottom, top, then sides
	for (let faceIndex = 5; faceIndex >= 0; faceIndex--) {
		const face = faces[faceIndex]!;
		const cam = cams[faceIndex]!;
		if (faceIndex > Face.Right) {
			projectTopOrBottomFace(ctx, face, cam, fullWidth, fullHeight);
		} else {
			pasteSideFace(ctx, face, cam, fullWidth, fullHeight);
		}
	}

	return canvas;
}

async function loadFaces(
	panoid: string,
	buildId: string,
	faceZoom: number,
): Promise<ImageBitmap[] | null> {
	const base = getApi().getLookmapBaseUrl();
	const results = await Promise.all(
		Array.from({ length: NUM_FACES }, (_, i) =>
			fetchFaceBitmap(lookaroundFaceUrl(panoid, buildId, faceZoom, i, base)),
		),
	);
	if (results.some((b) => !b)) {
		for (const b of results) b?.close();
		return null;
	}
	return results as ImageBitmap[];
}

async function resolvePano(
	loc: Location,
	panoId: string,
): Promise<LookaroundPano | null> {
	return resolvePanoForLocation(loc.lat, loc.lng, panoId, META_OPEN);
}

/** Stitch Look Around faces into an equirectangular canvas. */
export async function stitchLookaroundPano(
	loc: Location,
	panoId: string,
	zoom: number,
): Promise<HTMLCanvasElement | null> {
	const pano = await resolvePano(loc, panoId);
	if (!pano?.panoid || !pano.buildId || !pano.cameraMetadata?.length) return null;
	const faceZoom = googleZoomToFaceZoom(zoom);
	const faces = await loadFaces(pano.panoid, pano.buildId, faceZoom);
	if (!faces) return null;
	try {
		return facesToEquirect(faces, pano.cameraMetadata);
	} finally {
		for (const f of faces) f.close();
	}
}

/** Render one Apple Look Around location for bulk / single download. */
export async function renderLookaroundLocationImage(
	loc: Location,
	panoId: string,
	config: PanoDownloadConfig,
): Promise<RenderedPanoImage | null> {
	if (config.mode === "tile" || config.mode === "thumbnail") return null;

	const pano = await resolvePano(loc, panoId);
	if (!pano?.panoid || !pano.buildId || !pano.cameraMetadata?.length) return null;
	const name = pano.panoid;
	const faceZoom = googleZoomToFaceZoom(config.zoom);

	const faces = await loadFaces(pano.panoid, pano.buildId, faceZoom);
	if (!faces) return null;
	let canvas: HTMLCanvasElement | null;
	try {
		canvas = facesToEquirect(faces, pano.cameraMetadata);
	} finally {
		for (const f of faces) f.close();
	}
	if (!canvas) return null;

	if (config.mode === "perspective") {
		const centerHeading =
			typeof loc.extra?.drivingDirection === "number" ? loc.extra.drivingDirection : 0;
		const perspective = generatePerspectiveFromEquirect(
			canvas,
			125,
			loc.heading - centerHeading,
			loc.pitch,
			1920,
			1080,
		);
		const blob = await canvasToBlob(perspective, "image/png");
		return blob ? { blob, fileName: `${name}.png` } : null;
	}

	const blob = await canvasToBlob(canvas, "image/jpeg", 0.95);
	return blob ? { blob, fileName: `${name}.jpg` } : null;
}
