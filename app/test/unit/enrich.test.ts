import { describe, it, expect, vi, beforeEach } from "vitest";

// enrich.add pulls in Tauri/store/SV modules at import; stub the ones the single-location
// path doesn't use so it is drivable in a node environment. The real filterEnrichPatch
// (from fieldDefs.add) is kept -- the bug lived in its interaction.
const h = vi.hoisted(() => ({
	enrichFields: null as string[] | null,
	written: [] as Record<string, unknown>[],
}));

vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({
		map: { settings: { enrichMetadata: true, enrichFields: h.enrichFields } },
	}),
	updateLocations: async (updates: { patch: { extra: Record<string, unknown> } }[]) => {
		for (const u of updates) h.written.push(u.patch.extra);
	},
}));
vi.mock("@/lib/sv/query", () => ({ svMetadata: async () => [] }));
vi.mock("@/lib/data/procedures", () => ({
	procedureEntry: (name: string) => `res://procedures/${name}.js`,
	runProvidersForIds: async () => {},
	runProviders: async () => ({}),
	enrichFieldProviders: () => [],
	outcomeDidWork: () => false,
}));
vi.mock("@/lib/util/timezone", () => ({ resolveTimezone: () => "America/New_York" }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
const cmdMock = vi.hoisted(() => ({
	checkBorderFile: vi.fn(async () => true),
	downloadBorderFile: vi.fn(async () => {}),
	borderClassify: vi.fn(async (_level: string, pts: [number, number][]) =>
		pts.map((): string | null => null),
	),
}));
vi.mock("@/lib/commands", () => ({ cmd: cmdMock }));
vi.mock("@/lib/util/toast", () => ({ toast: () => {} }));

import {
	enrich,
	exactDateProvider,
	panoResolveProvider,
	subdivisionProvider,
	svMetaProvider,
	timezoneProvider,
} from "@/lib/sv/enrich";
import { getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { createLocation } from "@/types";
import type { Location } from "@/types";
import type { Pano } from "@/types";

/** The `metadata` query's answer for a pano: one decoded image, nothing derived. */
function answer(imageDate: string | null, over: Partial<Pano> = {}): Pano {
	const [y, m] = (imageDate ?? "").split("-");
	return {
		pano: "pA",
		panoFrontend: 2,
		lat: 1,
		lng: 2,
		altitude: 10,
		pov: null,
		// 8192 = gen4
		worldSize: { width: 16384, height: 8192 },
		tileSize: { width: 512, height: 512 },
		copyright: "",
		description: "",
		shortDescription: "",
		uploaderName: null,
		countryCode: "US",
		levelId: null,
		links: [],
		time: [],
		date: imageDate ? { year: Number(y), month: Number(m), day: 1 } : null,
		source: null,
		...over,
	};
}

function loc(extra: Record<string, unknown>): Location {
	return { ...createLocation({ lat: 1, lng: 2 }), extra };
}

/** The `extra` a single-location enrich wrote, or null when it wrote nothing. */
async function enrichPatch(
	data: Pano,
	location: Location,
): Promise<Record<string, unknown> | null> {
	await enrich(location, data);
	return h.written[0] ?? null;
}

describe("single-location enrich — stale datetime/timezone clearing", () => {
	beforeEach(() => {
		h.written = [];
		h.enrichFields = null;
	});

	it("clears stale datetime/timezone when imageDate changes, even with datetime enrichment OFF", async () => {
		// Default enrich set excludes datetime/timezone (opt-in). The clear must still apply.
		const defaults = getDefaultEnrichKeys();
		expect(defaults).not.toContain("datetime");

		const patch = (await enrichPatch(
			answer("2023-03"),
			loc({ imageDate: "2099-01", datetime: 9999999999, timezone: "Fake/Zone" }),
		))!;

		expect(patch.imageDate).toBe("2023-03");
		expect(patch.datetime).toBeNull();
		expect(patch.timezone).toBeNull();
	});

	it("does NOT add datetime/timezone keys when imageDate is unchanged", async () => {
		const patch = (await enrichPatch(
			answer("2099-01"),
			loc({ imageDate: "2099-01", datetime: 9999999999, timezone: "Fake/Zone" }),
		))!;
		expect("datetime" in patch).toBe(false);
		expect("timezone" in patch).toBe(false);
	});

	it("does NOT clear when there was no stale datetime to begin with", async () => {
		const patch = (await enrichPatch(answer("2023-03"), loc({ imageDate: "2099-01" })))!;
		expect("datetime" in patch).toBe(false);
	});

	it("still respects the filter for normal enrich keys", async () => {
		h.enrichFields = ["altitude"];
		const patch = (await enrichPatch(answer("2023-03"), loc({ imageDate: "2023-03" })))!;
		expect(patch.altitude).toBe(10);
		expect("countryCode" in patch).toBe(false); // filtered out
	});

	it("writes exactly the shared derivation, filtered to the active fields", async () => {
		h.enrichFields = ["imageDate", "coverageDates"];
		const data = answer("2023-03", {
			time: [
				{ pano: "p0", date: "2019-05-01" },
				{ pano: "pA", date: "2023-03-01" },
			],
		});
		const patch = (await enrichPatch(data, loc({})))!;
		expect(patch).toEqual({ imageDate: "2023-03", coverageDates: ["2019-05", "2023-03"] });
	});

	it("leaves the answer it was handed untouched", async () => {
		h.enrichFields = ["altitude"];
		const data = answer("2023-03");
		const before = JSON.stringify(data);
		await enrich(loc({ imageDate: "2099-01", datetime: 1 }), data);
		expect(JSON.stringify(data)).toBe(before);
	});
});

describe("exactDateProvider", () => {
	it("requires imageDate, so bulk waves run it after the core metadata pass", () => {
		expect(exactDateProvider.requires).toContain("imageDate");
	});

	it("is procedure-backed, producing datetime only", () => {
		expect(Object.keys(exactDateProvider.fieldDefs ?? {})).toEqual(["datetime"]);
		expect(exactDateProvider.procedure).toMatchObject({
			entry: "res://procedures/exactDate.js",
			batch: { mode: "chunk", size: 50 },
			inflight: 512,
		});
	});

	it("leaves retry of throttled SingleImageSearch responses to the engine", () => {
		expect(exactDateProvider.procedure!.retry).toEqual({ attempts: 3, on: [429, 501, 503] });
	});
});

describe("timezoneProvider", () => {
	it("requires datetime, so it runs after the exact-date pass", () => {
		expect(timezoneProvider.requires).toContain("datetime");
	});

	it("is procedure-backed, producing timezone only", () => {
		expect(Object.keys(timezoneProvider.fieldDefs ?? {})).toEqual(["timezone"]);
		expect(timezoneProvider.procedure).toMatchObject({
			entry: "res://procedures/timezone.js",
			batch: { mode: "chunk", size: 10000 },
		});
	});
});

describe("subdivisionProvider", () => {
	it("is procedure-backed with an adm1 prepare gate", () => {
		expect(Object.keys(subdivisionProvider.fieldDefs ?? {})).toEqual(["subdivision"]);
		expect(subdivisionProvider.procedure).toMatchObject({
			entry: "res://procedures/subdivision.js",
			batch: { mode: "chunk", size: 2000 },
		});
		expect(typeof subdivisionProvider.procedure?.prepare).toBe("function");
	});
});

describe("panoResolveProvider", () => {
	it("writes the panoId column instead of an extra field, so it is never selectable", () => {
		expect(panoResolveProvider.fieldDefs).toBeUndefined();
		expect(panoResolveProvider.provides).toEqual(["panoId"]);
	});

	it("batches the location search the way the JS prelude did", () => {
		expect(panoResolveProvider.procedure).toMatchObject({
			entry: "res://procedures/panoResolve.js",
			batch: { mode: "chunk", size: 200 },
			config: { radius: 50 },
		});
	});
});

describe("svMetaProvider", () => {
	it("requires panoId, so the engine schedules it after the pano-resolve wave", () => {
		expect(svMetaProvider.requires).toContain("panoId");
	});
});
