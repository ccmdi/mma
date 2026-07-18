import type { Location } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { resolvePanoIds, svThumbnailUrl } from "@/lib/sv/lookup";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import type { PanoData } from "@/lib/sv/svRunner";
import { runConcurrent } from "@/lib/util/concurrent";
import { toast } from "@/lib/util/toast";
import { mmaBufUrl } from "@/lib/util/util";
import { getLocationProvider } from "@/lib/sv/providers/types";
import type { SvProvider } from "@/lib/sv/providers/types";
import { renderBaiduLocationImage, stitchBaiduPano } from "@/lib/sv/baidu/panoDownload";
import { resolveBaiduNear } from "@/lib/sv/baidu/api";
import { stripBaidu } from "@/lib/sv/baidu/prefix";
import { renderTencentLocationImage, stitchTencentPano } from "@/lib/sv/tencent/panoDownload";
import { resolveTencentNear } from "@/lib/sv/tencent/api";
import { stripTencent } from "@/lib/sv/tencent/prefix";
import {
	renderLookaroundLocationImage,
	stitchLookaroundPano,
} from "@/lib/sv/lookaround/panoDownload";
import { getClosestPano } from "@/lib/sv/lookaround/tile";
import { generatePerspectiveFromEquirect } from "@/lib/sv/panoDownloadShared";
import type { PanoDownloadConfig, RenderedPanoImage } from "@/lib/sv/panoDownloadTypes";

export type {
	PanoDownloadConfig,
	PanoRenderMode,
	RenderedPanoImage,
} from "@/lib/sv/panoDownloadTypes";

// --- Tile fetch and stitching (Google) ---

/** Street View tiles are a fixed 512px pitch in `worldSize` space */
const SV_TILE = 512;

/** Number of tiles and the cropped content size for a pano at a given zoom.
 *  The tile grid rounds up to a power of two; the real image only spans
 *  `worldSize`. Scale the content down to the requested zoom and crop to it.
 *  Zoom is clamped to the pano's max (derived from its real width). Falls back
 *  to the full grid when metadata is unavailable. */
