import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Work } from "./fixtures/jobContract";

const h = vi.hoisted(() => ({
	seeds: [] as { lat: number; lng: number; panoId: string }[],
	// panoId -> the metadata GetMetadata would return for it
	panos: new Map<string, unknown>(),
	fetched: [] as string[],
	// One coverage probe batch: the pano id found at each point, or null for none.
	probe: (points: { lat: number; lng: number }[], _radius: number): (string | null)[] =>
		points.map(() => null),
	// When set, lookups park here instead of answering at once.
	work: null as Work | null,
	gridRuns: [] as { lat: number; lng: number; lngStep: number; count: number }[],
	gridRequests: [] as number[],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

// Test polygons are rectangles, so the mocked shape commands answer with plain
// interval checks against the outer ring.
type MockPolygon = { coordinates: [number, number][][] };
function rectOf(polygon: MockPolygon) {
	const ring = polygon.coordinates[0];
	const lngs = ring.map((p) => p[0]);
	const lats = ring.map((p) => p[1]);
	return {
		west: Math.min(...lngs),
		east: Math.max(...lngs),
		south: Math.min(...lats),
		north: Math.max(...lats),
	};
}

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeFindNearby: () => Promise.resolve(h.seeds),
		storeNearAny: (lats: number[]) => Promise.resolve(lats.map(() => false)),
		honeycombPoints: (_polygon: unknown, spacingM: number) => {
			h.gridRequests.push(spacingM);
			return Promise.resolve(h.gridRuns);
		},
		polygonBounds: (polygon: MockPolygon) => {
			const r = rectOf(polygon);
			return Promise.resolve([r.west, r.south, r.east, r.north]);
		},
		polygonContainsPoints: (polygon: MockPolygon, lats: number[], lngs: number[]) => {
			const r = rectOf(polygon);
			return Promise.resolve(
				lats.map(
					(lat, i) => lat >= r.south && lat <= r.north && lngs[i] >= r.west && lngs[i] <= r.east,
				),
			);
		},
		polygonRandomPoints: (polygon: MockPolygon, count: number) => {
			const r = rectOf(polygon);
			const pts: [number, number][] = Array.from({ length: count }, () => [
				r.west + Math.random() * (r.east - r.west),
				r.south + Math.random() * (r.north - r.south),
			]);
			return Promise.resolve(pts);
		},
	},
}));

vi.mock("@/lib/sv/query", () => {
	const svMetadata = (ids: string[], signal?: AbortSignal) => {
		h.fetched.push(...ids);
		const answer = () => ids.map((id) => h.panos.get(id) ?? null);
		return h.work ? h.work.park(answer, signal) : Promise.resolve(answer());
	};
	// The probe is scripted with pano ids; a location search now answers the pano itself.
	const panosAt = (
		points: { lat: number; lng: number }[],
		radius: number,
		_opts?: unknown,
		signal?: AbortSignal,
	) => {
		const ids = h.probe(points, radius);
		const answer = () => ids.map((id) => (id ? (h.panos.get(id) ?? null) : null));
		return h.work ? h.work.park(answer, signal) : Promise.resolve(answer());
	};
	return { svMetadata, panosAt };
});

import {
	passesDescriptionSearch,
	passesInitialFilters,
	isPanoGood,
	bendAngle,
} from "@/plugins/generator/engine/filters";
import { GenerationEngine } from "@/plugins/generator/engine/GenerationEngine";
import { DEFAULT_SETTINGS } from "@/plugins/generator/engine/types";
import type {
	GeneratorSettings,
	GeneratorRegion,
	GenerationCallbacks,
	GeneratedLocation,
} from "@/plugins/generator/engine/types";
import type { Pano } from "@/bindings.gen";
import type { CameraType } from "@/bindings.consts";

function loc(description = "", shortDescription = ""): Pano {
	return { description, shortDescription } as unknown as Pano;
}

function settings(patch: Partial<GeneratorSettings>): GeneratorSettings {
	return { ...DEFAULT_SETTINGS, ...patch };
}

