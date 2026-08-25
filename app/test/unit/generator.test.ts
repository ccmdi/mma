import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
	seeds: [] as { lat: number; lng: number; panoId: string }[],
	// panoId -> the metadata GetMetadata would return for it
	panos: new Map<string, unknown>(),
	fetched: [] as string[],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeFindNearby: () => Promise.resolve(h.seeds),
		storeNearAny: (lats: number[]) => Promise.resolve(lats.map(() => false)),
	},
}));

vi.mock("@/lib/sv/svMeta", () => {
	const fetchSvMetadata = (ids: string[]) => {
		h.fetched.push(...ids);
		return Promise.resolve(ids.map((id) => h.panos.get(id) ?? null));
	};
	return { fetchSvMetadata, fetchSvMetadataBatched: fetchSvMetadata };
});

import { passesDescriptionSearch, isPanoGood } from "@/plugins/generator/engine/filters";
import { GenerationEngine } from "@/plugins/generator/engine/GenerationEngine";
import { DEFAULT_SETTINGS } from "@/plugins/generator/engine/types";
import type {
	GeneratorSettings,
	GeneratorRegion,
	GenerationCallbacks,
} from "@/plugins/generator/engine/types";

function loc(description = "", shortDescription = ""): google.maps.StreetViewLocation {
	return { description, shortDescription } as unknown as google.maps.StreetViewLocation;
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
});

function pano(over: {
	pano?: string;
	links?: number;
	description?: string;
	imageDate?: string;
}): google.maps.StreetViewResolvedPanoramaData {
	const links = Array.from({ length: over.links ?? 2 }, () => ({ heading: 0, pano: "x" }));
	return {
		location: {
			pano: over.pano ?? "a".repeat(22),
			description: over.description ?? "Main Street",
			shortDescription: "",
		},
		links,
		imageDate: over.imageDate ?? "2020-06",
		time: [],
	} as unknown as google.maps.StreetViewResolvedPanoramaData;
}

