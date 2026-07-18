/**
 * Build Google json+protobuf GetMetadata / SingleImageSearch payloads for Baidu
 * panos (field layout matches altproviders.js ImageMetadata PBLite arrays).
 */
import type { BaiduLink, BaiduPanoMeta } from "./api";
import { offsetLatLng } from "./api";
import { prefixBaidu, isBaiduPanoId } from "./prefix";

const OFFICIAL = 2;
const PHOTOSPHERE = 2;
const STATUS_OK = 0;
const IMAGE_OK = 1;
const NO_RESULTS = 5;

const TARGET_OVERLAY_WIDTH = 32;
const TARGET_OVERLAY_HEIGHT = 16;

function size(width: number, height: number): unknown[] {
	// Size: height → [0], width → [1] (altproviders / protobuf ImageSize)
	const a: unknown[] = [];
	a[0] = height;
	a[1] = width;
	return a;
}

function latLng(lat: number, lng: number): unknown[] {
	const a: unknown[] = [];
	a[2] = lat;
	a[3] = lng;
	return a;
}

function imageKey(id: string): unknown[] {
	return [OFFICIAL, id];
}

function linkProps(heading: number): unknown[] {
	const a: unknown[] = [];
	a[3] = heading;
	return a;
}

/** Location payload holes match altproviders ImageLocation PBLite layout. */
function imageLocation(
	ll: unknown[],
	pov: number[],
	country = "CN",
): unknown[] {
	const a: unknown[] = [];
	a[0] = ll;
	a[2] = pov;
	a[4] = country;
	return a;
}

function linkedPanorama(key: unknown[], location: unknown[]): unknown[] {
	const a: unknown[] = [];
	a[0] = key;
	a[2] = location;
	return a;
}

