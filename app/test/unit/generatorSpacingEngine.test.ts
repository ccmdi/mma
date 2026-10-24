import { describe, expect, it, vi } from "vitest";
import type { Pano, PolygonGeometry } from "@/bindings.gen";
import type { GeneratorRegion } from "@/plugins/generator/engine/types";

const h = vi.hoisted(() => ({
	points: [
		{ lat: 1, lng: 1 },
		{ lat: 2, lng: 2 },
		{ lat: 3, lng: 3 },
	],
	nearResolvers: [] as (() => void)[],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/plugins/generator/engine/blueLineSampler", () => ({
	DISTRIBUTION_EVENNESS: { density: 0, balanced: 0.5, even: 1 },
	blueLineSource: () => {
		let next = 0;
		return {
			take: async (n: number) => h.points.slice(next, (next += n)),
			cancel: () => {},
			progress: () => Math.min(next / h.points.length, 1),
		};
	},
}));
vi.mock("@/lib/commands", async () => ({
	cmd: {
		polygonBounds: () => Promise.resolve([0, 0, 4, 4]),
		polygonContainsPoints: (_polygon: PolygonGeometry, lats: number[]) =>
			Promise.resolve(lats.map(() => true)),
		storeRead: (await import("./fixtures/mocks")).readEach(
			(_target: unknown, _selector: unknown, ask: { lats?: number[] }) =>
				new Promise((resolve) => {
					h.nearResolvers.push(() =>
						resolve({ kind: "nearAny", values: (ask.lats ?? []).map(() => false) }),
					);
				}),
		),
	},
}));
vi.mock("@/lib/sv/streetView", async (original) => ({
	StreetView: {
		...(await original<typeof import("@/lib/sv/streetView")>()).StreetView,

		panosAt: (points: { lat: number; lng: number }[]) =>
			Promise.resolve(
				points.map(
					({ lat, lng }, i) =>
						({
							id: `${i}${String(lat).padStart(21, "0")}A`,
							description: "Main Street",
							shortDescription: "Main Street",
							lat,
							lng,
							links: [],
							date: { year: 2020, month: 1, day: 1 },
							imageDate: "2020-01",
							time: [],
							worldSize: { height: 6656 },
							pov: { heading: 0, tilt: 90, roll: 0 },
						}) as unknown as Pano,
				),
			),
		metadata: () => Promise.resolve([]),
	},
}));

import { GenerationEngine } from "@/plugins/generator/engine/GenerationEngine";
import { DEFAULT_SETTINGS } from "@/plugins/generator/engine/types";

function region(target = 1): GeneratorRegion {
	return {
		id: "region",
		name: "Region",
		polygon: {
			coordinates: [
				[
					[0, 0],
					[4, 0],
					[4, 4],
					[0, 4],
					[0, 0],
				],
			],
			extraPolygons: null,
		},
		found: [],
		target,
		checkedPanos: new Set(),
		isProcessing: false,
	};
}

describe("spacing generation", () => {
	it("exhausts its finite Coverage plan instead of stopping at the count target", async () => {
		h.nearResolvers = [];
		const subject = region();
		const engine = new GenerationEngine(
			{
				...DEFAULT_SETTINGS,
				objective: "spacing",
				spacing: 1_000,
				samplingMode: "random",
				rejectUnofficial: false,
				rejectDateless: false,
				rejectNoDescription: false,
			},
			[subject],
			{
				onLocationsFound: () => {},
				onProgress: () => {},
				onRegionComplete: () => {},
				onDone: () => {},
			},
		);

		await engine.start();

		expect(subject.found).toHaveLength(3);
		expect(engine.progress()).toEqual({ objective: "spacing", found: 3, fraction: 1 });
	});

	it("does not finish while accepted spacing work is still pending", async () => {
		h.nearResolvers = [];
		const subject = region();
		const engine = new GenerationEngine(
			{
				...DEFAULT_SETTINGS,
				objective: "spacing",
				spacing: 1_000,
				samplingMode: "blueline",
				skipExisting: true,
				rejectUnofficial: false,
				rejectDateless: false,
				rejectNoDescription: false,
			},
			[subject],
			{
				onLocationsFound: () => {},
				onProgress: () => {},
				onRegionComplete: () => {},
				onDone: () => {},
			},
		);
		let done = false;
		const run = engine.start().then(() => {
			done = true;
		});
		await vi.waitFor(() => expect(h.nearResolvers).toHaveLength(1));
		h.nearResolvers.shift()!();
		await vi.waitFor(() => expect(h.nearResolvers).toHaveLength(3));

		expect(done).toBe(false);
		for (const resolve of h.nearResolvers) resolve();
		await run;
		expect(subject.found).toHaveLength(3);
	});

	it("does not finish before its final location batch is written", async () => {
		h.nearResolvers = [];
		const subject = region();
		let releaseWrite!: () => void;
		let writing = false;
		let done = false;
		const engine = new GenerationEngine(
			{
				...DEFAULT_SETTINGS,
				objective: "spacing",
				spacing: 1_000,
				rejectUnofficial: false,
				rejectDateless: false,
				rejectNoDescription: false,
			},
			[subject],
			{
				onLocationsFound: () => {
					writing = true;
					return new Promise<void>((resolve) => {
						releaseWrite = resolve;
					});
				},
				onProgress: () => {},
				onRegionComplete: () => {},
				onDone: () => {
					done = true;
				},
			},
		);
		const run = engine.start();
		await vi.waitFor(() => expect(writing).toBe(true));

		expect(done).toBe(false);
		releaseWrite();
		await run;
		expect(done).toBe(true);
	});
});