describe("isPanoGood new filters", () => {
	it("rejects panos outside the links-length range", () => {
		const s = settings({ filterByLinks: true, minLinks: 2, maxLinks: 3, rejectDateless: false });
		expect(isPanoGood(pano({ links: 2 }), s)).toBe(true);
		expect(isPanoGood(pano({ links: 1 }), s)).toBe(false);
		expect(isPanoGood(pano({ links: 4 }), s)).toBe(false);
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
		feature: {
			type: "Feature",
			properties: { name: id },
			geometry: {
				type: "Polygon",
				coordinates: [
					[
						[west, -5],
						[east, -5],
						[east, 5],
						[west, 5],
						[west, -5],
					],
				],
			},
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

function fakeGoogleWith(
	getPanorama: (
		req: { location?: { lat?: number; lng: number }; pano?: string; radius?: number },
		cb: (d: unknown, s: string) => void,
	) => void,
): Google {
	class FakeStreetViewService {
		getPanorama = getPanorama;
	}
	return {
		maps: {
			StreetViewService: FakeStreetViewService,
			StreetViewSource: { GOOGLE: "google", DEFAULT: "default" },
		},
	} as unknown as Google;
}

// region A lives in negative longitudes, region B in positive — classify probes by sign.
const A = () => regionAt("A", -60, -40);
const B = () => regionAt("B", 40, 60);

// A pano that clears every filter under the permissive settings used below, located
// inside region A. Returned for both the location probe and the deep pano lookup.
function foundPano(lng: number, lat: number): unknown {
	return {
		location: {
			pano: "p".repeat(22),
			description: "Main Street",
			shortDescription: "",
			latLng: { lat: () => lat, lng: () => lng },
		},
		links: [{ heading: 90, pano: "l".repeat(22) }],
		imageDate: "2020-06",
		time: [],
		tiles: { centerHeading: 0, worldSize: { height: 6656 } },
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

		const engine = new GenerationEngine(
			fakeGoogleWith((req: { radius?: number } & { location?: { lng: number } }, cb) => {
				radii.push(req.radius ?? -1);
				calls++;
				if (calls === 1) engine.updateSettings({ ...DEFAULT_SETTINGS, radius: 999 });
				if (calls >= 40) engine.stop();
				cb(null, "ZERO_RESULTS");
			}),
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

		const engine = new GenerationEngine(
			fakeGoogleWith((_req, cb) => {
				calls++;
				if (calls === 3) engine.updateRegionTargets(new Map([["A", 0]]));
				if (calls > 10000) engine.stop();
				cb(null, "ZERO_RESULTS");
			}),
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

		const engine = new GenerationEngine(
			fakeGoogleWith((req, cb) => {
				if (req.location) {
					if (req.location.lng < 0) probes.A++;
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
				cb(null, "ZERO_RESULTS");
			}),
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

		const engine = new GenerationEngine(
			fakeGoogleWith((req, cb) => {
				if (req.location) {
					if (req.location.lng < 0) probes.A++;
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
				cb(null, "ZERO_RESULTS");
			}),
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

		const engine = new GenerationEngine(
			fakeGoogleWith((_req, cb) => {
				cb(foundPano(-50, 0), "OK");
			}),
			permissive(),
			[A()],
			{
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
			},
		);

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

		const engine = new GenerationEngine(
			fakeGoogleWith((_req, cb) => {
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
				cb(null, "ZERO_RESULTS");
			}),
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

// --- Grow (kernels) sampling ---

// A chain p0 -> p1 -> ... inside region A, each pano linking only to its successor.
// 2005 sits outside the default from/to window, so it is how a pano is made to fail.
function seedChain(length: number, isGood: (i: number) => boolean): void {
	h.panos.clear();
	for (let i = 0; i < length; i++) {
		h.panos.set(`p${i}`, {
			location: {
				pano: `p${i}`,
				description: "Main Street",
				shortDescription: "",
				latLng: { lat: () => 0, lng: () => -50 },
			},
			links: i + 1 < length ? [{ heading: 90, pano: `p${i + 1}` }] : [],
			imageDate: isGood(i) ? "2020-06" : "2005-01",
			time: [],
			tiles: { centerHeading: 0, worldSize: { height: 6656 } },
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
			fakeGoogleWith(() => {}),
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
			fakeGoogleWith(() => {}),
			permissive({ samplingMode: "kernels", linksDepth: 2 }),
			[region],
			noopCallbacks,
		);

		await engine.start();

		expect(region.found).toHaveLength(0);
		expect(h.fetched).toEqual(["p0", "p1", "p2"]);
	});
});

// --- Poisson disk sampling ---

import { poissonDiskSample } from "@/plugins/generator/engine/geo";

function squareFeature(
	west: number,
	south: number,
	east: number,
	north: number,
): GeoJSON.Feature<GeoJSON.Polygon> {
	return {
		type: "Feature",
		properties: {},
		geometry: {
			type: "Polygon",
			coordinates: [
				[
					[west, south],
					[east, south],
					[east, north],
					[west, north],
					[west, south],
				],
			],
		},
	};
}

describe("poissonDiskSample", () => {
	it("all points are inside the polygon", () => {
		const feature = squareFeature(10, 50, 11, 51);
		const points = poissonDiskSample(feature, 5000);
		expect(points.length).toBeGreaterThan(0);
		for (const p of points) {
			expect(p.lng).toBeGreaterThanOrEqual(10);
			expect(p.lng).toBeLessThanOrEqual(11);
			expect(p.lat).toBeGreaterThanOrEqual(50);
			expect(p.lat).toBeLessThanOrEqual(51);
		}
	});

	it("no two points are closer than minDistance", () => {
		const feature = squareFeature(10, 50, 10.5, 50.5);
		const minDist = 3000;
		const points = poissonDiskSample(feature, minDist);

		const mPerDegLat = 111_320;
		const midLat = 50.25;
		const mPerDegLng = mPerDegLat * Math.cos((midLat * Math.PI) / 180);

		for (let i = 0; i < points.length; i++) {
			for (let j = i + 1; j < points.length; j++) {
				const dx = (points[i].lng - points[j].lng) * mPerDegLng;
				const dy = (points[i].lat - points[j].lat) * mPerDegLat;
				const dist = Math.sqrt(dx * dx + dy * dy);
				expect(dist).toBeGreaterThanOrEqual(minDist * 0.99);
			}
		}
	});

	it("produces a reasonable number of points for the area", () => {
		const feature = squareFeature(10, 50, 11, 51);
		const minDist = 5000;
		const points = poissonDiskSample(feature, minDist);

		const mPerDegLat = 111_320;
		const mPerDegLng = mPerDegLat * Math.cos((50.5 * Math.PI) / 180);
		const areaM2 = 1 * mPerDegLng * (1 * mPerDegLat);
		const maxPacking = areaM2 / (minDist * minDist * Math.PI * 0.25);

		expect(points.length).toBeGreaterThan(maxPacking * 0.3);
		expect(points.length).toBeLessThan(maxPacking * 1.5);
	});

	it("handles tiny polygons gracefully", () => {
		const feature = squareFeature(10, 50, 10.001, 50.001);
		const points = poissonDiskSample(feature, 5000);
		expect(points.length).toBeLessThanOrEqual(1);
	});
});