function statusMessage(code: number, message: string): unknown[] {
	const a: unknown[] = [];
	a[0] = code;
	a[2] = message;
	return a;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

function distSquared(
	a: [number, number],
	b: [number, number],
): number {
	const d0 = b[0]! - a[0]!;
	const d1 = b[1]! - a[1]!;
	return d0 * d0 + d1 * d1;
}

/**
 * altproviders buildTargetOverlayFixed — maps (heading × distance bands) to
 * neighbor panorama indices so clickToGo can jump beyond arrow links.
 */
export function buildTargetOverlay(
	neighbors: BaiduLink[],
	origin: { lat: number; lng: number; heading: number },
): unknown[] | null {
	if (neighbors.length === 0) return null;

	const positions = neighbors.map((n, index) => ({
		index,
		position: [n.lng, n.lat] as [number, number],
	}));
	const overlay = new Uint8Array(TARGET_OVERLAY_WIDTH * TARGET_OVERLAY_HEIGHT);

	for (let y = 0; y < 1; y += 1 / TARGET_OVERLAY_HEIGHT) {
		let distance : number;
		if (y > 0.48 && y <= 0.5) distance = 100;
		else if (y > 0.5 && y <= 0.52) distance = 80;
		else if (y > 0.52 && y <= 0.54) distance = 60;
		else if (y > 0.54 && y <= 0.58) distance = 35;
		else if (y > 0.58 && y <= 0.64) distance = 15;
		else continue;

		for (let x = 0; x < 1; x += 1 / TARGET_OVERLAY_WIDTH) {
			const heading = (x - 0.5) * 360 + origin.heading;
			const dest = offsetLatLng(origin.lat, origin.lng, heading, distance);
			const probe: [number, number] = [dest.lng, dest.lat];
			let best = positions[0]!;
			let bestD = distSquared(probe, best.position);
			for (let i = 1; i < positions.length; i += 1) {
				const p = positions[i]!;
				const d = distSquared(probe, p.position);
				if (d < bestD) {
					best = p;
					bestD = d;
				}
			}
			const yi = Math.min(
				TARGET_OVERLAY_HEIGHT - 1,
				Math.round(y * TARGET_OVERLAY_HEIGHT),
			);
			const xi = Math.min(
				TARGET_OVERLAY_WIDTH - 1,
				Math.round(x * TARGET_OVERLAY_WIDTH),
			);
			overlay[yi * TARGET_OVERLAY_WIDTH + xi] = best.index;
		}
	}

	// Overlays PBLite: targetFormat → [2], targetOverlay → [3]
	const targetFormat: unknown[] = [];
	targetFormat[0] = 1; // encoding

	const targetOverlay: unknown[] = [];
	targetOverlay[0] = size(TARGET_OVERLAY_WIDTH, TARGET_OVERLAY_HEIGHT);
	targetOverlay[1] = 1;
	// altproviders: btoa(toBase64(bytes)) — double-encode so JSONP cast (atob)
	// leaves a single base64 string for the Maps client.
	targetOverlay[2] = btoa(bytesToBase64(overlay));

	const overlays: unknown[] = [];
	overlays[2] = targetFormat;
	overlays[3] = targetOverlay;
	return overlays;
}

/** One ImageMetadata result array for a Baidu capture. */
export function buildBaiduImageMetadata(meta: BaiduPanoMeta): unknown[] {
	const panoId = prefixBaidu(meta.id);
	const panoramas: unknown[] = [];
	const links: unknown[] = [];
	const times: unknown[] = [];
	const neighborIndex = new Map<string, number>();

	// ClickToGo candidates first (altproviders: Links + all Roads panos).
	const neighbors = meta.neighbors.length > 0 ? meta.neighbors : meta.links;
	for (const n of neighbors) {
		if (!n.pid || neighborIndex.has(n.pid)) continue;
		const index = panoramas.length;
		neighborIndex.set(n.pid, index);
		panoramas.push(
			linkedPanorama(
				imageKey(prefixBaidu(n.pid)),
				imageLocation(latLng(n.lat, n.lng), [meta.heading]),
			),
		);
	}

	for (const l of meta.links) {
		if (!l.pid) continue;
		let index = neighborIndex.get(l.pid);
		if (index == null) {
			index = panoramas.length;
			neighborIndex.set(l.pid, index);
			panoramas.push(
				linkedPanorama(
					imageKey(prefixBaidu(l.pid)),
					imageLocation(latLng(l.lat, l.lng), [meta.heading]),
				),
			);
		}
		links.push([index, linkProps(l.heading)]);
	}

	// Build overlay from neighbor slots only (before timeline stubs).
	const overlays = buildTargetOverlay(neighbors, {
		lat: meta.lat,
		lng: meta.lng,
		heading: meta.heading,
	});

	for (const t of meta.timeline) {
		if (!t.id) continue;
		const index = panoramas.length;
		const tid = prefixBaidu(t.id);
		panoramas.push(
			linkedPanorama(
				imageKey(tid),
				imageLocation(
					latLng(meta.lat, meta.lng),
					[meta.heading, meta.pitch, meta.roll],
				),
			),
		);
		const date: unknown[] = [];
		date[0] = t.year;
		date[1] = t.month;
		times.push([index, date]);
	}

	const year = Number(meta.date.slice(0, 4)) || 0;
	const month = Number(meta.date.slice(4, 6)) || 1;
	const day = Number(meta.date.slice(6, 8)) || 1;

	// Baidu ImgLayer max is typically 16×8 ×256 = 4096×2048 (Google zoom 0–3).
	const tiles: unknown[] = [];
	tiles[0] = OFFICIAL;
	tiles[1] = PHOTOSPHERE;
	tiles[2] = size(4096, 2048);
	tiles[3] = [
		[size(512, 256), size(1024, 512), size(2048, 1024), size(4096, 2048)],
		size(512, 512),
	];
	tiles[9] = panoId;

	const description: unknown[] = [];
	if (meta.roadName) {
		description[2] = [[meta.roadName, "CN"]];
	}

	const attribution: unknown[] = [];
	attribution[0] = [[["Baidu"], "https://map.baidu.com"]];

	const includesDate: unknown[] = [];
	includesDate[7] = [year, month, day];

	const locationEntry: unknown[] = [];
	locationEntry[0] = [IMAGE_OK];
	// altproviders: main location POV is heading-only.
	locationEntry[1] = imageLocation(latLng(meta.lat, meta.lng), [meta.heading]);
	locationEntry[3] = [panoramas];
	if (overlays) locationEntry[5] = overlays;
	locationEntry[6] = links;
	locationEntry[8] = times;

	const metaArr: unknown[] = [];
	metaArr[0] = [IMAGE_OK];
	metaArr[1] = imageKey(panoId);
	metaArr[2] = tiles;
	metaArr[3] = description;
	metaArr[4] = attribution;
	metaArr[5] = [locationEntry];
	metaArr[6] = includesDate;
	metaArr[7] = ["https://map.baidu.com"];
	return metaArr;
}

export function buildGetMetadataResponse(metas: BaiduPanoMeta[]): unknown[] {
	return [[STATUS_OK], metas.map(buildBaiduImageMetadata)];
}

export function buildSingleImageSearchOk(meta: BaiduPanoMeta): unknown[] {
	return [[STATUS_OK], buildBaiduImageMetadata(meta)];
}

export function buildSingleImageSearchNoResults(): unknown[] {
	return [statusMessage(NO_RESULTS, "No results")];
}

/** Extract BAIDU: pano ids from a GetMetadataRequest json+protobuf body. */
export function baiduIdsFromGetMetadataRequest(body: unknown): string[] | null {
	if (!Array.isArray(body)) return null;
	const queries = body[2];
	if (!Array.isArray(queries) || queries.length === 0) return null;
	const ids: string[] = [];
	for (const q of queries) {
		const id = Array.isArray(q) && Array.isArray(q[0]) ? q[0][1] : null;
		if (typeof id !== "string" || !isBaiduPanoId(id)) return null;
		ids.push(id);
	}
	return ids;
}

/** Read lat/lng/radius from SingleImageSearchRequest json+protobuf body. */
export function latLngFromSingleImageSearchRequest(
	body: unknown,
): { lat: number; lng: number; radius: number } | null {
	if (!Array.isArray(body)) return null;
	const loc = body[1];
	if (!Array.isArray(loc)) return null;
	const center = loc[0];
	if (!Array.isArray(center)) return null;
	const lat = Number(center[2]);
	const lng = Number(center[3]);
	const radius = Number(loc[1] ?? 100);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { lat, lng, radius: Number.isFinite(radius) && radius > 0 ? radius : 100 };
}

export function isBaiduPrefixedKey(id: unknown): boolean {
	return typeof id === "string" && isBaiduPanoId(id);
}
