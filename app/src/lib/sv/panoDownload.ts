import type { Location } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { svThumbnailUrl } from "@/lib/sv/lookup";
import { svMetadata } from "@/lib/sv/query";
import type { Pano } from "@/types";
import { centerHeading } from "@/lib/sv/getMetadata";
import { panoResolveSpec } from "@/lib/sv/enrich";
import { runProcedure, type BatchOutcome, type BulkOpts } from "@/lib/data/procedures";
import { runConcurrent } from "@/lib/util/concurrent";
import { fileTimestamp } from "@/lib/util/format";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";
import { clamp } from "@/types/util";
import { mmaBufUrl, downloadBlob } from "@/lib/util/util";

export type PanoRenderMode = "equirectangular" | "perspective" | "thumbnail" | "tile";

// --- Tile fetch and stitching ---

/** Street View tiles are a fixed 512px pitch in `worldSize` space */
const SV_TILE = 512;

/** Number of tiles and the cropped content size for a pano at a given zoom.
 *  The tile grid rounds up to a power of two; the real image only spans
 *  `worldSize`. Scale the content down to the requested zoom and crop to it.
 *  Zoom is clamped to the pano's max (derived from its real width). Falls back
 *  to the full grid when metadata is unavailable. */
export function panoTileLayout(
	zoom: number,
	worldSize?: { width: number; height: number },
): { zoom: number; cols: number; rows: number; width: number; height: number; tile: number } {
	let z = zoom;
	let width: number;
	let height: number;
	if (worldSize?.width && worldSize?.height) {
		const maxZoom = Math.ceil(Math.log2(worldSize.width / SV_TILE));
		z = clamp(zoom, 0, maxZoom);
		const scale = 2 ** (maxZoom - z);
		width = Math.round(worldSize.width / scale);
		height = Math.round(worldSize.height / scale);
	} else {
		width = 2 ** zoom * SV_TILE;
		height = 2 ** (zoom - 1) * SV_TILE;
	}
	return {
		zoom: z,
		cols: Math.ceil(width / SV_TILE),
		rows: Math.ceil(height / SV_TILE),
		width,
		height,
		tile: SV_TILE,
	};
}

export function panoTileUrl(panoId: string, x: number, y: number, z: number): string {
	return `https://geo0.ggpht.com/cbk?cb_client=apiv3&panoid=${panoId}&output=tile&zoom=${z}&x=${x}&y=${y}`;
}

async function fetchPanoTile(
	panoId: string,
	x: number,
	y: number,
	z: number,
	signal?: AbortSignal,
): Promise<ImageBitmap | null> {
	const url = panoTileUrl(panoId, x, y, z);
	for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
		try {
			const resp = await fetch(url, { signal });
			if (!resp.ok) continue;
			return await createImageBitmap(await resp.blob());
		} catch {
			// retry
		}
	}
	return null;
}

/** Stitch a panorama's tiles onto a canvas at the given zoom. Null if no tiles loaded. */
export async function stitchPano(
	panoId: string,
	meta: Pano | null,
	zoom: number,
	signal?: AbortSignal,
): Promise<HTMLCanvasElement | null> {
	const { zoom: z, cols, rows, width, height, tile } = panoTileLayout(zoom, meta?.worldSize);

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
					const bmp = await fetchPanoTile(panoId, x, y, z, signal);
					if (!bmp) return;
					ctx.drawImage(bmp, x * tile, y * tile);
					bmp.close();
					loaded++;
				})(),
			);
		}
	}
	await Promise.all(loads);
	signal?.throwIfAborted();
	return loaded > 0 ? canvas : null;
}

/** Download the full panorama as a single stitched JPEG at max quality. Toasts on success/failure. */
export async function downloadPano(panoId: string, zoom = 5): Promise<void> {
	try {
		const [meta] = await svMetadata([panoId]);
		const canvas = await stitchPano(panoId, meta, zoom);
		if (!canvas) throw new Error("no tiles loaded");

		const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.95));
		if (!blob) throw new Error("encode failed");

		downloadBlob(blob, `${panoId}.jpg`);
		toast(t("Panorama downloaded"));
	} catch {
		toast(t("Panorama download failed"));
	}
}

export interface PanoDownloadConfig {
	mode: PanoRenderMode;
	zoom: number;
	tileX: number;
	tileY: number;
}

export interface BulkDownloadResult extends BatchOutcome {
	/** Temp file (single image or ZIP) ready for the export save dialog; null when nothing downloaded. */
	output: { path: string; name: string } | null;
}

