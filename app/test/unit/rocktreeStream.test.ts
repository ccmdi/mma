/**
 * M4/M5 streaming invariants: octant-mask/coverage selection (computeDrawn),
 * stream lifecycle (ancestor prefetch, priority order, abort on view change,
 * LRU eviction, failure retry), staged promotion budget, GPU retention
 * eviction, and the per-node MVP composition.
 */
import { describe, it, expect } from "vitest";
import { WebMercatorViewport } from "@deck.gl/core";
import {
	computeDrawn,
	loadPriority,
	RocktreeStream,
	type StreamDeps,
} from "@/lib/render/rocktree/stream";
import { composeNodeMvp, selectEvictions } from "@/lib/render/rocktree/layer";
import { makeView } from "@/lib/render/rocktree/lod";
import type { FoundNode } from "@/lib/render/rocktree/traverse";
import { latLngToEcef, type Bulk, type BulkNode, type Obb } from "@/lib/render/rocktree/decode";

// --- computeDrawn ---

const S = (...p: string[]) => new Set(p);

describe("computeDrawn", () => {
	it("draws a ready pick unmasked", () => {
		expect(computeDrawn(S("205"), S("205"), S("205"))).toEqual(new Map([["205", 0]]));
	});

	it("masks each ancestor octant covered by its drawn child", () => {
		const wanted = S("2", "20", "205");
		const out = computeDrawn(wanted, S("205"), wanted);
		expect(out.get("205")).toBe(0);
		expect(out.get("20")).toBe(1 << 5);
		expect(out.get("2")).toBe(1 << 0);
	});

	it("leaves the parent unmasked while the pick loads (coarse cover, no hole)", () => {
		const out = computeDrawn(S("2", "20", "205"), S("205"), S("2", "20"));
		expect(out.get("20")).toBe(0);
		expect(out.get("2")).toBe(1 << 0);
		expect(out.has("205")).toBe(false);
	});

	it("passes coverage through an unready middle node only when all its wanted children are covered", () => {
		// covering completeness guarantees unwanted octants hold no visible data,
		// so a fully-covered unready node lets its parent mask that octant
		const out = computeDrawn(S("2", "20", "205"), S("205"), S("2", "205"));
		expect(out.get("205")).toBe(0);
		expect(out.get("2")).toBe(1 << 0);
		expect(out.has("20")).toBe(false);
	});

	it("a parent with all 8 children drawn is fully masked (0xff)", () => {
		const kids = Array.from({ length: 8 }, (_, d) => `20${d}`);
		const out = computeDrawn(S("20", ...kids), S(...kids), S("20", ...kids));
		expect(out.get("20")).toBe(0xff);
	});

	it("partial children leave the parent's other octants live", () => {
		const out = computeDrawn(S("20", "200", "201"), S("200", "201"), S("20", "200", "201"));
		expect(out.get("20")).toBe(0b11);
	});
});