describe("passesDescriptionSearch", () => {
	it("passes everything when disabled or terms empty", () => {
		expect(
			passesDescriptionSearch(loc("Main Street"), settings({ searchInDescription: false })),
		).toBe(true);
		expect(
			passesDescriptionSearch(
				loc("Main Street"),
				settings({ searchInDescription: true, searchTerms: "  " }),
			),
		).toBe(true);
	});

	it("include + contains keeps matches, drops non-matches", () => {
		const s = settings({
			searchInDescription: true,
			searchTerms: "street",
			searchMode: "contains",
		});
		expect(passesDescriptionSearch(loc("Main Street"), s)).toBe(true);
		expect(passesDescriptionSearch(loc("Country Road"), s)).toBe(false);
	});

	it("exclude inverts the match", () => {
		const s = settings({
			searchInDescription: true,
			searchTerms: "street",
			searchMode: "contains",
			searchFilterType: "exclude",
		});
		expect(passesDescriptionSearch(loc("Main Street"), s)).toBe(false);
		expect(passesDescriptionSearch(loc("Country Road"), s)).toBe(true);
	});

	it("matches any of several comma-separated terms", () => {
		const s = settings({
			searchInDescription: true,
			searchTerms: "road, avenue",
			searchMode: "contains",
		});
		expect(passesDescriptionSearch(loc("Sunset Avenue"), s)).toBe(true);
		expect(passesDescriptionSearch(loc("Main Street"), s)).toBe(false);
	});

	it("is accent-insensitive", () => {
		const s = settings({ searchInDescription: true, searchTerms: "rua", searchMode: "fullword" });
		expect(passesDescriptionSearch(loc("Rúa do Vilar"), s)).toBe(true);
	});

	it("startswith / endswith operate per word", () => {
		const starts = settings({
			searchInDescription: true,
			searchTerms: "av",
			searchMode: "startswith",
		});
		expect(passesDescriptionSearch(loc("Sunset Avenue"), starts)).toBe(true);
		const ends = settings({
			searchInDescription: true,
			searchTerms: "street",
			searchMode: "endswith",
		});
		expect(passesDescriptionSearch(loc("Main Street"), ends)).toBe(true);
		expect(passesDescriptionSearch(loc("Streetlight"), ends)).toBe(false);
	});

	// The short description is the first part of the description on its own, so a term
	// that only appears there still has to match. It is carried separately because
	// sectionmatch treats it as a whole section rather than a comma-delimited piece.
	it("searches the short description, not just the description", () => {
		const contains = settings({
			searchInDescription: true,
			searchTerms: "vilar",
			searchMode: "contains",
		});
		expect(passesDescriptionSearch(loc("", "Rua do Vilar"), contains)).toBe(true);

		const section = settings({
			searchInDescription: true,
			searchTerms: "Main Street",
			searchMode: "sectionmatch",
		});
		expect(passesDescriptionSearch(loc("", "Main Street"), section)).toBe(true);
	});
});

/** Official ids end in one of A/Q/g/w, which is what `isOfficialPano` tests. */
const OFFICIAL_ID = `${"a".repeat(21)}A`;

function pano(over: {
	id?: string;
	links?: number;
	description?: string;
	imageDate?: string;
	cameraType?: CameraType | null;
}): Pano {
	const links = Array.from({ length: over.links ?? 2 }, () => ({ heading: 0, panoId: "x" }));
	const imageDate = over.imageDate ?? "2020-06";
	const [y, m] = imageDate.split("-");
	return {
		id: over.id ?? OFFICIAL_ID,
		description: over.description ?? "Main Street",
		shortDescription: "",
		links,
		date: { year: Number(y), month: Number(m), day: 1 },
		imageDate,
		time: [],
		cameraType: over.cameraType ?? "gen2",
	} as unknown as Pano;
}

describe("description-only rejection filters", () => {
	const withShort = (description: string, shortDescription: string) =>
		({ ...pano({}), description, shortDescription }) as Pano;

	it("rejectNoDescription keeps a pano carrying only a short description", () => {
		const s = settings({ rejectUnofficial: true, rejectNoDescription: true });
		expect(passesInitialFilters(withShort("", "Main Street"), s)).toBe(true);
		expect(passesInitialFilters(withShort("", ""), s)).toBe(false);
	});

	it("rejectDescription drops a pano carrying only a short description", () => {
		const s = settings({ rejectUnofficial: true, rejectDescription: true });
		expect(passesInitialFilters(withShort("", "Main Street"), s)).toBe(false);
		expect(passesInitialFilters(withShort("", ""), s)).toBe(true);
	});
});

