// Covering-set traversal: walk bulk pages from the root, frustum-cull node
// OBBs, and stop descending once a node's texel density satisfies the screen
// (or nothing finer exists). Probe-style: every level is verified against
// fetched metadata, never computed blindly.

import {
	childBulkEpoch,
	hasChildBulk,
	imageryEpochFor,
	isRenderable,
	nodeDataEpoch,
	type Bulk,
	type BulkNode,
	type Obb,
} from "./decode";
import { fetchBulk, fetchPlanetoid } from "./fetch";
import { lodSufficient, obbVisible, type FrustumView } from "./lod";

export interface FoundNode {
	/** Full octant path from the root. */
	path: string;
	epoch: number;
	imageryEpoch?: number;
	/** For fetch prioritization (distance to eye); null only in edge fixtures. */
	obb: Obb | null;
}

export type BulkSource = (path: string, epoch: number) => Promise<Bulk>;

export interface CoveringOpts {
	/** Hard depth cap; real data bottoms out around level 22. */
	maxLevel?: number;
	/** Max screen pixels per texel before descending (higher = coarser). */
	texelBudget?: number;
	/** Once this many nodes are picked, stop descending (picks stay coarse). */
	maxNodes?: number;
}

/**
 * Covering set of renderable nodes for a fixed view. Picks are prefix-free
 * (no pick is an ancestor of another): descent stops at each pick, and a
 * parent is only picked when its subtree yields nothing. Octants with no
 * renderable data anywhere are holes; octant masking (M4) is the real fix.
 */
export async function coveringSet(
	view: FrustumView,
	rootEpoch: number,
	getBulk: BulkSource,
	opts: CoveringOpts = {},
): Promise<FoundNode[]> {
	const maxLevel = opts.maxLevel ?? 20;
	const texelBudget = opts.texelBudget ?? 1;
	const maxNodes = opts.maxNodes ?? 256;
	const state = { count: 0 };

	const pick = (bulk: Bulk, bulkPath: string, node: BulkNode): FoundNode[] => {
		if (!isRenderable(node)) return [];
		state.count++;
		return [
			{
				path: bulkPath + node.path,
				epoch: nodeDataEpoch(bulk, node),
				imageryEpoch: imageryEpochFor(bulk, node),
				obb: node.obb,
			},
		];
	};

	async function cover(bulk: Bulk, bulkPath: string, node: BulkNode): Promise<FoundNode[]> {
		if (node.obb && !obbVisible(node.obb, view)) return [];
		const level = bulkPath.length + node.path.length;
		const lodOk =
			node.obb !== null && lodSufficient(node.obb, node.metersPerTexel, view, texelBudget);
		if ((lodOk && isRenderable(node)) || level >= maxLevel || state.count >= maxNodes)
			return pick(bulk, bulkPath, node);

		// NODATA can appear mid-branch: an unrenderable node still descends.
		const children: [Bulk, string, BulkNode][] = [];
		if (node.path.length < 4) {
			for (let d = 0; d < 8; d++) {
				const c = bulk.nodes.get(node.path + d);
				if (c) children.push([bulk, bulkPath, c]);
			}
		} else if (hasChildBulk(node)) {
			try {
				const childBulk = await getBulk(bulkPath + node.path, childBulkEpoch(bulk, node));
				for (let d = 0; d < 8; d++) {
					const c = childBulk.nodes.get(String(d));
					if (c) children.push([childBulk, bulkPath + node.path, c]);
				}
			} catch {
				// deepening is best-effort; fall through to pick this node
			}
		}
		if (children.length === 0) return pick(bulk, bulkPath, node);
		const results = (await Promise.all(children.map((c) => cover(...c)))).flat();
		// visible node whose whole subtree was culled or dataless: draw it
		if (results.length === 0) return pick(bulk, bulkPath, node);
		return results;
	}

	const root = await getBulk("", rootEpoch);
	const tops: Promise<FoundNode[]>[] = [];
	for (let d = 0; d < 8; d++) {
		const n = root.nodes.get(String(d));
		if (n) tops.push(cover(root, "", n));
	}
	return (await Promise.all(tops)).flat();
}

/** Production entry: planetoid epoch + per-call bulk cache over fetchBulk. */
export async function loadCoveringSet(
	view: FrustumView,
	opts?: CoveringOpts,
): Promise<FoundNode[]> {
	const { rootEpoch } = await fetchPlanetoid();
	const bulks = new Map<string, Promise<Bulk>>();
	const getBulk: BulkSource = (path, epoch) => {
		const key = `${path}:${epoch}`;
		let p = bulks.get(key);
		if (!p) {
			p = fetchBulk(path, epoch);
			bulks.set(key, p);
		}
		return p;
	};
	return coveringSet(view, rootEpoch, getBulk, opts);
}