// --- composeNodeMvp ---

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const apply = (m: Float32Array, p: [number, number, number]) => [
	m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
	m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
	m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

describe("composeNodeMvp", () => {
	it("scales ENU meters by unitsPerMeter and offsets by the common origin", () => {
		const mvp = composeNodeMvp(IDENTITY16, [10, 20, 5], [2, 2, 2], new Float64Array(IDENTITY16));
		expect(apply(mvp, [1, 1, 1])).toEqual([12, 22, 7]);
	});

	it("applies the enu model matrix before the offset", () => {
		const enu = new Float64Array(IDENTITY16);
		enu[12] = 3; // 3 m east
		const mvp = composeNodeMvp(IDENTITY16, [10, 20, 5], [2, 2, 2], enu);
		expect(apply(mvp, [0, 0, 0])).toEqual([16, 20, 5]);
	});

	it("applies the view projection last", () => {
		const vp = [...IDENTITY16];
		vp[0] = vp[5] = vp[10] = 0.5;
		const mvp = composeNodeMvp(vp, [10, 20, 5], [2, 2, 2], new Float64Array(IDENTITY16));
		expect(apply(mvp, [1, 1, 1])).toEqual([6, 11, 3.5]);
	});
});

describe("composeNodeMvp vs deck's own projection", () => {
	const vp = new WebMercatorViewport({
		width: 800,
		height: 600,
		longitude: -96.8,
		latitude: 32.77,
		zoom: 16,
		pitch: 45,
		bearing: 30,
	});
	const origin: [number, number, number] = [-96.801, 32.771, 50];
	const mvp = () =>
		composeNodeMvp(
			vp.viewProjectionMatrix,
			vp.projectPosition(origin),
			vp.getDistanceScales(origin).unitsPerMeter,
			new Float64Array(IDENTITY16),
		);
	const toScreen = (m: Float32Array, p: [number, number, number]) => {
		const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
		const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
		const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
		return [((cx / cw + 1) / 2) * 800, ((1 - cy / cw) / 2) * 600];
	};

	it("lands the anchor exactly where deck projects it", () => {
		const [sx, sy] = toScreen(mvp(), [0, 0, 0]);
		const [ex, ey] = vp.project(origin);
		expect(sx).toBeCloseTo(ex, 3);
		expect(sy).toBeCloseTo(ey, 3);
	});

	it("maps a 100 m north offset like deck does", () => {
		const [sx, sy] = toScreen(mvp(), [0, 100, 0]);
		// 100 m north on deck's mercator sphere (R = 6378137); sub-pixel match,
		// the residual is METER_OFFSETS linearization vs true mercator curvature
		const [ex, ey] = vp.project([origin[0], origin[1] + 100 / 111319.49, origin[2]]);
		expect(sx).toBeCloseTo(ex, 0);
		expect(sy).toBeCloseTo(ey, 0);
	});
});

// --- RocktreeStream ---

const T = { lat: 40, lng: -74 };
const VIEW = makeView({ ...T, zoom: 15, pitch: 45, bearing: 0, width: 1024, height: 768 });
const AWAY = makeView({
	lat: -T.lat,
	lng: 180 + T.lng,
	zoom: 15,
	pitch: 45,
	bearing: 0,
	width: 1024,
	height: 768,
});

const IDENTITY3 = () => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const obbAt = (extent: number): Obb => ({
	center: latLngToEcef(T.lat, T.lng),
	extents: [extent, extent, extent],
	orientation: IDENTITY3(),
});
const antipodeObb = (): Obb => ({
	center: latLngToEcef(-T.lat, 180 + T.lng),
	extents: [10000, 10000, 10000],
	orientation: IDENTITY3(),
});

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
function mkBulk(headEpoch: number, nodes: BulkNode[]): Bulk {
	return {
		headEpoch,
		headNodeCenter: [0, 0, 0],
		defaultImageryEpoch: null,
		nodes: new Map(nodes.map((n) => [n.path, n])),
	};
}

// chain 2 -> 20 -> 205 -> 2050 -> child bulk leaves 0..2 (fine mpt, LOD stops);
// "3" is a childless antipodal branch only the AWAY view covers
function world(): Record<string, Bulk> {
	return {
		"": mkBulk(100, [
			mkNode("2", { obb: obbAt(800), metersPerTexel: 5000 }),
			mkNode("20", { obb: obbAt(800), metersPerTexel: 2500 }),
			mkNode("205", { obb: obbAt(800), metersPerTexel: 1200 }),
			mkNode("2050", { obb: obbAt(800), metersPerTexel: 600 }),
			mkNode("3", { obb: antipodeObb(), metersPerTexel: 5000 }),
		]),
		"2050": mkBulk(55, [
			mkNode("0", { obb: obbAt(100), metersPerTexel: 0.05 }),
			mkNode("1", { obb: obbAt(100), metersPerTexel: 0.05 }),
			mkNode("2", { obb: obbAt(100), metersPerTexel: 0.05 }),
		]),
	};
}

interface Harness {
	stream: RocktreeStream<string>;
	loads: {
		path: string;
		priority: number;
		signal: AbortSignal;
		resolve(): void;
		reject(e: unknown): void;
	}[];
	disposed: string[];
	changes: () => number;
	resolveAll(): Promise<void>;
}

function harness(opts: { cacheBudget?: number } = {}): Harness {
	const loads: Harness["loads"] = [];
	const disposed: string[] = [];
	let changes = 0;
	const deps: StreamDeps<string> = {
		getRootEpoch: async () => 100,
		getBulk: async (path) => {
			const b = world()[path];
			if (!b) throw new Error(`no bulk ${path}`);
			return b;
		},
		loadNode: (found: FoundNode, signal: AbortSignal, priority: number) =>
			new Promise<string>((resolve, reject) => {
				loads.push({
					path: found.path,
					priority,
					signal,
					resolve: () => resolve(found.path),
					reject,
				});
			}),
		disposeNode: (d) => disposed.push(d),
		onChange: () => changes++,
	};
	const stream = new RocktreeStream<string>(deps, {
		minLevel: 1,
		texelBudget: 1,
		maxLevel: 20,
		cacheBudget: opts.cacheBudget,
	});
	return {
		stream,
		loads,
		disposed,
		changes: () => changes,
		resolveAll: async () => {
			for (const l of loads) if (!l.signal.aborted) l.resolve();
			await new Promise((r) => setTimeout(r, 0));
			stream.promote(Infinity);
		},
	};
}

describe("RocktreeStream", () => {
	it("fetches picks plus renderable ancestors, coarse levels first", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		const paths = h.loads.map((l) => l.path);
		expect(new Set(paths)).toEqual(S("2", "20", "205", "2050", "20500", "20501", "20502"));
		for (let i = 1; i < paths.length; i++)
			expect(paths[i].length).toBeGreaterThanOrEqual(paths[i - 1].length);
	});

	it("draws coarse cover as soon as promoted and refines as nodes arrive", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		expect(h.stream.drawnNodes()).toEqual([]);
		h.loads.find((l) => l.path === "2")!.resolve();
		await new Promise((r) => setTimeout(r, 0));
		h.stream.promote(Infinity);
		expect(h.stream.drawnNodes()).toEqual([{ path: "2", data: "2", mask: 0 }]);
		await h.resolveAll();
		const drawn = new Map(h.stream.drawnNodes().map((d) => [d.path, d.mask]));
		expect(drawn.get("20500")).toBe(0);
		expect(drawn.get("2050")).toBe(0b111); // octants 0-2 refined, rest live
		expect(drawn.get("205")).toBe(1 << 0);
		expect(drawn.get("2")).toBe(1 << 0);
	});

	it("aborts loading nodes when the view leaves them", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		expect(h.loads.length).toBeGreaterThan(0);
		await h.stream.update(AWAY);
		for (const l of h.loads) expect(l.signal.aborted).toBe(l.path !== "3");
		expect(h.stream.drawnNodes()).toEqual([]);
	});

	it("a load that resolves after abort is disposed, not drawn", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		const first = h.loads[0];
		await h.stream.update(AWAY);
		first.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(h.disposed).toContain(first.path);
		expect(h.stream.drawnNodes()).toEqual([]);
	});

	it("evicts least-recently-wanted ready nodes beyond the cache budget", async () => {
		const h = harness({ cacheBudget: 2 });
		await h.stream.update(VIEW);
		await h.resolveAll();
		expect(h.stream.drawnNodes().length).toBe(7);
		await h.stream.update(AWAY);
		// 7 ready none wanted + "3" loading, budget 2: 6 disposed
		expect(h.disposed.length).toBe(6);
	});

	it("retries failed nodes on the next update", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		const failing = h.loads.find((l) => l.path === "20500")!;
		failing.reject(new Error("boom"));
		await new Promise((r) => setTimeout(r, 0));
		await h.stream.update(VIEW);
		const attempts = h.loads.filter((l) => l.path === "20500");
		expect(attempts.length).toBe(2);
	});

	it("passes level-major, then nearer-first priorities to loadNode", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		const pr = new Map(h.loads.map((l) => [l.path, l.priority]));
		expect(pr.get("2")!).toBeLessThan(pr.get("20")!);
		expect(pr.get("20")!).toBeLessThan(pr.get("205")!);
		expect(pr.get("2050")!).toBeLessThan(pr.get("20500")!);
	});

	it("dispose aborts everything and disposes ready data", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		h.loads.find((l) => l.path === "2")!.resolve();
		await new Promise((r) => setTimeout(r, 0));
		h.stream.dispose();
		expect(h.disposed).toContain("2");
		for (const l of h.loads) if (l.path !== "2") expect(l.signal.aborted).toBe(true);
	});
});

