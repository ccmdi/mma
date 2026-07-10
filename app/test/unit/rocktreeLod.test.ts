/**
 * Covering-set invariants: frustum/OBB visibility, LOD selection, and the
 * traversal that combines them. Geometry cases are synthetic; completeness is
 * also checked against the captured root bulk fixture.
 *
 * The OBB axes-are-columns convention was verified against live geometry
 * (fetched NodeData vertices sit inside their own OBB only under the column
 * reading); the e2e spec re-checks it live.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
	makeFlatView,
	makeView,
	obbVisible,
	obbDistance,
	lodSufficient,
	type ViewParams,
} from "@/lib/render/rocktree/lod";
import { coveringSet, type BulkSource } from "@/lib/render/rocktree/traverse";
import {
	parseBulkMetadata,
	latLngToEcef,
	isRenderable,
	NodeFlags,
	type Bulk,
	type BulkNode,
	type Obb,
	type Vec3,
} from "@/lib/render/rocktree/decode";

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./fixtures/rocktree/${name}`, import.meta.url)));

const T = { lat: 40, lng: -74 };
const BASE: ViewParams = { ...T, zoom: 15, pitch: 45, bearing: 0, width: 1024, height: 768 };
// deck camera contract: 512px world, camera 1.5 screen heights from target
const MPP = (40075016.686 * Math.cos((T.lat * Math.PI) / 180)) / (512 * 2 ** BASE.zoom);
const CAM_DIST = 1.5 * BASE.height * MPP;

const IDENTITY = () => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const obbAt = (lat: number, lng: number, extent: number, alt = 0): Obb => ({
	center: latLngToEcef(lat, lng, alt),
	extents: [extent, extent, extent],
	orientation: IDENTITY(),
});

describe("makeView", () => {
	it("places the eye a camera distance from the target", () => {
		const v = makeView(BASE);
		const target = latLngToEcef(T.lat, T.lng);
		const d = Math.hypot(v.eye[0] - target[0], v.eye[1] - target[1], v.eye[2] - target[2]);
		expect(d).toBeCloseTo(CAM_DIST, 6);
	});

	it("pixelFactor reproduces the mercator meters-per-pixel at the target", () => {
		const v = makeView(BASE);
		expect(v.pixelFactor * CAM_DIST).toBeCloseTo(MPP, 10);
	});
});

describe("obbVisible", () => {
	const down = makeView({ ...BASE, pitch: 0 });

	it("keeps a box at the camera target", () => {
		expect(obbVisible(obbAt(T.lat, T.lng, 100), down)).toBe(true);
		expect(obbVisible(obbAt(T.lat, T.lng, 100), makeView(BASE))).toBe(true);
	});

	it("culls a box behind the camera", () => {
		// looking straight down, a box above the eye is behind it
		expect(obbVisible(obbAt(T.lat, T.lng, 10, CAM_DIST * 2), down)).toBe(false);
	});

	it("culls a box far off to the side", () => {
		// ~100 km west, far outside the horizontal fov of a straight-down view
		expect(obbVisible(obbAt(T.lat, -75.2, 100), down)).toBe(false);
	});

	it("culls the far side of the planet via the horizon far plane", () => {
		expect(obbVisible(obbAt(-T.lat, 180 + T.lng, 10000), down)).toBe(false);
		expect(obbVisible(obbAt(-T.lat, 180 + T.lng, 10000), makeView(BASE))).toBe(false);
	});

	it("keeps a box that contains the eye", () => {
		expect(obbVisible(obbAt(T.lat, T.lng, 50000), down)).toBe(true);
	});
});

describe("obbDistance", () => {
	const view = makeView(BASE);

	it("is zero inside the box", () => {
		expect(obbDistance(obbAt(T.lat, T.lng, 50000), view.eye)).toBe(0);
	});

	it("measures to the nearest face for an offset box", () => {
		const obb: Obb = {
			center: [view.eye[0] + 500, view.eye[1], view.eye[2]],
			extents: [100, 100, 100],
			orientation: IDENTITY(),
		};
		expect(obbDistance(obb, view.eye)).toBeCloseTo(400, 9);
	});

	it("uses the COLUMNS of orientation as box axes", () => {
		const c = Math.cos(Math.PI / 6);
		const s = Math.sin(Math.PI / 6);
		const obb: Obb = {
			center: [1000, 2000, 3000],
			extents: [100, 1, 1],
			// 30-degree rotation about z, column-major
			orientation: new Float64Array([c, s, 0, -s, c, 0, 0, 0, 1]),
		};
		// 50 units along the long axis (column 0): inside. The row reading
		// would put this point ~42 outside the short axis.
		const onAxis: Vec3 = [1000 + 50 * c, 2000 + 50 * s, 3000];
		expect(obbDistance(obb, onAxis)).toBe(0);
		// 5 units along column 1 (extent 1): 4 outside
		const offAxis: Vec3 = [1000 - 5 * s, 2000 + 5 * c, 3000];
		expect(obbDistance(obb, offAxis)).toBeCloseTo(4, 9);
	});
});

describe("flat view (zoomed-out mercator)", () => {
	const WORLD: [number, number, number, number] = [-180, -85, 180, 85];

	it("sees nodes the perspective camera horizon-culls", () => {
		const antipode = obbAt(-T.lat, 180 + T.lng, 10000);
		expect(obbVisible(antipode, makeView(BASE))).toBe(false);
		expect(obbVisible(antipode, makeFlatView({ ...T, zoom: 2, bounds: WORLD }))).toBe(true);
	});

	it("culls by the viewport's lat/lng rect", () => {
		const view = makeFlatView({ ...T, zoom: 4, bounds: [-120, 10, -30, 70] });
		expect(obbVisible(obbAt(40, -74, 1000), view)).toBe(true);
		expect(obbVisible(obbAt(-60, -74, 1000), view)).toBe(false);
		expect(obbVisible(obbAt(40, 100, 1000), view)).toBe(false);
	});

	it("handles longitude wrap in the viewport bounds", () => {
		const view = makeFlatView({ lat: 0, lng: 180, zoom: 4, bounds: [170, -10, 190, 10] });
		expect(obbVisible(obbAt(0, -175, 1000), view)).toBe(true);
		expect(obbVisible(obbAt(0, 100, 1000), view)).toBe(false);
	});

	it("LOD is a fixed meters-per-texel cutoff independent of distance", () => {
		const view = makeFlatView({ ...T, zoom: 3, bounds: WORLD });
		const maxMpt = 40075016.686 / (512 * 2 ** 3);
		const near = obbAt(T.lat, T.lng, 1000);
		const far = obbAt(-T.lat, 180 + T.lng, 1000);
		for (const obb of [near, far]) {
			expect(lodSufficient(obb, maxMpt * 0.99, view)).toBe(true);
			expect(lodSufficient(obb, maxMpt * 1.01, view)).toBe(false);
		}
	});
});

describe("lodSufficient", () => {
	const view = makeView(BASE);
	const near = obbAt(T.lat, T.lng, 50);
	const nearDist = obbDistance(near, view.eye);
	const threshold = nearDist * view.pixelFactor;

	it("accepts a node whose texels outresolve the screen at its distance", () => {
		expect(lodSufficient(near, threshold * 0.99, view)).toBe(true);
	});

	it("rejects a node too coarse for its distance", () => {
		expect(lodSufficient(near, threshold * 1.01, view)).toBe(false);
	});

	it("scales with the texel budget", () => {
		expect(lodSufficient(near, threshold * 1.5, view, 2)).toBe(true);
	});

	it("a coarse node becomes sufficient farther away", () => {
		const far = obbAt(T.lat, T.lng - 0.5, 50);
		const mpt = threshold * 2;
		expect(lodSufficient(near, mpt, view)).toBe(false);
		expect(lodSufficient(far, mpt, view)).toBe(true);
	});

	it("never accepts a node containing the eye", () => {
		expect(lodSufficient(obbAt(T.lat, T.lng, 50000), 1e-9, view, 1e9)).toBe(false);
	});
});

// --- covering-set traversal over synthetic bulks ---

function mkNode(path: string, o: Partial<BulkNode> = {}): BulkNode {
	return {
		path,
		flags: 0,
		epoch: null,
		bulkMetadataEpoch: null,
		imageryEpoch: null,
		metersPerTexel: 1000,
		obb: null,
		...o,
	};
}

function mkBulk(
	headEpoch: number,
	nodes: BulkNode[],
	defaultImageryEpoch: number | null = null,
): Bulk {
	return {
		headEpoch,
		headNodeCenter: [0, 0, 0],
		defaultImageryEpoch,
		nodes: new Map(nodes.map((n) => [n.path, n])),
	};
}

const src =
	(bulks: Record<string, Bulk>, calls: string[] = []): BulkSource =>
	async (path, epoch) => {
		calls.push(`${path}:${epoch}`);
		const b = bulks[path];
		if (!b) throw new Error(`no bulk at ${path}`);
		return b;
	};

// All boxes sit at the view target; extent 800 keeps the eye outside
// (corner reach ~1385 m < CAM_DIST). Leaves are extent 100, mpt 0.05
// (well under the ~1.7 m/px the screen resolves at their distance).
const AT = (extent: number) => obbAt(T.lat, T.lng, extent);
const ANTIPODE = obbAt(-T.lat, 180 + T.lng, 800);

function world() {
	const root = mkBulk(100, [
		mkNode("2", { obb: AT(800), metersPerTexel: 5000 }),
		mkNode("20", { obb: AT(800), metersPerTexel: 2500 }),
		mkNode("205", { obb: AT(800), metersPerTexel: 1200 }),
		mkNode("2050", { obb: AT(800), metersPerTexel: 600 }),
		mkNode("2051", { obb: AT(800), metersPerTexel: 600, flags: NodeFlags.LEAF }),
		mkNode("3", { obb: AT(800), metersPerTexel: 5000 }),
		mkNode("21", { obb: ANTIPODE, metersPerTexel: 2500 }),
		mkNode("210", { obb: ANTIPODE, metersPerTexel: 1200 }),
	]);
	const child = mkBulk(
		55,
		[
			mkNode("0", { obb: AT(100), metersPerTexel: 0.05, epoch: 77 }),
			mkNode("1", { obb: AT(100), metersPerTexel: 0.05, flags: NodeFlags.USE_IMAGERY_EPOCH }),
			mkNode("2", { obb: AT(100), metersPerTexel: 0.05 }),
			mkNode("3", { flags: NodeFlags.NODATA }),
		],
		1030,
	);
	return { "": root, "2050": child };
}

const view = makeView(BASE);
const paths = (picks: { path: string }[]) => picks.map((p) => p.path).sort();

describe("coveringSet", () => {
	it("descends to LOD-sufficient leaves, picking frontier nodes on the way", async () => {
		const picks = await coveringSet(view, 100, src(world()));
		expect(paths(picks)).toEqual(["20500", "20501", "20502", "2051", "3"]);
	});

	it("picks are prefix-free", async () => {
		const picks = await coveringSet(view, 100, src(world()));
		for (const a of picks)
			for (const b of picks) if (a !== b) expect(a.path.startsWith(b.path)).toBe(false);
	});

	it("resolves epochs through the chain", async () => {
		const picks = await coveringSet(view, 100, src(world()));
		const byPath = new Map(picks.map((p) => [p.path, p]));
		expect(byPath.get("20500")!.epoch).toBe(77); // explicit node epoch
		expect(byPath.get("20501")!.epoch).toBe(55); // child bulk head epoch
		expect(byPath.get("20501")!.imageryEpoch).toBe(1030); // bulk default via flag
		expect(byPath.get("20502")!.imageryEpoch).toBeUndefined();
		expect(byPath.get("2051")!.epoch).toBe(100); // root bulk head epoch
	});

	it("a permissive texel budget stops at the shallowest renderable node", async () => {
		const picks = await coveringSet(view, 100, src(world()), { texelBudget: 1e9 });
		expect(paths(picks)).toEqual(["2", "3"]);
	});

	it("culls whole subtrees and never fetches their bulks", async () => {
		const calls: string[] = [];
		const picks = await coveringSet(view, 100, src(world(), calls));
		expect(picks.some((p) => p.path.startsWith("21"))).toBe(false);
		expect(calls.sort()).toEqual(["2050:100", ":100"].sort());
	});

	it("descends through NODATA mid-branch nodes", async () => {
		const w = world();
		const n205 = w[""].nodes.get("205")!;
		n205.flags |= NodeFlags.NODATA;
		n205.metersPerTexel = 0.05; // LOD-sufficient, but NODATA must not be picked
		const picks = await coveringSet(view, 100, src(w));
		expect(paths(picks)).toEqual(["20500", "20501", "20502", "2051", "3"]);
	});

	it("picks a visible parent when its whole subtree is dataless", async () => {
		const w = world();
		w["2050"] = mkBulk(55, [
			mkNode("0", { flags: NodeFlags.NODATA }),
			mkNode("1", { flags: NodeFlags.NODATA }),
		]);
		const picks = await coveringSet(view, 100, src(w));
		expect(paths(picks)).toEqual(["2050", "2051", "3"]);
	});

	it("maxLevel caps descent depth", async () => {
		const picks = await coveringSet(view, 100, src(world()), { maxLevel: 3 });
		expect(paths(picks)).toEqual(["205", "3"]);
	});

	it("maxNodes stops descent but still covers, coarsely", async () => {
		const picks = await coveringSet(view, 100, src(world()), { maxNodes: 0 });
		expect(paths(picks)).toEqual(["2", "3"]);
	});
});

describe("coveringSet completeness on the root bulk fixture", () => {
	// Dallas view; only the root bulk is available, so descent bottoms out at
	// its level-4 nodes (child bulk fetches fail -> best-effort frontier).
	const dallas = makeView({
		lat: 32.9565,
		lng: -96.772,
		zoom: 15,
		pitch: 45,
		bearing: 0,
		width: 1024,
		height: 768,
	});
	const bulkRoot = () => parseBulkMetadata(fixture("bulk_root.bin"), 1012);

	const run = async () => {
		const root = bulkRoot();
		const getBulk: BulkSource = async (path) => {
			if (path === "") return root;
			throw new Error("only the root bulk is captured");
		};
		return { root, picks: await coveringSet(dallas, 1012, getBulk) };
	};

	it("every pick is renderable and visible", async () => {
		const { root, picks } = await run();
		expect(picks.length).toBeGreaterThan(0);
		for (const p of picks) {
			const n = root.nodes.get(p.path)!;
			expect(isRenderable(n)).toBe(true);
			expect(obbVisible(n.obb!, dallas)).toBe(true);
		}
	});

	it("covers every visible renderable node (ancestor, self, or descendants)", async () => {
		const { root, picks } = await run();
		for (const a of picks)
			for (const b of picks) if (a !== b) expect(a.path.startsWith(b.path)).toBe(false);
		for (const n of root.nodes.values()) {
			if (!isRenderable(n) || !obbVisible(n.obb!, dallas)) continue;
			const related = picks.some((p) => p.path.startsWith(n.path) || n.path.startsWith(p.path));
			expect(related, `node ${n.path} uncovered`).toBe(true);
		}
	});
});
