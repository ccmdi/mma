import { TileConfig, LayerType, buildSvCoverageConfig, buildTileUrl } from "@/lib/geo/tiles";
import { latLngToWorld, worldToTile, pixelToLatLng, TILE_SIZE } from "@/lib/geo/mercator";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { chunk, shuffle } from "@/lib/util/util";
import { streamedPoints } from "./pointSources";
import type { PointSource } from "./types";
import type { PolygonGeometry } from "@/bindings.gen";
import type { Bounds, LatLng } from "@/types";

const CLIP_BATCH = 50_000;

const MAX_TILES_PER_AXIS = 150;
/** The axis cap whose zoom sets the point-density baseline that `keepRate` thins to. */
const BASE_TILES_PER_AXIS = 50;
const FETCH_CONCURRENCY = 24;
const SCAN_YIELD_EVERY = 6;

/** Finer tiles put the jittered probe on the road instead of somewhere in a coarse
 *  pixel's cell; thinning each pixel back to the base zoom's line density keeps the
 *  point supply, memory and clip cost where they were. */
export function keepRate(zoom: number, baseZoom: number): number {
	return Math.min(1, 2 ** (baseZoom - zoom));
}

const EVEN_TILE_POINTS = 600;

/** Probes per area the `distribution` setting buys, from road-density-proportional to
 *  a flat share per tile. */
export const DISTRIBUTION_EVENNESS = { density: 0, balanced: 0.5, even: 1 } as const;

/** A tile's pixel keep-probability: density keeps `globalKeep` everywhere, even aims
 *  at a flat point count per tile, and `evenness` blends between them. */
export function tileKeepRate(rawCount: number, globalKeep: number, evenness: number): number {
	if (rawCount === 0) return 0;
	const even = Math.min(1, EVEN_TILE_POINTS / rawCount);
	return (1 - evenness) * globalKeep + evenness * even;
}

function thin(xs: number[], ys: number[], from: number, keep: number) {
	if (keep >= 1) return;
	let w = from;
	for (let i = from; i < xs.length; i++) {
		if (Math.random() < keep) {
			xs[w] = xs[i];
			ys[w] = ys[i];
			w++;
		}
	}
	xs.length = w;
	ys.length = w;
}

/** Columns run east from the northwest tile, wrapping the world, so a region crossing
 *  the antimeridian counts forward instead of coming out negative and scanning nothing. */
function tileCols(nwX: number, seX: number, zoom: number): number {
	const perAxis = 2 ** zoom;
	return ((seX - nwX + perAxis) % perAxis) + 1;
}

export function calculateZoom(b: Bounds, maxPerAxis: number) {
	const nwWorld = latLngToWorld({ lat: b.north, lng: b.west });
	const seWorld = latLngToWorld({ lat: b.south, lng: b.east });
	for (let zoom = 16; zoom >= 0; zoom--) {
		const nw = worldToTile(nwWorld.x, nwWorld.y, zoom);
		const se = worldToTile(seWorld.x, seWorld.y, zoom);
		const cols = tileCols(nw.x, se.x, zoom);
		const rows = se.y - nw.y + 1;
		if (cols <= maxPerAxis && rows <= maxPerAxis) {
			return { zoom, nwTile: nw, seTile: se, cols, rows };
		}
	}
	const nw = worldToTile(nwWorld.x, nwWorld.y, 0);
	const se = worldToTile(seWorld.x, seWorld.y, 0);
	return { zoom: 0, nwTile: nw, seTile: se, cols: tileCols(nw.x, se.x, 0), rows: se.y - nw.y + 1 };
}

function buildSamplerTileConfig(): TileConfig {
	const { cc, svl, mapStyles } = buildSvCoverageConfig({
		showOfficial: true,
		showUnofficial: true,
		styles: [{ stylers: [{ color: "#ffffff" }] }],
		useDetailedLines: true,
	});
	return new TileConfig({
		query: { tile: {} },
		layers: [
			{
				type: LayerType.STREETVIEW,
				layerName: "svv",
				layerOptions: [
					{ key: "cc", value: cc },
					{ key: "svl", value: svl },
				],
			},
		],
		options: { language: "en", region: "US", styles: mapStyles },
		renderOptions: { scale: 1 },
	});
}

async function fetchTileBlob(
	cfg: TileConfig,
	tileX: number,
	tileY: number,
	zoom: number,
): Promise<ImageBitmap | null> {
	const url = buildTileUrl(cfg, tileX, tileY, zoom);
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		return await createImageBitmap(await resp.blob());
	} catch {
		return null;
	}
}

function scanTile(
	bmp: ImageBitmap,
	tileX: number,
	tileY: number,
	ctx: OffscreenCanvasRenderingContext2D,
	pixelXs: number[],
	pixelYs: number[],
) {
	ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
	ctx.drawImage(bmp, 0, 0);
	bmp.close();
	const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
	const baseX = tileX * TILE_SIZE;
	const baseY = tileY * TILE_SIZE;
	for (let py = 0; py < TILE_SIZE; py++) {
		for (let px = 0; px < TILE_SIZE; px++) {
			if (data[(py * TILE_SIZE + px) * 4 + 3] > 0) {
				pixelXs.push(baseX + px);
				pixelYs.push(baseY + py);
			}
		}
	}
}