const DOWNLOAD_CONCURRENCY = 4;

// --- Equirectangular -> perspective reprojection ---

function rotationMatrix(axis: [number, number, number], angle: number): number[][] {
	const rad = angle * (Math.PI / 180);
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const t = 1 - c;
	const [x, y, z] = axis;

	return [
		[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
		[t * x * y + s * z, t * y * y + c, t * y * z - s * x],
		[t * x * z - s * y, t * y * z + s * x, t * z * z + c],
	];
}

function applyRotation(m: number[][], v: [number, number, number]): [number, number, number] {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

function multiplyMatrices(a: number[][], b: number[][]): number[][] {
	const result = Array.from({ length: 3 }, () => Array(3).fill(0));
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) {
			for (let k = 0; k < 3; k++) {
				result[i][j] += a[i][k] * b[k][j];
			}
		}
	}
	return result;
}

function generatePerspective(
	canvas: HTMLCanvasElement,
	fov: number,
	theta: number,
	phi: number,
	outputWidth: number,
	outputHeight: number,
): HTMLCanvasElement {
	const out = document.createElement("canvas");
	out.width = outputWidth;
	out.height = outputHeight;
	const perspectiveCtx = out.getContext("2d")!;

	const f = (0.5 * outputWidth) / Math.tan((fov / 2) * (Math.PI / 180));
	const cx = outputWidth / 2;
	const cy = outputHeight / 2;

	const inputWidth = canvas.width;
	const inputHeight = canvas.height;
	const inputImageData = canvas.getContext("2d")!.getImageData(0, 0, inputWidth, inputHeight);

	const outputImageData = perspectiveCtx.createImageData(outputWidth, outputHeight);
	const outputData = outputImageData.data;

	const r1 = rotationMatrix([0, 1, 0], theta);
	const rotatedXAxis = applyRotation(r1, [1, 0, 0]);
	const r2 = rotationMatrix(rotatedXAxis, phi);
	const r = multiplyMatrices(r2, r1);

	for (let y = 0; y < outputHeight; y++) {
		for (let x = 0; x < outputWidth; x++) {
			const nx = (x - cx) / f;
			const ny = (y - cy) / f;
			const nz = 1;

			const [rx, ry, rz] = applyRotation(r, [nx, ny, nz]);
			const lon = Math.atan2(rx, rz);
			const lat = Math.asin(ry / Math.sqrt(rx * rx + ry * ry + rz * rz));

			const u = Math.floor((lon / (2 * Math.PI) + 0.5) * inputWidth);
			const v = Math.floor((lat / Math.PI + 0.5) * inputHeight);

			if (u >= 0 && u < inputWidth && v >= 0 && v < inputHeight) {
				const srcOffset = (v * inputWidth + u) * 4;
				const destOffset = (y * outputWidth + x) * 4;
				outputData[destOffset] = inputImageData.data[srcOffset];
				outputData[destOffset + 1] = inputImageData.data[srcOffset + 1];
				outputData[destOffset + 2] = inputImageData.data[srcOffset + 2];
				outputData[destOffset + 3] = 255;
			}
		}
	}

	perspectiveCtx.putImageData(outputImageData, 0, 0);
	return out;
}

// --- Per-location rendering ---

interface RenderedImage {
	blob: Blob;
	fileName: string;
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function fetchImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
	try {
		const resp = await fetch(url, { signal });
		return resp.ok ? await resp.blob() : null;
	} catch {
		return null;
	}
}