describe("camera type filters", () => {
	it("rejectGen1 drops gen1 and keeps the rest", () => {
		const s = settings({ rejectGen1: true });
		expect(passesInitialFilters(pano({ cameraType: "gen1" }), s)).toBe(false);
		expect(passesInitialFilters(pano({ cameraType: "gen2" }), s)).toBe(true);
		expect(passesInitialFilters(pano({ cameraType: "gen4" }), s)).toBe(true);
		expect(passesInitialFilters(pano({ cameraType: null }), s)).toBe(true);
	});

	it("findGeneration matches the camera type exactly, not the rig family", () => {
		const gen2 = settings({ findGeneration: true, generation: 23 });
		expect(passesInitialFilters(pano({ cameraType: "gen2" }), gen2)).toBe(true);
		expect(passesInitialFilters(pano({ cameraType: "badcam" }), gen2)).toBe(false);
		expect(passesInitialFilters(pano({ cameraType: "tripod" }), gen2)).toBe(false);

		const gen4 = settings({ findGeneration: true, generation: 4 });
		expect(passesInitialFilters(pano({ cameraType: "gen4" }), gen4)).toBe(true);
		expect(passesInitialFilters(pano({ cameraType: "trekker" }), gen4)).toBe(false);
	});
});

describe("bendAngle", () => {
	it("a straight road bends 0 degrees", () => {
		expect(bendAngle([{ heading: 0 }, { heading: 180 }])).toBe(0);
	});

	it("a right angle bends 90 degrees", () => {
		expect(bendAngle([{ heading: 0 }, { heading: 90 }])).toBe(90);
	});

	it("folds headings that wrap past 360", () => {
		expect(bendAngle([{ heading: 350 }, { heading: 100 }])).toBe(70);
	});

	it("is null for one or three links", () => {
		expect(bendAngle([{ heading: 0 }])).toBeNull();
		expect(bendAngle([{ heading: 0 }, { heading: 90 }, { heading: 180 }])).toBeNull();
	});

	it("is null when a link has no heading", () => {
		expect(bendAngle([{ heading: 0 }, { heading: undefined as unknown as number }])).toBeNull();
	});
});

describe("isPanoGood new filters", () => {
	it("rejects panos outside the links-length range", () => {
		const s = settings({ filterByLinks: true, minLinks: 2, maxLinks: 3, rejectDateless: false });
		expect(isPanoGood(pano({ links: 2 }), s)).toBe(true);
		expect(isPanoGood(pano({ links: 1 }), s)).toBe(false);
		expect(isPanoGood(pano({ links: 4 }), s)).toBe(false);
	});

	it("rejectUnofficial tests the official id pattern, not the id length", () => {
		const s = settings({ rejectUnofficial: true, rejectDateless: false });
		expect(isPanoGood(pano({ id: OFFICIAL_ID }), s)).toBe(true);
		expect(isPanoGood(pano({ id: `${"a".repeat(21)}b` }), s)).toBe(false);
		expect(isPanoGood(pano({ id: `F:${"a".repeat(20)}` }), s)).toBe(false);
	});

	it("findCurves rejects panos not on a sharp enough bend", () => {
		const s = settings({ findCurves: true, minCurveAngle: 60, rejectDateless: false });
		const withLinks = (links: { heading: number; panoId: string }[]) =>
			({ ...pano({}), links }) as Pano;
		expect(
			isPanoGood(
				withLinks([
					{ heading: 0, panoId: "x" },
					{ heading: 90, panoId: "y" },
				]),
				s,
			),
		).toBe(true);
		expect(
			isPanoGood(
				withLinks([
					{ heading: 0, panoId: "x" },
					{ heading: 180, panoId: "y" },
				]),
				s,
			),
		).toBe(false);
	});

	it("applies description search as a gate", () => {
		const s = settings({
			searchInDescription: true,
			searchTerms: "bridge",
			searchMode: "contains",
			rejectDateless: false,
			rejectNoDescription: false,
		});
		expect(isPanoGood(pano({ description: "Old Bridge" }), s)).toBe(true);
		expect(isPanoGood(pano({ description: "Main Street" }), s)).toBe(false);
	});
});

// Engine-level tuning while a job runs: settings and the region set must be
// changeable mid-job without restarting.

