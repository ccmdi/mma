import type { Location } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { svThumbnailUrl } from "@/lib/sv/lookup";
import { svMetadata } from "@/lib/sv/query";
import { canvasToBlob } from "@/lib/sv/panoCapture";
import type { Pano } from "@/bindings.gen";
import { panoResolveProvider } from "@/lib/sv/providers";
import { Procedure, type BatchOutcome, type BulkOpts } from "@/lib/data/procedure";
import { cancellable } from "@/lib/runs";
import { runConcurrent } from "@/lib/util/concurrent";
import { fileTimestamp } from "@/lib/util/format";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";
import { mmaBufUrl, downloadBlob, schemeBase } from "@/lib/util/util";

export type PanoRenderMode = "equirectangular" | "perspective" | "thumbnail" | "tile";

/** A panorama stitched at `zoom` and cropped to its imagery, as a JPEG. */
function panoUrl(panoId: string, zoom: number): string {
	return `${schemeBase("pano")}${panoId}/${zoom}`;
}

function panoTileUrl(panoId: string, zoom: number, x: number, y: number): string {
	return `${panoUrl(panoId, zoom)}/${x}/${y}`;
}

/** Download the full panorama as a single stitched JPEG. Toasts on success/failure. */
export async function downloadPano(panoId: string, zoom = 5): Promise<void> {
	const blob = await fetchImage(panoUrl(panoId, zoom));
	if (blob) {
		downloadBlob(blob, `${panoId}.jpg`);
		toast(t("Panorama downloaded"));
	} else {
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

function pixelsOf(bitmap: ImageBitmap): ImageData {
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(bitmap, 0, 0);
	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function generatePerspective(
	input: ImageData,
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

	const { width: inputWidth, height: inputHeight, data: inputData } = input;

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
				outputData[destOffset] = inputData[srcOffset];
				outputData[destOffset + 1] = inputData[srcOffset + 1];
				outputData[destOffset + 2] = inputData[srcOffset + 2];
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

async function fetchImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
	try {
		const resp = await fetch(url, { signal });
		return resp.ok ? await resp.blob() : null;
	} catch {
		return null;
	}
}

/** A `pano:` image under a run of its own, so an abort stops its tile fetches too. */
function fetchPanoImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
	return cancellable(signal, false, (runId) =>
		fetchImage(runId === null ? url : `${url}?run=${runId}`, signal),
	).catch(() => null);
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
		const blob = await fetchPanoImage(
			panoTileUrl(panoId, config.zoom, config.tileX, config.tileY),
			signal,
		);
		return blob
			? { blob, fileName: `${name}_z${config.zoom}_x${config.tileX}_y${config.tileY}.jpg` }
			: null;
	}

	const pano = await fetchPanoImage(panoUrl(panoId, config.zoom), signal);
	if (!pano) return null;
	if (config.mode === "equirectangular") return { blob: pano, fileName: `${name}.jpg` };

	const bitmap = await createImageBitmap(pano);
	const perspective = generatePerspective(
		pixelsOf(bitmap),
		125,
		loc.heading - (meta ? meta.centerHeading : 0),
		loc.pitch,
		1920,
		1080,
	);
	bitmap.close();
	const blob = await canvasToBlob(perspective).catch(() => null);
	return blob && { blob, fileName: `${name}.png` };
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
	// A hand-run of sequential phases: the bar resets per phase, one part names it.
	const report = (label: string) => (done: number, total: number) =>
		onProgress?.(done, total, [{ label, done, total, failed: 0, finished: false }]);

	const needResolve = locations.filter((l) => !l.panoId);
	const resolvedMap = new Map<number, string>();
	if (needResolve.length > 0) {
		const resolving = report(t("Resolving pano IDs"));
		resolving(0, needResolve.length);
		// The same procedure enrichment runs, borrowed for its answers: a download must
		// not move the panorama the user's location points at.
		const run = await Procedure.run(
			panoResolveProvider.procedure,
			{ type: "Locations", locations: needResolve.map((l) => l.id), name: null },
			{
				id: "panoResolve",
				sink: "collect",
				signal,
				onProgress: (d, total) => resolving(d, total),
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

	// A perspective view turns by its pano's center heading; no other mode reads metadata.
	let metaMap = new Map<string, Pano>();
	if (config.mode === "perspective") {
		report(t("Fetching metadata"))(0, pending.length);
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
		const downloading = report(t("Downloading"));
		downloading(0, pending.length);
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
				downloading(done, pending.length);
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
