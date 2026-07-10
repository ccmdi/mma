import { panoTileLayout, svThumbnailUrl } from "@/lib/sv/lookup";
import type { PanoData } from "@/lib/sv/svRunner";

export type DownloadRenderMode = "equirectangular" | "perspective" | "thumbnail" | "tile";

export interface DownloadImageOptions {
	panoId: string;
	fileName: string;
	meta?: PanoData | null;
	mode: DownloadRenderMode;
	zoom?: number;
	tileX?: number;
	tileY?: number;
	heading?: number;
	pitch?: number;
	centerHeading?: number;
}

export interface DownloadedImage {
	blob: Blob;
	fileName: string;
}

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

function applyRotation(matrix: number[][], vector: [number, number, number]): [number, number, number] {
	return [
		matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
		matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
		matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
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

async function fetchPanoTile(panoId: string, x: number, y: number, z: number): Promise<ImageBitmap | null> {
	const url = `https://geo0.ggpht.com/cbk?cb_client=apiv3&panoid=${panoId}&output=tile&zoom=${z}&x=${x}&y=${y}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const resp = await fetch(url);
			if (!resp.ok) continue;
			return await createImageBitmap(await resp.blob());
		} catch {
			// retry
		}
	}
	return null;
}

async function stitchPanoCanvas(
	panoId: string,
	meta: PanoData | null | undefined,
	zoom: number,
): Promise<HTMLCanvasElement | null> {
	const { zoom: z, cols, rows, width, height, tile } = panoTileLayout(
		zoom,
		meta?.tiles?.worldSize,
	);

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
					const bmp = await fetchPanoTile(panoId, x, y, z);
					if (!bmp) return;
					ctx.drawImage(bmp, x * tile, y * tile);
					bmp.close();
					loaded++;
				})(),
			);
		}
	}
	await Promise.all(loads);
	return loaded > 0 ? canvas : null;
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

	const f = 0.5 * outputWidth / Math.tan((fov / 2) * (Math.PI / 180));
	const cx = outputWidth / 2;
	const cy = outputHeight / 2;

	const inputWidth = canvas.width;
	const inputHeight = canvas.height;
	const inputCtx = canvas.getContext("2d")!;
	const inputImageData = inputCtx.getImageData(0, 0, inputWidth, inputHeight);

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

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function downloadThumbnail(
	panoId: string,
	fileName: string,
	heading: number,
	pitch: number,
): Promise<DownloadedImage | null> {
	const thumbUrl = new URL(svThumbnailUrl(panoId, heading, 1024, 768));
	thumbUrl.searchParams.set("pitch", String(pitch));
	try {
		const response = await fetch(thumbUrl.toString());
		if (!response.ok) return null;
		const blob = await response.blob();
		return { blob, fileName: `${fileName}.png` };
	} catch {
		return null;
	}
}

async function downloadSingleTile(
	panoId: string,
	fileName: string,
	zoom: number,
	tileX: number,
	tileY: number,
): Promise<DownloadedImage | null> {
	const url = `https://geo0.ggpht.com/cbk?cb_client=apiv3&panoid=${panoId}&output=tile&zoom=${zoom}&x=${tileX}&y=${tileY}`;
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		const blob = await resp.blob();
		return { blob, fileName: `${fileName}_z${zoom}_x${tileX}_y${tileY}.jpg` };
	} catch {
		return null;
	}
}

/** Render one location's panorama/thumbnail/tile using project metadata layout. */
export async function renderLocationImage(opts: DownloadImageOptions): Promise<DownloadedImage | null> {
	const {
		panoId,
		fileName,
		meta,
		mode,
		zoom = 5,
		tileX = 0,
		tileY = 0,
		heading = 0,
		pitch = 0,
		centerHeading = 0,
	} = opts;

	if (mode === "thumbnail") {
		return downloadThumbnail(panoId, fileName, heading, pitch);
	}

	if (mode === "tile") {
		return downloadSingleTile(panoId, fileName, zoom, tileX, tileY);
	}

	const canvas = await stitchPanoCanvas(panoId, meta, zoom);
	if (!canvas) return null;

	if (mode === "perspective") {
		const targetTheta = heading - centerHeading;
		const perspectiveCanvas = generatePerspective(canvas, 125, targetTheta, pitch, 1920, 1080);
		const blob = await canvasToBlob(perspectiveCanvas, "image/png");
		return blob ? { blob, fileName: `${fileName}.png` } : null;
	}

	const blob = await canvasToBlob(canvas, "image/jpeg", 0.95);
	return blob ? { blob, fileName: `${fileName}.jpg` } : null;
}

/** Trigger a browser download for a blob. */
export function triggerBlobDownload(blob: Blob, downloadName: string) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = downloadName;
	a.click();
	URL.revokeObjectURL(a.href);
}