function regionAt(id: string, west: number, east: number): GeneratorRegion {
	return {
		id,
		name: id,
		polygon: {
			coordinates: [
				[
					[west, -5],
					[east, -5],
					[east, 5],
					[west, 5],
					[west, -5],
				],
			],
			extraPolygons: null,
		},
		found: [],
		target: 1000, // never self-completes; tests drive stop() explicitly
		checkedPanos: new Set(),
		isProcessing: false,
	};
}

const noopCallbacks: GenerationCallbacks = {
	onLocationsFound: () => {},
	onProgress: () => {},
	onRegionComplete: () => {},
	onDone: () => {},
};

/** Scripts the coverage probe. `onBatch` sees each batch of points and the radius it
 *  was asked with, and returns the pano id found at each point (null for none). */
function probeWith(
	onBatch: (points: { lat: number; lng: number }[], radius: number) => (string | null)[],
): void {
	h.probe = onBatch;
}

/** Probe that finds nothing, counting the batch and the radius it carried. */
function emptyProbe(onBatch: (points: { lat: number; lng: number }[], radius: number) => void) {
	probeWith((points, radius) => {
		onBatch(points, radius);
		return points.map(() => null);
	});
}

// region A lives in negative longitudes, region B in positive — classify probes by sign.
const A = () => regionAt("A", -60, -40);
const B = () => regionAt("B", 40, 60);

// A pano that clears every filter under the permissive settings used below, located
// inside region A. Returned for both the location probe and the deep pano lookup.
const FOUND_PANO = "p".repeat(22);

function foundPano(lng: number, lat: number): unknown {
	return {
		id: FOUND_PANO,
		description: "Main Street, Springfield",
		shortDescription: "Main Street",
		lat,
		lng,
		links: [{ heading: 90, panoId: "l".repeat(22) }],
		date: { year: 2020, month: 6, day: 1 },
		imageDate: "2020-06",
		time: [],
		worldSize: { height: 6656 },
		pov: { heading: 0, tilt: 90, roll: 0 },
	};
}

const permissive = (patch: Partial<GeneratorSettings> = {}) =>
	settings({
		rejectUnofficial: false,
		rejectDateless: false,
		rejectNoDescription: false,
		numGenerators: 1,
		...patch,
	});

