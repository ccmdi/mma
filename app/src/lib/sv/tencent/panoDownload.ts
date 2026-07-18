/**
 * Tencent Street View render path for single / bulk panorama download.
 * Equirect: 16×8 level-1 tiles (8192×4096) — download.js / altproviders parity.
 */
import type { Location } from "@/bindings.gen";
import { generatePerspectiveFromEquirect } from "@/lib/sv/panoDownloadShared";
import type { PanoDownloadConfig, RenderedPanoImage } from "@/lib/sv/panoDownloadTypes";
import { tencentDownloadThumbUrl, tencentPanoTileUrl } from "./endpoints";
import { stripTencent } from "./prefix";

const TILE = 512;
/** Full equirect grid at Tencent tile level 1 (download.js). */
const FULL_COLS = 16;
const FULL_ROWS = 8;
const TILE_LEVEL = 1;

async function fetchTencentBitmap(url: string): Promise<ImageBitmap | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const resp = await fetch(url);
			if (!resp.ok) continue;
			const jpeg = new Blob([await resp.arrayBuffer()], { type: "image/jpeg" });
			return await createImageBitmap(jpeg);
		} catch {
			/* retry */
		}
	}
	return null;
}

async function fetchTencentBlob(url: string): Promise<Blob | null> {
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		return new Blob([await resp.arrayBuffer()], { type: "image/jpeg" });
	} catch {
		return null;
	}
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Stitch Tencent level-1 tiles into an 8192×4096 equirect (16×8 @ 512px). */
export async function stitchTencentPano(
	panoId: string,
	_zoom = 5,
): Promise<HTMLCanvasElement | null> {
	const svid = stripTencent(panoId);
	if (!svid) return null;

	const width = FULL_COLS * TILE;
	const height = FULL_ROWS * TILE;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	let loaded = 0;
	const loads: Promise<void>[] = [];
	for (let y = 0; y < FULL_ROWS; y += 1) {
		for (let x = 0; x < FULL_COLS; x += 1) {
			loads.push(
				(async () => {
					const bmp = await fetchTencentBitmap(
						tencentPanoTileUrl(svid, TILE_LEVEL, x, y),
					);
					if (!bmp) return;
					ctx.drawImage(bmp, x * TILE, y * TILE, TILE, TILE);
					bmp.close();
					loaded += 1;
				})(),
			);
		}
	}
	await Promise.all(loads);
	return loaded > 0 ? canvas : null;
}

export async function renderTencentLocationImage(
	loc: Location,
	panoId: string,
	config: PanoDownloadConfig,
): Promise<RenderedPanoImage | null> {
	const svid = stripTencent(panoId);
	if (!svid) return null;
	const name = svid;

	if (config.mode === "tile") return null;

	if (config.mode === "thumbnail") {
		const blob = await fetchTencentBlob(tencentDownloadThumbUrl(svid));
		return blob ? { blob, fileName: `${name}.jpg` } : null;
	}

	const canvas = await stitchTencentPano(panoId, config.zoom);
	if (!canvas) return null;

	if (config.mode === "perspective") {
		const perspective = generatePerspectiveFromEquirect(
			canvas,
			125,
			loc.heading,
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
