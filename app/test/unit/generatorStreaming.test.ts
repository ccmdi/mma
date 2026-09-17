// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LatLng } from "@/types";

interface ProbeCall {
	points: LatLng[];
	onPano: ((index: number, pano: unknown) => void) | undefined;
	finish: () => void;
}

const h = vi.hoisted(() => ({
	calls: [] as ProbeCall[],
	metaCalls: 0,
	progressed: 0,
	nextPano: 0,
	square: [
		[-60, -5],
		[-40, -5],
		[-40, 5],
		[-60, 5],
		[-60, -5],
	] as [number, number][],
}));

function fakePano(links: { heading: number; panoId: string }[] = []) {
	const id = `p${String(h.nextPano++).padStart(21, "0")}`;
	return {
		id,
		description: "Main Street",
		shortDescription: "Main Street",
		lat: 1,
		lng: -50,
		links,
		date: { year: 2020, month: 6, day: 1 },
		imageDate: "2020-06",
		time: [],
		worldSize: { height: 6656 },
		pov: { heading: 0, tilt: 90, roll: 0 },
	};
}

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/sv/opensv", () => ({ google: {} }));
vi.mock("@/lib/commands", () => {
	const rect = () => {
		const lngs = h.square.map((p) => p[0]);
		const lats = h.square.map((p) => p[1]);
		return {
			west: Math.min(...lngs),
			east: Math.max(...lngs),
			south: Math.min(...lats),
			north: Math.max(...lats),
		};
	};
	return {
		cmd: {
			storeNearAny: (lats: number[]) => Promise.resolve(lats.map(() => false)),
			polygonBounds: () => {
				const r = rect();
				return Promise.resolve([r.west, r.south, r.east, r.north]);
			},
			polygonContainsPoints: (_p: unknown, lats: number[]) => Promise.resolve(lats.map(() => true)),
			polygonRandomPoints: (_p: unknown, count: number) => {
				const r = rect();
				const pts: [number, number][] = Array.from({ length: count }, () => [
					r.west + Math.random() * (r.east - r.west),
					r.south + Math.random() * (r.north - r.south),
				]);
				return Promise.resolve(pts);
			},
		},
	};
});
vi.mock("@/lib/sv/query", () => ({
	panosAt: (
		points: LatLng[],
		_r: number,
		_o: unknown,
		_signal?: AbortSignal,
		onPano?: (index: number, pano: unknown) => void,
	) =>
		new Promise((resolve) => {
			h.calls.push({ points, onPano, finish: () => resolve(points.map(() => null)) });
		}),
	svMetadata: (ids: string[]) => {
		h.metaCalls++;
		return Promise.resolve(ids.map(() => null));
	},
}));

import { GenerationEngine } from "@/plugins/generator/engine/GenerationEngine";
import { DEFAULT_SETTINGS, type GeneratorRegion } from "@/plugins/generator/engine/types";

function region(): GeneratorRegion {
	return {
		id: "r",
		name: "r",
		polygon: { coordinates: [h.square], extraPolygons: null },
		found: [],
		target: 100_000,
		checkedPanos: new Set(),
		isProcessing: false,
	};
}

function engine(overrides: Partial<typeof DEFAULT_SETTINGS>) {
	return new GenerationEngine(
		{
			...DEFAULT_SETTINGS,
			rejectUnofficial: false,
			rejectDateless: false,
			rejectNoDescription: false,
			...overrides,
		},
		[region()],
		{
			onLocationsFound: () => {},
			onProgress: () => h.progressed++,
			onRegionComplete: () => {},
			onDone: () => {},
		},
	);
}

async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

describe("streaming probe rounds", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		h.calls = [];
		h.metaCalls = 0;
		h.progressed = 0;
	});

	afterEach(async () => {
		for (const c of h.calls) c.finish();
		await settle();
		vi.useRealTimers();
	});

	it("a streamed pano is accepted before its round resolves, without a second lookup", async () => {
		const e = engine({});
		const run = e.start();
		await settle();
		expect(h.calls).toHaveLength(1);

		h.calls[0].onPano!(0, fakePano());
		await vi.advanceTimersByTimeAsync(60);
		expect(h.progressed).toBeGreaterThan(0);
		expect(h.metaCalls).toBe(0);

		e.stop();
		for (const c of h.calls) c.finish();
		await settle();
		await run;
	});

	it("ids a pano opens up are still looked up", async () => {
		const e = engine({ checkLinks: true, linksDepth: 2 });
		const run = e.start();
		await settle();

		h.calls[0].onPano!(0, fakePano([{ heading: 90, panoId: "l".repeat(22) }]));
		await vi.advanceTimersByTimeAsync(60);
		expect(h.progressed).toBeGreaterThan(0);
		expect(h.metaCalls).toBeGreaterThan(0);

		e.stop();
		for (const c of h.calls) c.finish();
		await settle();
		await run;
	});

	it("the next round launches once most of the current one has answered", async () => {
		const e = engine({});
		const run = e.start();
		await settle();
		expect(h.calls).toHaveLength(1);

		const threshold = Math.ceil(h.calls[0].points.length * 0.9);
		for (let i = 0; i < threshold - 1; i++) h.calls[0].onPano!(i, null);
		await settle();
		expect(h.calls).toHaveLength(1);

		h.calls[0].onPano!(threshold - 1, null);
		await settle();
		expect(h.calls).toHaveLength(2);

		e.stop();
		for (const c of h.calls) c.finish();
		await settle();
		await run;
	});

	it("findRegions probes serially", async () => {
		const e = engine({ findRegions: true });
		const run = e.start();
		await settle();
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].points).toHaveLength(1);

		e.stop();
		for (const c of h.calls) c.finish();
		await settle();
		await run;
	});
});