describe("GenerationEngine live tuning", () => {
	it("applies a mid-job radius change to subsequent probes", async () => {
		const radii: number[] = [];
		let calls = 0;

		emptyProbe((_points, radius) => {
			radii.push(radius);
			calls++;
			if (calls === 1) engine.updateSettings({ ...DEFAULT_SETTINGS, radius: 999 });
			if (calls >= 40) engine.stop();
		});
		const engine = new GenerationEngine(
			{ ...DEFAULT_SETTINGS, radius: 500, numGenerators: 1 },
			[A()],
			noopCallbacks,
		);

		await engine.start();

		expect(radii[0]).toBe(500); // first probe used the original radius
		expect(radii.length).toBeGreaterThan(1);
		expect(radii.slice(1).every((r) => r === 999)).toBe(true); // later probes used the live value
		expect(engine.isRunning()).toBe(false);
	});

	it("applies a mid-job target change, ending the region at the new cap", async () => {
		let calls = 0;

		emptyProbe(() => {
			calls++;
			if (calls === 3) engine.updateRegionTargets(new Map([["A", 0]]));
			if (calls > 10000) engine.stop();
		});
		const engine = new GenerationEngine(
			{ ...DEFAULT_SETTINGS, numGenerators: 1 },
			[A()],
			noopCallbacks,
		);

		await engine.start();

		expect(calls).toBeLessThan(10000); // worker saw the lowered target and stopped
		expect(engine.isRunning()).toBe(false);
	});

	it("reconcileRegions adds a region mid-job that then gets generated", async () => {
		const probes = { A: 0, B: 0 };
		let phase: "run" | "added" = "run";
		let bAtAdd = -1;
		let total = 0;

		emptyProbe((points) => {
			for (const pt of points) {
				if (pt.lng < 0) probes.A++;
				else probes.B++;
			}
			total++;
			if (phase === "run" && probes.A >= 3) {
				phase = "added";
				engine.pause();
				bAtAdd = probes.B; // B not present yet
				engine.reconcileRegions([A(), B()]);
				setTimeout(() => engine.resume(), 0);
			} else if (phase === "added" && probes.B >= 3) {
				engine.stop();
			}
			if (total > 10000) engine.stop();
		});
		const engine = new GenerationEngine(
			{ ...DEFAULT_SETTINGS, numGenerators: 1 },
			[A()],
			noopCallbacks,
		);

		await engine.start();

		expect(bAtAdd).toBe(0); // B did not exist before the add
		expect(probes.B).toBeGreaterThanOrEqual(3); // added region began generating
		expect(engine.isRunning()).toBe(false);
	});

	it("reconcileRegions removes a region, halting its probes while others continue", async () => {
		const probes = { A: 0, B: 0 };
		let phase: "run" | "removing" | "resumed" | "measuring" = "run";
		let bAfterResume = -1;
		let aAfterResume = -1;
		let total = 0;

		emptyProbe((points) => {
			for (const pt of points) {
				if (pt.lng < 0) probes.A++;
				else probes.B++;
			}
			total++;
			if (phase === "run" && probes.A >= 3 && probes.B >= 3) {
				phase = "removing";
				engine.pause();
				engine.reconcileRegions([A()]); // drop B
				setTimeout(() => {
					phase = "resumed";
					engine.resume();
				}, 0);
			} else if (phase === "resumed") {
				// first probe after resume: B is fully settled by now
				bAfterResume = probes.B;
				aAfterResume = probes.A;
				phase = "measuring";
			} else if (phase === "measuring" && probes.A >= aAfterResume + 200) {
				engine.stop();
			}
			if (total > 10000) engine.stop();
		});
		const engine = new GenerationEngine(
			{ ...DEFAULT_SETTINGS, numGenerators: 1 },
			[A(), B()],
			noopCallbacks,
		);

		await engine.start();

		expect(probes.B).toBe(bAfterResume); // removed region issued no further probes
		expect(probes.A).toBeGreaterThan(aAfterResume); // surviving region kept going
		expect(engine.isRunning()).toBe(false);
	});

	it("pause flushes confirmed finds that are still buffered", async () => {
		const flushed: GeneratedLocation[] = [];
		const result = { beforePause: -1, afterPause: -1 };
		let acted = false;

		h.panos.set(FOUND_PANO, foundPano(-50, 0));
		probeWith((points) => points.map(() => FOUND_PANO));
		const engine = new GenerationEngine(permissive(), [A()], {
			onLocationsFound: (locs) => flushed.push(...locs),
			onProgress: () => {
				if (acted) return;
				acted = true;
				// Defer past the probe call stack: the find is buffered (flushTimer
				// pending), not yet flushed. pause() must commit it.
				void Promise.resolve().then(() => {
					result.beforePause = flushed.length;
					engine.pause();
					result.afterPause = flushed.length;
					engine.stop();
				});
			},
			onRegionComplete: () => {},
			onDone: () => {},
		});

		await engine.start();

		expect(result.beforePause).toBe(0); // find sat buffered, not auto-flushed
		expect(result.afterPause).toBe(1); // pause committed it
		expect(flushed).toHaveLength(1);
		expect(flushed[0].panoId).toBe("p".repeat(22));
	});

	it("resume unblocks every paused worker, not just the last (numGenerators > 1)", async () => {
		let phase: "run" | "paused" | "resumed" = "run";
		let probesAfterResume = 0;
		let total = 0;

		emptyProbe(() => {
			total++;
			if (phase === "run" && total >= 5) {
				phase = "paused";
				engine.pause();
				setTimeout(() => {
					phase = "resumed";
					engine.resume();
				}, 0);
			} else if (phase === "resumed") {
				probesAfterResume++;
				if (probesAfterResume >= 50) engine.stop();
			}
			if (total > 10000) engine.stop();
		});
		const engine = new GenerationEngine(
			{ ...DEFAULT_SETTINGS, numGenerators: 2 },
			[A()],
			noopCallbacks,
		);

		// With a single shared resolver, one of the two workers would stay parked
		// forever and start() would never resolve.
		await engine.start();

		expect(probesAfterResume).toBeGreaterThanOrEqual(50);
		expect(engine.isRunning()).toBe(false);
	});
});