describe("staged promotion (GPU upload budget)", () => {
	const tick = () => new Promise((r) => setTimeout(r, 0));

	it("arrived nodes stay staged (not drawable) until promoted, coarse-first within the budget", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		for (const l of h.loads) l.resolve();
		await tick();
		expect(h.stream.drawnNodes()).toEqual([]);
		expect(h.stream.promote(2)).toBe(5);
		expect(
			h.stream
				.drawnNodes()
				.map((d) => d.path)
				.sort(),
		).toEqual(["2", "20"]);
		expect(h.stream.promote(Infinity)).toBe(0);
		expect(h.stream.drawnNodes().length).toBe(7);
	});

	it("stale staged nodes from a previous view never starve a wanted arrival", async () => {
		const h = harness();
		await h.stream.update(VIEW);
		for (const l of h.loads) l.resolve();
		await tick(); // 7 staged, all about to become unwanted
		await h.stream.update(AWAY);
		h.loads.find((l) => l.path === "3")!.resolve();
		await tick();
		// unwanted staged promote for free (never drawn); only "3" costs budget
		expect(h.stream.promote(1)).toBe(0);
		expect(h.stream.drawnNodes()).toEqual([{ path: "3", data: "3", mask: 0 }]);
	});
});

describe("loadPriority", () => {
	it("orders by level first, then distance to the eye", () => {
		const at = (path: string, extent: number) => ({ path, epoch: 1, obb: obbAt(extent) });
		// bigger extent = surface closer to the eye
		expect(loadPriority(at("20", 500), VIEW)).toBeLessThan(loadPriority(at("20", 100), VIEW));
		expect(loadPriority(at("2", 100), VIEW)).toBeLessThan(loadPriority(at("20", 500), VIEW));
	});
});

describe("selectEvictions (GPU retention)", () => {
	it("never evicts drawn entries (unusedSince null)", () => {
		expect(selectEvictions([["a", null]], 1e9, 0, 0)).toEqual([]);
	});

	it("evicts retained entries past the grace period", () => {
		const out = selectEvictions(
			[
				["old", 0],
				["fresh", 900],
				["drawn", null],
			],
			1000,
			500,
			10,
		);
		expect(out).toEqual(["old"]);
	});

	it("evicts the oldest beyond the cap even within grace", () => {
		const out = selectEvictions(
			[
				["b", 20],
				["a", 10],
				["c", 30],
			],
			40,
			1000,
			2,
		);
		expect(out).toEqual(["a"]);
	});
});
