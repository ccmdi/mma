/**
 * Baidu Street View render path for single / bulk panorama download.
 * Equirect stitches pdata tiles; perspective/thumbnail use the pr3d CDN.
 */
import type { Location } from "@/bindings.gen";
import { baiduPr3dThumbUrl } from "./endpoints";
import { baiduTileUrlAtZoom } from "./service";
import { stripBaidu } from "./prefix";
import type { PanoDownloadConfig, RenderedPanoImage } from "@/lib/sv/panoDownloadTypes";

const TILE = 512;
const MAX_ZOOM = 3;

async function fetchBaiduBitmap(url: string): Promise<ImageBitmap | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const resp = await fetch(url);
			if (!resp.ok) continue;
			// mapsv often returns Content-Type: text — force JPEG for decode.
			const jpeg = new Blob([await resp.arrayBuffer()], { type: "image/jpeg" });
			return await createImageBitmap(jpeg);
		} catch {
			/* retry */
		}
	}
	return null;
}

async function fetchBaiduBlob(url: string): Promise<Blob | null> {
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		return new Blob([await resp.arrayBuffer()], { type: "image/jpeg" });
	} catch {
		return null;
	}
}

/** Stitch Baidu equirect tiles at Google-style zoom (clamped 1–3). */
export async function stitchBaiduPano(
	panoId: string,
	zoom: number,
): Promise<HTMLCanvasElement | null> {
	const sid = stripBaidu(panoId);
	if (!sid) return null;
	const z = Math.min(Math.max(Math.round(zoom), 1), MAX_ZOOM);
	const cols = 2 ** z;
	const rows = Math.max(1, 2 ** (z - 1));
	// Stretch 512×256 tiles into 512×512 slots so layout matches the Google SV bridge.
	const width = cols * TILE;
	const height = rows * TILE;

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	let loaded = 0;
	const loads: Promise<void>[] = [];
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			loads.push(
				(async () => {
					const bmp = await fetchBaiduBitmap(baiduTileUrlAtZoom(sid, z, x, y));
					if (!bmp) return;
					ctx.drawImage(bmp, x * TILE, y * TILE, TILE, TILE);
					bmp.close();
					loaded++;
				})(),
			);
		}
	}
	await Promise.all(loads);
	return loaded > 0 ? canvas : null;
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Render one Baidu location for bulk / single download. */
export async function renderBaiduLocationImage(
	loc: Location,
	panoId: string,
	config: PanoDownloadConfig,
): Promise<RenderedPanoImage | null> {
	const sid = stripBaidu(panoId);
	if (!sid) return null;
	const name = sid;

	// Tile mode is Google-only (caller skips non-Google).
	if (config.mode === "tile") return null;

	if (config.mode === "thumbnail") {
		const blob = await fetchBaiduBlob(
			baiduPr3dThumbUrl(sid, {
				heading: loc.heading,
				pitch: loc.pitch,
				width: 1024,
				height: 768,
				fovy: 125,
			}),
		);
		return blob ? { blob, fileName: `${name}.jpg` } : null;
	}

	if (config.mode === "perspective") {
		const blob = await fetchBaiduBlob(
			baiduPr3dThumbUrl(sid, {
				heading: loc.heading,
				pitch: loc.pitch,
				width: 1920,
				height: 1080,
				fovy: 125,
			}),
		);
		return blob ? { blob, fileName: `${name}.jpg` } : null;
	}

	const canvas = await stitchBaiduPano(sid, config.zoom);
	if (!canvas) return null;
	const blob = await canvasToBlob(canvas, "image/jpeg", 0.95);
	return blob ? { blob, fileName: `${name}.jpg` } : null;
}
