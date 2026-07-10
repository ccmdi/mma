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

async function fetchBytes(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`rocktree: HTTP ${res.status} for ${url}`);
	return new Uint8Array(await res.arrayBuffer());
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
