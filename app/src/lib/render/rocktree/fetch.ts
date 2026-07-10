// IO for rocktree resources, routed through the Rust `rocktree://` scheme
// proxy (kh.google.com returns HTTP 400 for tauri:// origins, so the webview
// cannot fetch it directly on macOS/Linux).

import { schemeBase } from "@/lib/util/util";
import {
	parseBulkMetadata,
	parseNodeData,
	parsePlanetoid,
	TEXTURE_FORMAT_JPG,
	type Bulk,
	type DecodedNode,
	type PlanetoidInfo,
} from "./decode";

export function planetoidUrl(): string {
	return `${schemeBase("rocktree")}PlanetoidMetadata`;
}

export function bulkUrl(path: string, epoch: number): string {
	return `${schemeBase("rocktree")}BulkMetadata/pb=!1m2!1s${path}!2u${epoch}`;
}

export function nodeUrl(path: string, epoch: number, imageryEpoch?: number): string {
	const img = imageryEpoch != null ? `!3u${imageryEpoch}` : "";
	return `${schemeBase("rocktree")}NodeData/pb=!1m2!1s${path}!2u${epoch}!2e${TEXTURE_FORMAT_JPG}${img}!4b0`;
}

// Politeness + resilience: kh.google.com resets connections under bursts
// (hundreds of parallel bulk fetches at deep LOD), so all rocktree requests
// share one in-flight cap and transient failures retry with backoff.
const MAX_CONCURRENT = 8;
const RETRIES = 2;
const RETRY_DELAY_MS = 400;

let active = 0;
const waiters: (() => void)[] = [];
function acquire(): Promise<void> {
	if (active < MAX_CONCURRENT) {
		active++;
		return Promise.resolve();
	}
	return new Promise((r) => waiters.push(r));
}
function release() {
	const next = waiters.shift();
	// hand the slot to the next waiter, else free it
	if (next) next();
	else active--;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
	await acquire();
	try {
		let lastErr: unknown;
		for (let attempt = 0; attempt <= RETRIES; attempt++) {
			if (attempt) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
			try {
				const res = await fetch(url);
				if (res.ok) return new Uint8Array(await res.arrayBuffer());
				lastErr = new Error(`rocktree: HTTP ${res.status} for ${url}`);
				// 4xx is a real answer (bad path/epoch); only retry 5xx/429
				if (res.status < 500 && res.status !== 429) break;
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr;
	} finally {
		release();
	}
}

export async function fetchPlanetoid(): Promise<PlanetoidInfo> {
	return parsePlanetoid(await fetchBytes(planetoidUrl()));
}

export async function fetchBulk(path: string, epoch: number): Promise<Bulk> {
	return parseBulkMetadata(await fetchBytes(bulkUrl(path, epoch)), epoch);
}

export async function fetchNode(
	path: string,
	epoch: number,
	imageryEpoch?: number,
): Promise<DecodedNode> {
	return parseNodeData(await fetchBytes(nodeUrl(path, epoch, imageryEpoch)));
}
