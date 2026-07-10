import { zipSync } from "fflate";
import type { Location } from "@/bindings.gen";
import { resolvePanoIds } from "@/lib/sv/lookup";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { runConcurrent } from "@/lib/util/concurrent";
import { saveBlobAsFile } from "@/lib/util/saveBlobAsFile";
import {
	renderLocationImage,
	type DownloadRenderMode,
	type DownloadedImage,
} from "@/lib/sv/downloadPanorama";

const META_BATCH = 200;
const DOWNLOAD_CONCURRENCY = 4;

export interface BulkDownloadConfig {
	mode: DownloadRenderMode;
	zoom: number;
	tileX: number;
	tileY: number;
}

export interface DownloadProgressDetail {
	succeeded: number[];
	failed: number[];
}

export interface BulkDownloadResult {
	succeeded: number[];
	failed: number[];
	files: DownloadedImage[];
	/** Pre-built ZIP when multiple files; ready before the user clicks Save. */
	archive: Blob | null;
}

function locationFileName(loc: Location): string {
	return String(loc.id);
}

function centerHeadingFromMeta(
	meta: google.maps.StreetViewResolvedPanoramaData | null | undefined,
): number {
	return meta?.extra?.drivingDirection ?? 0;
}

async function fetchMetadataMap(
	panoIds: string[],
	signal?: AbortSignal,
): Promise<Map<string, google.maps.StreetViewResolvedPanoramaData>> {
	const unique = [...new Set(panoIds)];
	const out = new Map<string, google.maps.StreetViewResolvedPanoramaData>();
	for (let i = 0; i < unique.length; i += META_BATCH) {
		signal?.throwIfAborted();
		const batch = unique.slice(i, i + META_BATCH);
		const datas = await fetchSvMetadata(batch);
		for (let j = 0; j < batch.length; j++) {
			const data = datas[j];
			if (data) out.set(batch[j], data);
		}
	}
	return out;
}

/** Store-only ZIP — JPEG/PNG are already compressed; skipping deflate is much faster. */
async function buildZipAsync(files: DownloadedImage[]): Promise<Blob> {
	const entries: Record<string, Uint8Array> = {};
	for (const file of files) {
		entries[file.fileName] = new Uint8Array(await file.blob.arrayBuffer());
	}
	const zipped = zipSync(entries, { level: 0 });
	return new Blob([zipped], { type: "application/zip" });
}

/** Save downloaded images — single file as-is, multiple files as a pre-built or fresh ZIP. */
export async function saveDownloadedImages(
	files: DownloadedImage[],
	archive?: Blob | null,
): Promise<boolean> {
	if (files.length === 0) return false;
	if (files.length === 1) {
		const file = files[0];
		const ext = file.fileName.includes(".") ? file.fileName.split(".").pop()! : "jpg";
		return saveBlobAsFile(file.blob, {
			suggestedName: file.fileName,
			extension: ext,
			filterName: ext.toUpperCase(),
		});
	}
	const stamp = new Date().toISOString().slice(0, 10);
	const zipBlob = archive ?? (await buildZipAsync(files));
	return saveBlobAsFile(zipBlob, {
		suggestedName: `panoramas-${stamp}.zip`,
		extension: "zip",
		filterName: "ZIP archive",
	});
}

/** Bulk-download scoped locations; returns files and per-location outcomes for UI actions. */
export async function bulkDownloadPanoramas(
	locations: Location[],
	config: BulkDownloadConfig,
	opts: {
		signal?: AbortSignal;
		onProgress?: (
			done: number,
			total: number,
			label?: string,
			detail?: DownloadProgressDetail,
		) => void;
	} = {},
): Promise<BulkDownloadResult> {
	const { signal, onProgress } = opts;
	const total = locations.length;
	let done = 0;
	const succeeded: number[] = [];
	const failed: number[] = [];

	const report = (label?: string) => {
		onProgress?.(done, total, label, { succeeded: [...succeeded], failed: [...failed] });
	};

	report("Resolving pano IDs");
	const needResolve = locations.filter((l) => !l.panoId);
	const resolved = needResolve.length
		? await resolvePanoIds(needResolve, { signal, onProgress: () => {} })
		: { resolved: [], failed: [] };
	const resolvedMap = new Map(resolved.resolved.map((r) => [r.id, r.panoId]));

	for (const id of resolved.failed) failed.push(id);

	const pending = locations
		.map((loc) => ({
			loc,
			panoId: loc.panoId ?? resolvedMap.get(loc.id) ?? null,
		}))
		.filter((x): x is { loc: Location; panoId: string } => x.panoId != null);

	const pendingIds = new Set(pending.map((p) => p.loc.id));
	for (const loc of locations) {
		if (!pendingIds.has(loc.id) && !failed.includes(loc.id)) failed.push(loc.id);
	}

	if (pending.length === 0) {
		report("Done");
		return { succeeded, failed, files: [], archive: null };
	}

	report("Fetching metadata");
	const metaMap = await fetchMetadataMap(
		pending.map((p) => p.panoId),
		signal,
	);

	const files: DownloadedImage[] = [];

	await runConcurrent(
		pending,
		async ({ loc, panoId }) => {
			signal?.throwIfAborted();
			const meta = metaMap.get(panoId) ?? null;
			const image = await renderLocationImage({
				panoId,
				fileName: locationFileName(loc),
				meta,
				mode: config.mode,
				zoom: config.zoom,
				tileX: config.tileX,
				tileY: config.tileY,
				heading: loc.heading,
				pitch: loc.pitch,
				centerHeading: centerHeadingFromMeta(meta),
			});
			if (image) {
				files.push(image);
				succeeded.push(loc.id);
			} else {
				failed.push(loc.id);
			}
			done++;
			report("Downloading");
		},
		{ concurrency: DOWNLOAD_CONCURRENCY, signal },
	);

	let archive: Blob | null = null;
	if (files.length > 1) {
		report("Creating archive");
		archive = await buildZipAsync(files);
	}

	report("Done");
	return { succeeded, failed, files, archive };
}