describe("GenerationEngine stop", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		h.work = new Work();
	});
	afterEach(() => {
		h.work = null;
		vi.useRealTimers();
	});

	/** Every probed point finds a pano of its own, so a live run keeps finding. */
	function probeFindsEverywhere(): void {
		let n = 0;
		probeWith((points) =>
			points.map(({ lat, lng }) => {
				const id = `q${String(n++).padStart(21, "0")}`;
				h.panos.set(id, { ...(foundPano(lng, lat) as object), id });
				return id;
			}),
		);
	}

	it("reaches no callback once stopped, however its lookups answer", async () => {
		probeFindsEverywhere();
		let calls = 0;
		const count = () => {
			calls++;
		};
		const engine = new GenerationEngine(permissive(), [A()], {
			onLocationsFound: count,
			onProgress: count,
			onRegionComplete: count,
			onDone: count,
		});
		const run = engine.start();
		await vi.advanceTimersByTimeAsync(0);
		await h.work!.answer();
		await h.work!.answer();
		expect(calls).toBeGreaterThan(0);

		engine.stop();
		const atStop = calls;
		for (let i = 0; i < 3; i++) await h.work!.answer({ honorAbort: false });
		await run;
		expect(calls).toBe(atStop);
	});

	it("aborts every lookup still in flight", async () => {
		emptyProbe(() => {});
		const engine = new GenerationEngine(permissive(), [A()], noopCallbacks);
		const run = engine.start();
		await vi.advanceTimersByTimeAsync(0);
		const inFlight = h.work!.pendingSignals();
		expect(inFlight.length).toBeGreaterThan(0);

		engine.stop();
		expect(inFlight.every((s) => s?.aborted)).toBe(true);
		await h.work!.answer();
		await run;
	});

	it("never starts once stopped", async () => {
		emptyProbe(() => {});
		const engine = new GenerationEngine(permissive(), [A()], noopCallbacks);
		engine.stop();
		await engine.start();
		expect(h.work!.issued).toBe(0);
		expect(engine.isRunning()).toBe(false);
	});

	it("asks nothing more when stopped while paused", async () => {
		emptyProbe(() => {});
		const engine = new GenerationEngine(permissive(), [A()], noopCallbacks);
		const run = engine.start();
		await vi.advanceTimersByTimeAsync(0);
		engine.pause();
		await h.work!.answer();
		const issued = h.work!.issued;

		engine.stop();
		await h.work!.answer();
		await run;
		expect(h.work!.issued).toBe(issued);
	});
});

describe("GenerationEngine probe batching", () => {
	it("probes a round's coordinates in one search, not fixed sub-chunks", async () => {
		const sizes: number[] = [];
		emptyProbe((points) => {
			sizes.push(points.length);
			engine.stop();
		});
		const engine = new GenerationEngine(
			permissive({ numGenerators: 1, speed: 300 }),
			[A()],
			noopCallbacks,
		);

		await engine.start();

		// One search carried the whole round; the engine schedules it under its inflight budget.
		expect(sizes[0]).toBe(300);
	});

	it("probes one at a time when findRegions dedups against prior finds", async () => {
		const sizes: number[] = [];
		emptyProbe((points) => {
			sizes.push(points.length);
			if (sizes.length >= 3) engine.stop();
		});
		const engine = new GenerationEngine(
			permissive({ numGenerators: 1, speed: 300, findRegions: true }),
			[A()],
			noopCallbacks,
		);

		await engine.start();

		expect(sizes.slice(0, 3)).toEqual([1, 1, 1]);
	});
});

// --- Grow (kernels) sampling ---

// A chain p0 -> p1 -> ... inside region A, each pano linking only to its successor.
// 2005 sits outside the default from/to window, so it is how a pano is made to fail.
function seedChain(length: number, isGood: (i: number) => boolean): void {
	h.panos.clear();
	for (let i = 0; i < length; i++) {
		h.panos.set(`p${i}`, {
			id: `p${i}`,
			description: "Main Street",
			shortDescription: "Main Street",
			lat: 0,
			lng: -50,
			links: i + 1 < length ? [{ heading: 90, panoId: `p${i + 1}` }] : [],
			date: isGood(i) ? { year: 2020, month: 6, day: 1 } : { year: 2005, month: 1, day: 1 },
			imageDate: isGood(i) ? "2020-06" : "2005-01",
			time: [],
			worldSize: { height: 6656 },
			pov: { heading: 0, tilt: 90, roll: 0 },
		});
	}
	h.seeds = [{ lat: 0, lng: -50, panoId: "p0" }];
	h.fetched = [];
}

