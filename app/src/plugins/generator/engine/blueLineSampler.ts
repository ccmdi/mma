import { TileConfig, LayerType, buildSvCoverageConfig, buildTileUrl } from "@/lib/geo/tiles";
import { getBoundingBox, pointInGeoJsonGeometry } from "./geo";
import { latLngToWorld, worldToTile, pixelToLatLng, TILE_SIZE } from "@/lib/geo/mercator";
import { log } from "@/lib/util/log";
import { chunk } from "@/lib/util/util";
import type { Bounds, LatLng } from "@/types";

const MAX_TILES_PER_AXIS = 50;
const FETCH_CONCURRENCY = 10;

/** Columns run east from the northwest tile, wrapping the world, so a region crossing
 *  the antimeridian counts forward instead of coming out negative and scanning nothing. */
function tileCols(nwX: number, seX: number, zoom: number): number {
	const perAxis = 2 ** zoom;
	return ((seX - nwX + perAxis) % perAxis) + 1;
}

function calculateZoom(b: Bounds, maxPerAxis: number) {
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

export async function blueLineSample(
	feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
	maxTilesPerAxis = MAX_TILES_PER_AXIS,
): Promise<LatLng[]> {
	const bounds = getBoundingBox(feature);
	if (!bounds) return [];
	const { zoom, nwTile, seTile, cols, rows } = calculateZoom(bounds, maxTilesPerAxis);
	log.info(`[generator] Blue line: ${cols * rows} tiles (${cols}x${rows}) at zoom ${zoom}`);

	const cfg = buildSamplerTileConfig();
	const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
	const ctx = canvas.getContext("2d")!;
	const pixelXs: number[] = [];
	const pixelYs: number[] = [];

	const tileJobs: { tx: number; ty: number }[] = [];
	const perAxis = 2 ** zoom;
	for (let ty = nwTile.y; ty <= seTile.y; ty++) {
		for (let c = 0; c < cols; c++) {
			tileJobs.push({ tx: (nwTile.x + c) % perAxis, ty });
		}
	}

	// Fetch tiles concurrently, scan pixels sequentially (canvas is shared)
	for (const batch of chunk(tileJobs, FETCH_CONCURRENCY)) {
		const bmps = await Promise.all(batch.map((j) => fetchTileBlob(cfg, j.tx, j.ty, zoom)));
		for (let b = 0; b < batch.length; b++) {
			const bmp = bmps[b];
			if (!bmp) continue;
			scanTile(bmp, batch[b].tx, batch[b].ty, ctx, pixelXs, pixelYs);
		}
	}

	log.info(`[generator] Blue line: ${pixelXs.length} coverage pixels`);

	const result: LatLng[] = [];
	for (let i = 0; i < pixelXs.length; i++) {
		const pt = pixelToLatLng(pixelXs[i] + Math.random(), pixelYs[i] + Math.random(), zoom);
		if (pointInGeoJsonGeometry(pt.lng, pt.lat, feature.geometry)) {
			result.push(pt);
		}
	}

	for (let i = result.length - 1; i > 0; i--) {
		const j = (Math.random() * (i + 1)) | 0;
		const tmp = result[i];
		result[i] = result[j];
		result[j] = tmp;
	}

	log.info(`[generator] Blue line: ${result.length} sample points after polygon clip`);
	return result;
}