async function clipToPolygon(polygon: PolygonGeometry, candidates: LatLng[]): Promise<LatLng[]> {
	const result: LatLng[] = [];
	for (const batch of chunk(candidates, CLIP_BATCH)) {
		// eslint-disable-next-line local/no-ipc-in-loop -- already bulk: 50k points per round trip
		const inside = await cmd.polygonContainsPoints(
			polygon,
			batch.map((p) => p.lat),
			batch.map((p) => p.lng),
		);
		for (let i = 0; i < batch.length; i++) if (inside[i]) result.push(batch[i]);
	}
	return result;
}

/** Tiles land in random order and each scanned batch is released as soon as it is clipped,
 *  so probing starts on the first tiles while the rest are still downloading. Two passes:
 *  a coarse one covers the whole region in seconds, so a run that stops early still probed
 *  everywhere, then the fine pass replaces each tile's coarse points as it lands. */
export function blueLineSource(
	polygon: PolygonGeometry,
	evenness = 0,
	maxTilesPerAxis = MAX_TILES_PER_AXIS,
): PointSource {
	return streamedPoints(async (emit, retire) => {
		const box = await cmd.polygonBounds(polygon);
		if (!box) return;
		const bounds: Bounds = { west: box[0], south: box[1], east: box[2], north: box[3] };
		const fine = calculateZoom(bounds, maxTilesPerAxis);
		const coarse = calculateZoom(bounds, BASE_TILES_PER_AXIS);
		const keep = keepRate(fine.zoom, coarse.zoom);
		const finePerAxis = 2 ** fine.zoom;
		const fineKey = (p: LatLng) => {
			const w = latLngToWorld(p);
			const t = worldToTile(w.x, w.y, fine.zoom);
			return t.y * finePerAxis + t.x;
		};
		log.info(
			`[generator] Blue line: ${fine.cols * fine.rows} tiles (${fine.cols}x${fine.rows}) at zoom ${fine.zoom}, keeping ${Math.round(keep * 100)}% of pixels`,
		);

		const cfg = buildSamplerTileConfig();
		const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
		const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

		let total = 0;
		const pass = async (
			plan: ReturnType<typeof calculateZoom>,
			globalKeep: number,
			deliver: (points: LatLng[], scanned: { tx: number; ty: number }[]) => void,
		) => {
			const tileJobs: { tx: number; ty: number }[] = [];
			const perAxis = 2 ** plan.zoom;
			for (let ty = plan.nwTile.y; ty <= plan.seTile.y; ty++) {
				for (let c = 0; c < plan.cols; c++) {
					tileJobs.push({ tx: (plan.nwTile.x + c) % perAxis, ty });
				}
			}
			shuffle(tileJobs);

			// Fetch tiles concurrently, scan pixels sequentially (canvas is shared)
			for (const batch of chunk(tileJobs, FETCH_CONCURRENCY)) {
				const bmps = await Promise.all(batch.map((j) => fetchTileBlob(cfg, j.tx, j.ty, plan.zoom)));
				const pixelXs: number[] = [];
				const pixelYs: number[] = [];
				const scanned: { tx: number; ty: number }[] = [];
				for (let b = 0; b < batch.length; b++) {
					const bmp = bmps[b];
					if (!bmp) continue;
					scanned.push(batch[b]);
					const start = pixelXs.length;
					scanTile(bmp, batch[b].tx, batch[b].ty, ctx, pixelXs, pixelYs);
					thin(pixelXs, pixelYs, start, tileKeepRate(pixelXs.length - start, globalKeep, evenness));
					if (b % SCAN_YIELD_EVERY === SCAN_YIELD_EVERY - 1) {
						await new Promise((resolve) => setTimeout(resolve));
					}
				}
				const candidates: LatLng[] = new Array(pixelXs.length);
				for (let i = 0; i < pixelXs.length; i++) {
					candidates[i] = pixelToLatLng(
						pixelXs[i] + Math.random(),
						pixelYs[i] + Math.random(),
						plan.zoom,
					);
				}
				const points = candidates.length > 0 ? await clipToPolygon(polygon, candidates) : [];
				total += points.length;
				deliver(points, scanned);
			}
		};

		if (fine.zoom > coarse.zoom) {
			await pass(coarse, keepRate(coarse.zoom, coarse.zoom), (points) => {
				const byKey = new Map<number, LatLng[]>();
				for (const p of points) {
					const k = fineKey(p);
					let group = byKey.get(k);
					if (!group) byKey.set(k, (group = []));
					group.push(p);
				}
				for (const [k, group] of byKey) emit(group, k);
			});
		}
		// A fine tile that failed to fetch is not scanned, so its coarse points stay.
		await pass(fine, keep, (points, scanned) => {
			if (fine.zoom > coarse.zoom) {
				for (const t of scanned) retire(t.ty * finePerAxis + t.tx);
			}
			if (points.length > 0) emit(points);
		});

		log.info(`[generator] Blue line: ${total} sample points after polygon clip`);
	});
}