describe("GenerationEngine grow sampling", () => {
	it("keeps growing past linksDepth while panos keep qualifying", async () => {
		seedChain(60, () => true);
		const region = regionAt("A", -60, -40);
		region.target = 20;

		const engine = new GenerationEngine(
			permissive({ samplingMode: "kernels", linksDepth: 2 }),
			[region],
			noopCallbacks,
		);

		await engine.start();

		// A fixed depth-2 ball around the lone seed would have stopped at 3 finds.
		expect(region.found).toHaveLength(20);
	});

	it("gives up after linksDepth consecutive misses", async () => {
		seedChain(60, () => false);
		const region = regionAt("A", -60, -40);

		const engine = new GenerationEngine(
			permissive({ samplingMode: "kernels", linksDepth: 2 }),
			[region],
			noopCallbacks,
		);

		await engine.start();

		expect(region.found).toHaveLength(0);
		expect(h.fetched).toEqual(["p0", "p1", "p2"]);
	});
});

// --- Grid sampling ---

import { gridPointSource, streamedPoints } from "@/plugins/generator/engine/pointSources";

const GRID_RUNS = [
	{ lat: 1, lng: -50, lngStep: 0.5, count: 4 },
	{ lat: 1.5, lng: -49.75, lngStep: 0.5, count: 3 },
	{ lat: 2, lng: -50, lngStep: 0.5, count: 1 },
];
const GRID_POINTS = GRID_RUNS.flatMap((r) =>
	Array.from({ length: r.count }, (_, m) => `${r.lat},${r.lng + m * r.lngStep}`),
);
const keyOf = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`;

describe("gridPointSource", () => {
	it("draws every grid point once across batches, then runs dry", async () => {
		const take = gridPointSource(GRID_RUNS);
		const drawn = [...(await take(3)), ...(await take(3)), ...(await take(3))].map(keyOf);
		expect(drawn.sort()).toEqual([...GRID_POINTS].sort());
		expect(await take(3)).toEqual([]);
	});
});

describe("streamedPoints", () => {
	const P = (lat: number): { lat: number; lng: number } => ({ lat, lng: 0 });

	it("serves points emitted so far without waiting for the producer to finish", async () => {
		let finish!: () => void;
		const take = streamedPoints(async (emit) => {
			emit([P(1), P(2)]);
			await new Promise<void>((r) => (finish = r));
			emit([P(3)]);
		});
		expect((await take(5)).map((p) => p.lat).sort()).toEqual([1, 2]);
		finish();
		expect(await take(5)).toEqual([P(3)]);
		expect(await take(5)).toEqual([]);
	});

	it("a draw during starvation waits for the next emit instead of ending the supply", async () => {
		let emitLate!: (pts: { lat: number; lng: number }[]) => void;
		const take = streamedPoints(
			(emit) =>
				new Promise<void>((resolve) => {
					emitLate = (pts) => {
						emit(pts);
						resolve();
					};
				}),
		);
		const pending = take(1);
		emitLate([P(7)]);
		expect(await pending).toEqual([P(7)]);
		expect(await take(1)).toEqual([]);
	});

	it("draws split the buffer without duplicating or dropping points", async () => {
		const take = streamedPoints(async (emit) => emit([P(1), P(2), P(3)]));
		const first = await take(2);
		const second = await take(2);
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(1);
		expect([...first, ...second].map((p) => p.lat).sort()).toEqual([1, 2, 3]);
		expect(await take(2)).toEqual([]);
	});

	it("a producer failure surfaces on the draw once the buffer is drained", async () => {
		const take = streamedPoints(async (emit) => {
			emit([P(1)]);
			throw new Error("tiles down");
		});
		expect(await take(1)).toEqual([P(1)]);
		await expect(take(1)).rejects.toThrow("tiles down");
	});
});

describe("GenerationEngine grid sampling", () => {
	it("builds one honeycomb radius * sqrt(3) apart and probes each point once across workers", async () => {
		h.gridRuns = GRID_RUNS;
		h.gridRequests = [];
		const probed: string[] = [];
		emptyProbe((points) => probed.push(...points.map(keyOf)));

		const engine = new GenerationEngine(
			permissive({ samplingMode: "grid", radius: 500, numGenerators: 3, speed: 2 }),
			[A()],
			noopCallbacks,
		);
		await engine.start();

		expect(h.gridRequests).toHaveLength(1);
		expect(h.gridRequests[0]).toBeCloseTo(500 * Math.sqrt(3));
		expect(probed.sort()).toEqual([...GRID_POINTS].sort());
	});
});
