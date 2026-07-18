/**
 * Build Google json+protobuf GetMetadata / SingleImageSearch payloads for Tencent
 * panos (field layout matches altproviders.js ImageMetadata PBLite arrays).
 */
import type { TencentNeighbor, TencentPanoMeta } from "./api";
import { offsetLatLng } from "@/lib/sv/baidu/api";
import { prefixTencent, isTencentPanoId } from "./prefix";

function linkProps(heading: number): unknown[] {
	const a: unknown[] = [];
	a[3] = heading;
	return a;
}

const OFFICIAL = 2;
const PHOTOSPHERE = 2;
const STATUS_OK = 0;
const IMAGE_OK = 1;
const NO_RESULTS = 5;

const TARGET_OVERLAY_WIDTH = 32;
const TARGET_OVERLAY_HEIGHT = 16;

function size(width: number, height: number): unknown[] {
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

function distSquared(a: [number, number], b: [number, number]): number {
	const d0 = b[0]! - a[0]!;
	const d1 = b[1]! - a[1]!;
	return d0 * d0 + d1 * d1;
}

export function buildTargetOverlay(
	neighbors: TencentNeighbor[],
	origin: { lat: number; lng: number; heading: number },
): unknown[] | null {
	if (neighbors.length === 0) return null;

	const positions = neighbors.map((n, index) => ({
		index,
		position: [n.lng, n.lat] as [number, number],
	}));
	const overlay = new Uint8Array(TARGET_OVERLAY_WIDTH * TARGET_OVERLAY_HEIGHT);

	for (let y = 0; y < 1; y += 1 / TARGET_OVERLAY_HEIGHT) {
		let distance: number;
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

	const targetFormat: unknown[] = [];
	targetFormat[0] = 1;

	const targetOverlay: unknown[] = [];
	targetOverlay[0] = size(TARGET_OVERLAY_WIDTH, TARGET_OVERLAY_HEIGHT);
	targetOverlay[1] = 1;
	targetOverlay[2] = btoa(bytesToBase64(overlay));

	const overlays: unknown[] = [];
	overlays[2] = targetFormat;
	overlays[3] = targetOverlay;
	return overlays;
}

export function buildTencentImageMetadata(meta: TencentPanoMeta): unknown[] {
	const panoId = prefixTencent(meta.id);
	const panoramas: unknown[] = [];
	const links: unknown[] = [];
	const times: unknown[] = [];
	const neighborIndex = new Map<string, number>();

	// ClickToGo candidates first (altproviders: all_scenes → panoramaRefs + overlays).
	const neighbors = meta.neighbors.length > 0 ? meta.neighbors : meta.links;
	for (const n of neighbors) {
		if (!n.svid || neighborIndex.has(n.svid)) continue;
		const index = panoramas.length;
		neighborIndex.set(n.svid, index);
		panoramas.push(
			linkedPanorama(
				imageKey(prefixTencent(n.svid)),
				// altproviders: neighbor POV heading is 0
				imageLocation(latLng(n.lat, n.lng), [0]),
			),
		);
	}

	// Arrow links — altproviders left this empty; we fill from selectNavigableLinks.
	for (const l of meta.links) {
		if (!l.svid) continue;
		let index = neighborIndex.get(l.svid);
		if (index == null) {
			index = panoramas.length;
			neighborIndex.set(l.svid, index);
			panoramas.push(
				linkedPanorama(
					imageKey(prefixTencent(l.svid)),
					imageLocation(latLng(l.lat, l.lng), [0]),
				),
			);
		}
		links.push([index, linkProps(l.heading)]);
	}

	const overlays = buildTargetOverlay(neighbors, {
		lat: meta.lat,
		lng: meta.lng,
		heading: meta.heading,
	});

	for (const t of meta.timeline) {
		if (!t.svid) continue;
		const index = panoramas.length;
		panoramas.push(
			linkedPanorama(
				imageKey(prefixTencent(t.svid)),
				imageLocation(latLng(meta.lat, meta.lng), [meta.heading]),
			),
		);
		const date: unknown[] = [];
		date[0] = t.year;
		date[1] = t.month;
		date[2] = t.day;
		times.push([index, date]);
	}

	const d = meta.captureDate;

	const tiles: unknown[] = [];
	tiles[0] = OFFICIAL;
	tiles[1] = PHOTOSPHERE;
	tiles[2] = size(16384, 8192);
	tiles[3] = [
		[
			size(512, 256),
			size(512, 256),
			size(2048, 1024),
			size(4096, 2048),
			size(8192, 4096),
			size(16384, 8192),
		],
		size(512, 512),
	];
	tiles[9] = panoId;

	const attribution: unknown[] = [];
	attribution[0] = [[["Tencent"], "https://map.qq.com"]];

	const includesDate: unknown[] = [];
	includesDate[7] = [d.getFullYear(), d.getMonth(), d.getDate()];

	const locationEntry: unknown[] = [];
	locationEntry[0] = [IMAGE_OK];
	locationEntry[1] = imageLocation(latLng(meta.lat, meta.lng), [meta.heading]);
	locationEntry[3] = [panoramas];
	if (overlays) locationEntry[5] = overlays;
	locationEntry[6] = links;
	locationEntry[8] = times;

	const metaArr: unknown[] = [];
	metaArr[0] = [IMAGE_OK];
	metaArr[1] = imageKey(panoId);
	metaArr[2] = tiles;
	metaArr[4] = attribution;
	metaArr[5] = [locationEntry];
	metaArr[6] = includesDate;
	metaArr[7] = ["https://map.qq.com"];
	return metaArr;
}

export function buildGetMetadataResponse(metas: TencentPanoMeta[]): unknown[] {
	return [[STATUS_OK], metas.map(buildTencentImageMetadata)];
}

export function buildSingleImageSearchOk(meta: TencentPanoMeta): unknown[] {
	return [[STATUS_OK], buildTencentImageMetadata(meta)];
}

export function buildSingleImageSearchNoResults(): unknown[] {
	return [statusMessage(NO_RESULTS, "No results")];
}

export function tencentIdsFromGetMetadataRequest(body: unknown): string[] | null {
	if (!Array.isArray(body)) return null;
	const queries = body[2];
	if (!Array.isArray(queries) || queries.length === 0) return null;
	const ids: string[] = [];
	for (const q of queries) {
		const id = Array.isArray(q) && Array.isArray(q[0]) ? q[0][1] : null;
		if (typeof id !== "string" || !isTencentPanoId(id)) return null;
		ids.push(id);
	}
	return ids;
}

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

export function isTencentPrefixedKey(id: unknown): boolean {
	return typeof id === "string" && isTencentPanoId(id);
}