/** Render one location's image per the configured mode. Null on failure. */
async function renderLocationImage(
	loc: Location,
	panoId: string,
	meta: Pano | null,
	config: PanoDownloadConfig,
	signal?: AbortSignal,
): Promise<RenderedImage | null> {
	const name = panoId;

	if (config.mode === "thumbnail") {
		const url = new URL(svThumbnailUrl(panoId, loc.heading, 1024, 768));
		url.searchParams.set("pitch", String(loc.pitch));
		const blob = await fetchImage(url.toString(), signal);
		return blob ? { blob, fileName: `${name}.png` } : null;
	}

	if (config.mode === "tile") {
		const blob = await fetchImage(
			panoTileUrl(panoId, config.tileX, config.tileY, config.zoom),
			signal,
		);
		return blob
			? { blob, fileName: `${name}_z${config.zoom}_x${config.tileX}_y${config.tileY}.jpg` }
			: null;
	}

	const canvas = await stitchPano(panoId, meta, config.zoom, signal);
	if (!canvas) return null;

	if (config.mode === "perspective") {
		const perspective = generatePerspective(
			canvas,
			125,
			loc.heading - (meta ? centerHeading(meta) : 0),
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

// --- Bulk orchestration ---

async function fetchMetadataMap(
	panoIds: string[],
	signal?: AbortSignal,
): Promise<Map<string, Pano>> {
	const unique = [...new Set(panoIds)];
	const datas = await svMetadata(unique, signal);
	const out = new Map<string, Pano>();
	datas.forEach((d, i) => {
		if (d) out.set(unique[i], d);
	});
	return out;
}

/** Download panoramas for `locations`, uploading each image into a Rust session
 *  dir (via mma-buf POST) that is packaged into a single file or Stored ZIP. */
export async function bulkDownloadPanoramas(
	locations: Location[],
	config: PanoDownloadConfig,
	opts: BulkOpts = {},
): Promise<BulkDownloadResult> {
	const { signal, onProgress } = opts;
	const saved: number[] = [];
	const failed: number[] = [];

	const needResolve = locations.filter((l) => !l.panoId);
	const resolvedMap = new Map<number, string>();
	if (needResolve.length > 0) {
		onProgress?.(0, needResolve.length, t("Resolving pano IDs"));
		// The same procedure enrichment runs, borrowed for its answers: a download must
		// not move the panorama the user's location points at.
		const run = await runProcedure(
			panoResolveSpec,
			{ type: "Locations", locations: needResolve.map((l) => l.id), name: null },
			{
				id: "panoResolve",
				sink: "collect",
				signal,
				onProgress: (d, total) => onProgress?.(d, total, t("Resolving pano IDs")),
			},
		);
		for (const { id, value } of run.collected ?? []) {
			const panoId = value?.panoId;
			if (typeof panoId === "string" && panoId) resolvedMap.set(id, panoId);
		}
		failed.push(...needResolve.filter((l) => !resolvedMap.has(l.id)).map((l) => l.id));
	}

	const pending = locations.flatMap((loc) => {
		const panoId = loc.panoId ?? resolvedMap.get(loc.id);
		return panoId ? [{ loc, panoId }] : [];
	});
	if (pending.length === 0) {
		return { succeeded: saved.length, failed, output: null };
	}

	// Metadata drives tile layout and center heading; thumbnail/tile modes need neither.
	let metaMap = new Map<string, Pano>();
	if (config.mode === "equirectangular" || config.mode === "perspective") {
		onProgress?.(0, pending.length, t("Fetching metadata"));
		metaMap = await fetchMetadataMap(
			pending.map((p) => p.panoId),
			signal,
		);
	}

	const session = await cmd.storeUploadBegin();
	let done = 0;
	let singleName: string | null = null;

	const usedNames = new Set<string>();
	const uniqueName = (name: string) => {
		if (!usedNames.has(name)) {
			usedNames.add(name);
			return name;
		}
		const dot = name.lastIndexOf(".");
		const stem = name.slice(0, dot);
		const ext = name.slice(dot);
		let i = 2;
		while (usedNames.has(`${stem}_${i}${ext}`)) i++;
		const suffixed = `${stem}_${i}${ext}`;
		usedNames.add(suffixed);
		return suffixed;
	};

	try {
		onProgress?.(0, pending.length, t("Downloading"));
		await runConcurrent(
			pending,
			async ({ loc, panoId }) => {
				const image = await renderLocationImage(
					loc,
					panoId,
					metaMap.get(panoId) ?? null,
					config,
					signal,
				);
				let ok = false;
				if (image) {
					const fileName = uniqueName(image.fileName);
					const res = await fetch(mmaBufUrl(`${session}/${fileName}`), {
						method: "POST",
						body: image.blob,
					});
					ok = res.ok;
					if (ok) singleName = fileName;
				}
				(ok ? saved : failed).push(loc.id);
				done++;
				onProgress?.(done, pending.length, t("Downloading"));
			},
			{ concurrency: DOWNLOAD_CONCURRENCY, signal },
		);
	} catch (e) {
		await cmd.storeUploadAbort(session).catch(() => {});
		throw e;
	}

	if (saved.length === 0) {
		await cmd.storeUploadAbort(session).catch(() => {});
		return { succeeded: saved.length, failed, output: null };
	}

	const path = await cmd.storeUploadFinish(session);
	const stamp = fileTimestamp();
	const name = saved.length === 1 && singleName ? singleName : `panoramas-${stamp}.zip`;
	return { succeeded: saved.length, failed, output: { path, name } };
}
