// Octree descent: walk bulk pages toward a lat/lng and resolve the deepest
// renderable node. Probe-style (each level is verified against the fetched
// metadata, never computed blindly). Full covering-set traversal with LOD
// arrives with octree streaming; this single-target descent underpins it.

import {
	childBulkEpoch,
	hasChildBulk,
	imageryEpochFor,
	isRenderable,
	latLngToEcef,
	nodeDataEpoch,
	type BulkNode,
} from "./decode";
import { fetchBulk, fetchPlanetoid } from "./fetch";

export interface FoundNode {
	/** Full octant path from the root. */
	path: string;
	epoch: number;
	imageryEpoch?: number;
}

/**
 * Deepest renderable node over a lat/lng, descending to at most maxLevel.
 * Real data bottoms out around level 22 (~0.04 m/texel, a few meters across);
 * level 18 (~0.6 m/texel) covers roughly a city block.
 */
export async function findNodeNear(
	lat: number,
	lng: number,
	maxLevel = 18,
): Promise<FoundNode | null> {
	const target = latLngToEcef(lat, lng);
	const dist = (n: BulkNode) =>
		n.obb
			? Math.hypot(
					n.obb.center[0] - target[0],
					n.obb.center[1] - target[1],
					n.obb.center[2] - target[2],
				)
			: Infinity;

	const { rootEpoch } = await fetchPlanetoid();
	let bulkPath = "";
	let bulkEpoch = rootEpoch;
	let found: FoundNode | null = null;

	const maxBulks = Math.ceil(maxLevel / 4);
	for (let round = 0; round < maxBulks; round++) {
		let bulk;
		try {
			bulk = await fetchBulk(bulkPath, bulkEpoch);
		} catch {
			break; // deepening is best-effort; keep what we already found
		}
		let rel = "";
		let cur: BulkNode | null = null;
		for (let lvl = 1; lvl <= 4 && bulkPath.length + lvl <= maxLevel; lvl++) {
			let best: BulkNode | null = null;
			let bestDist = Infinity;
			for (const n of bulk.nodes.values()) {
				if (n.path.length !== lvl || !n.path.startsWith(rel) || !n.obb) continue;
				const d = dist(n);
				if (d < bestDist) {
					best = n;
					bestDist = d;
				}
			}
			if (!best) break;
			cur = best;
			rel = cur.path;
			if (isRenderable(cur)) {
				found = {
					path: bulkPath + cur.path,
					epoch: nodeDataEpoch(bulk, cur),
					imageryEpoch: imageryEpochFor(bulk, cur),
				};
			}
		}
		if (!cur || !hasChildBulk(cur)) break;
		bulkPath += cur.path;
		bulkEpoch = childBulkEpoch(bulk, cur);
	}
	return found;
}