export function panoTileLayout(
	zoom: number,
	worldSize?: google.maps.Size,
): { zoom: number; cols: number; rows: number; width: number; height: number; tile: number } {
	let z = zoom;
	let width: number;
	let height: number;
	if (worldSize?.width && worldSize?.height) {
		const maxZoom = Math.ceil(Math.log2(worldSize.width / SV_TILE));
		z = Math.min(Math.max(zoom, 0), maxZoom);
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
): Promise<ImageBitmap | null> {
	const url = panoTileUrl(panoId, x, y, z);
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

/** Stitch a Google panorama's tiles onto a canvas at the given zoom. Null if no tiles loaded. */
export async function stitchPano(
	panoId: string,
	meta: PanoData | null | undefined,
	zoom: number,
): Promise<HTMLCanvasElement | null> {
	const { zoom: z, cols, rows, width, height, tile } = panoTileLayout(zoom, meta?.tiles?.worldSize);

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

export interface DownloadPanoOpts {
	/** Owning location — required for Baidu / Look Around (buildId, CRS, etc.). */
	location?: Location | null;
	provider?: SvProvider;
	zoom?: number;
}

/** Download the full panorama as a single stitched JPEG. Toasts on success/failure. */
export async function downloadPano(
	panoId: string,
	zoomOrOpts: number | DownloadPanoOpts = 5,
): Promise<void> {
	const opts: DownloadPanoOpts =
		typeof zoomOrOpts === "number" ? { zoom: zoomOrOpts } : (zoomOrOpts ?? {});
	const zoom = opts.zoom ?? 5;
	const provider = opts.provider ?? getLocationProvider(opts.location);
	try {
		let canvas: HTMLCanvasElement | null = null;
		if (provider === "baidu") {
			canvas = await stitchBaiduPano(panoId, zoom);
		} else if (provider === "tencent") {
			canvas = await stitchTencentPano(panoId, zoom);
		} else if (provider === "apple") {
			if (!opts.location) throw new Error("Look Around download needs a location");
			canvas = await stitchLookaroundPano(opts.location, panoId, zoom);
		} else {
			const [meta] = await fetchSvMetadata([panoId]);
			canvas = await stitchPano(panoId, meta, zoom);
		}
		if (!canvas) throw new Error("no tiles loaded");

		const blob = await new Promise<Blob | null>((res) => canvas!.toBlob(res, "image/jpeg", 0.95));
		if (!blob) throw new Error("encode failed");

		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		const fileStem =
			provider === "baidu"
				? stripBaidu(panoId)
				: provider === "tencent"
					? stripTencent(panoId)
					: panoId;
		a.download = `${fileStem || panoId}.jpg`;
		a.click();
		URL.revokeObjectURL(a.href);
		toast("Panorama downloaded");
	} catch {
		toast("Panorama download failed");
	}
}

export interface BulkDownloadResult {
	succeeded: number[];
	failed: number[];
	/** Temp file (single image or ZIP) ready for the export save dialog; null when nothing downloaded. */
	outputPath: string | null;
	suggestedName: string | null;
	fileCount: number;
}

const META_BATCH = 200;
const DOWNLOAD_CONCURRENCY = 4;

// --- Per-location rendering ---

function canvasToBlob(
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function fetchImage(url: string): Promise<Blob | null> {
	try {
		const resp = await fetch(url);
		return resp.ok ? await resp.blob() : null;
	} catch {
		return null;
	}
}

/** Render one Google location's image per the configured mode. Null on failure. */
async function renderGoogleLocationImage(
	loc: Location,
	panoId: string,
	meta: PanoData | null,
	config: PanoDownloadConfig,
): Promise<RenderedPanoImage | null> {
	const name = panoId;

	if (config.mode === "thumbnail") {
		const url = new URL(svThumbnailUrl(panoId, loc.heading, 1024, 768));
		url.searchParams.set("pitch", String(loc.pitch));
		const blob = await fetchImage(url.toString());
		return blob ? { blob, fileName: `${name}.png` } : null;
	}

	if (config.mode === "tile") {
		const blob = await fetchImage(panoTileUrl(panoId, config.tileX, config.tileY, config.zoom));
		return blob
			? { blob, fileName: `${name}_z${config.zoom}_x${config.tileX}_y${config.tileY}.jpg` }
			: null;
	}

	const canvas = await stitchPano(panoId, meta, config.zoom);
	if (!canvas) return null;

	if (config.mode === "perspective") {
		const centerHeading = meta?.extra?.drivingDirection ?? 0;
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

/** Modes unsupported for a provider — skip without counting as download failure. */
export function shouldSkipPanoDownload(loc: Location, config: PanoDownloadConfig): boolean {
	const provider = getLocationProvider(loc);
	if (config.mode === "tile" && provider !== "google") return true;
	if (config.mode === "thumbnail" && provider === "apple") return true;
	return false;
}

async function renderLocationImage(
	loc: Location,
	panoId: string,
	meta: PanoData | null,
	config: PanoDownloadConfig,
): Promise<RenderedPanoImage | null> {
	if (shouldSkipPanoDownload(loc, config)) return null;
	const provider = getLocationProvider(loc);
	if (provider === "baidu") return renderBaiduLocationImage(loc, panoId, config);
	if (provider === "tencent") return renderTencentLocationImage(loc, panoId, config);
	if (provider === "apple") return renderLookaroundLocationImage(loc, panoId, config);
	return renderGoogleLocationImage(loc, panoId, meta, config);
}

// --- Bulk orchestration ---

async function fetchMetadataMap(
	panoIds: string[],
	signal?: AbortSignal,
): Promise<Map<string, PanoData>> {
	const unique = [...new Set(panoIds)];
	const out = new Map<string, PanoData>();
	for (let i = 0; i < unique.length; i += META_BATCH) {
		signal?.throwIfAborted();
		const batch = unique.slice(i, i + META_BATCH);
		const datas = await fetchSvMetadata(batch);
		for (let j = 0; j < batch.length; j++) {
			if (datas[j]) out.set(batch[j], datas[j]!);
		}
	}
	return out;
}

/** Resolve missing pano IDs with the location's own imagery provider. */
async function resolveMissingPanoIds(
	locations: Location[],
	opts: {
		signal?: AbortSignal;
		onProgress?: (done: number, total: number) => void;
	},
): Promise<{ resolved: Map<number, string>; failed: number[] }> {
	const resolved = new Map<number, string>();
	const failed: number[] = [];
	const { signal, onProgress } = opts;

	const google: Location[] = [];
	const baidu: Location[] = [];
	const tencent: Location[] = [];
	const apple: Location[] = [];
	for (const loc of locations) {
		switch (getLocationProvider(loc)) {
			case "baidu":
				baidu.push(loc);
				break;
			case "tencent":
				tencent.push(loc);
				break;
			case "apple":
				apple.push(loc);
				break;
			default:
				google.push(loc);
		}
	}

	const total = locations.length;
	let done = 0;
	const bump = () => {
		done++;
		onProgress?.(done, total);
	};

	if (google.length > 0) {
		const res = await resolvePanoIds(google, {
			signal,
			onProgress: (d) => onProgress?.(done + d, total),
		});
		for (const r of res.resolved) resolved.set(r.id, r.panoId);
		failed.push(...res.failed);
		done += google.length;
		onProgress?.(done, total);
	}

	await runConcurrent(
		[...baidu, ...tencent, ...apple],
		async (loc) => {
			signal?.throwIfAborted();
			try {
				const prov = getLocationProvider(loc);
				if (prov === "baidu") {
					const meta = await resolveBaiduNear(loc.lat, loc.lng);
					if (meta?.id) resolved.set(loc.id, meta.id);
					else failed.push(loc.id);
				} else if (prov === "tencent") {
					const meta = await resolveTencentNear(loc.lat, loc.lng);
					if (meta?.id) resolved.set(loc.id, meta.id);
					else failed.push(loc.id);
				} else {
					const pano = await getClosestPano(loc.lat, loc.lng);
					if (pano?.panoid) resolved.set(loc.id, pano.panoid);
					else failed.push(loc.id);
				}
			} catch {
				failed.push(loc.id);
			}
			bump();
		},
		{ concurrency: DOWNLOAD_CONCURRENCY, signal },
	);

	return { resolved, failed };
}

/** Download panoramas for `locations`, uploading each image into a Rust session
 *  dir (via mma-buf POST) that is packaged into a single file or Stored ZIP. */
export async function bulkDownloadPanoramas(
	locations: Location[],
	config: PanoDownloadConfig,
	opts: {
		signal?: AbortSignal;
		onProgress?: (done: number, total: number, label?: string) => void;
	} = {},
): Promise<BulkDownloadResult> {
	const { signal, onProgress } = opts;
	const succeeded: number[] = [];
	const failed: number[] = [];

	const needResolve = locations.filter((l) => !l.panoId);
	const resolvedMap = new Map<number, string>();
	if (needResolve.length > 0) {
		onProgress?.(0, needResolve.length, "Resolving pano IDs");
		const res = await resolveMissingPanoIds(needResolve, {
			signal,
			onProgress: (d, t) => onProgress?.(d, t, "Resolving pano IDs"),
		});
		for (const [id, panoId] of res.resolved) resolvedMap.set(id, panoId);
		failed.push(...res.failed);
	}

	const pending = locations.flatMap((loc) => {
		const panoId = loc.panoId ?? resolvedMap.get(loc.id);
		if (!panoId) return [];
		// Skip unsupported provider/mode pairs (non-Google tile, Apple thumbnail).
		if (shouldSkipPanoDownload(loc, config)) return [];
		return [{ loc, panoId }];
	});
	if (pending.length === 0) {
		return { succeeded, failed, outputPath: null, suggestedName: null, fileCount: 0 };
	}

	// Google metadata drives tile layout and center heading; other providers ignore it.
	let metaMap = new Map<string, PanoData>();
	const googlePending = pending.filter((p) => getLocationProvider(p.loc) === "google");
	if (
		(config.mode === "equirectangular" || config.mode === "perspective") &&
		googlePending.length > 0
	) {
		onProgress?.(0, googlePending.length, "Fetching metadata");
		metaMap = await fetchMetadataMap(
			googlePending.map((p) => p.panoId),
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
		onProgress?.(0, pending.length, "Downloading");
		await runConcurrent(
			pending,
			async ({ loc, panoId }) => {
				const image = await renderLocationImage(
					loc,
					panoId,
					metaMap.get(panoId) ?? null,
					config,
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
				(ok ? succeeded : failed).push(loc.id);
				done++;
				onProgress?.(done, pending.length, "Downloading");
			},
			{ concurrency: DOWNLOAD_CONCURRENCY, signal },
		);
	} catch (e) {
		await cmd.storeUploadAbort(session).catch(() => {});
		throw e;
	}

	if (succeeded.length === 0) {
		await cmd.storeUploadAbort(session).catch(() => {});
		return { succeeded, failed, outputPath: null, suggestedName: null, fileCount: 0 };
	}

	const outputPath = await cmd.storeUploadFinish(session);
	const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
	const suggestedName =
		succeeded.length === 1 && singleName ? singleName : `panoramas-${stamp}.zip`;
	return { succeeded, failed, outputPath, suggestedName, fileCount: succeeded.length };
}
