import { describe, it, expect, vi, beforeEach } from "vitest";

// enrich.add pulls in Tauri/store/SV modules at import; stub the ones the single-location
// path doesn't use so it is drivable in a node environment. The real filterEnrichPatch
// (from fieldDefs.add) is kept -- the bug lived in its interaction.
const h = vi.hoisted(() => ({
	enrichFields: null as string[] | null,
	enrichMetadata: true,
	ran: [] as [string, string[]][],
	targets: [] as unknown[],
	runs: 0,
}));

vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({
		map: h.enrichMetadata
			? { settings: { enrichMetadata: true, enrichFields: h.enrichFields } }
			: null,
	}),
}));
vi.mock("@/lib/sv/query", () => ({ svMetadata: async () => [] }));
vi.mock("@/lib/data/procedures", () => ({
	procedureEntry: (name: string) => `res://procedures/${name}.js`,
	runProviders: async (
		items: { provider: { id: string }; fields?: string[] }[],
		_rows: unknown,
		opts?: { on?: unknown },
	) => {
		h.runs++;
		h.ran = items.map((i) => [i.provider.id, i.fields ?? []]);
		h.targets.push(opts?.on ?? null);
		return {};
	},
}));
vi.mock("@/lib/util/timezone", () => ({ resolveTimezone: () => "America/New_York" }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
const cmdMock = vi.hoisted(() => ({
	storeSetDerived: vi.fn(async () => null),
	checkBorderFile: vi.fn(async () => true),
	downloadBorderFile: vi.fn(async () => {}),
	borderClassify: vi.fn(async (_level: string, pts: [number, number][]) =>
		pts.map((): string | null => null),
	),
}));
vi.mock("@/lib/commands", () => ({ cmd: cmdMock }));
vi.mock("@/lib/util/toast", () => ({ toast: () => {} }));

import { enrich } from "@/lib/sv/enrich";
import {
	exactDateProvider,
	panoResolveProvider,
	subdivisionProvider,
	svMetaProvider,
	timezoneProvider,
} from "@/lib/sv/providers";

describe("enrich", () => {
	beforeEach(() => {
		h.enrichFields = null;
		h.enrichMetadata = true;
		h.ran = [];
		h.targets = [];
		h.runs = 0;
	});

	it("runs every field-producing provider at the given target", async () => {
		await enrich(
			{ type: "Everything" },
			{ on: { kind: "pending", name: "viewer" }, resolve: false },
		);
		expect(h.runs).toBe(1);
		expect(h.ran.map(([id]) => id)).toEqual(["svMeta", "exactDate", "timezone", "subdivision"]);
		expect(h.targets).toEqual([{ kind: "pending", name: "viewer" }]);
	});

	it("narrows each provider to the map's enabled fields", async () => {
		h.enrichFields = ["altitude", "timezone"];
		await enrich(
			{ type: "Everything" },
			{ on: { kind: "pending", name: "viewer" }, resolve: false },
		);
		expect(h.ran).toEqual([
			["svMeta", ["altitude"]],
			["exactDate", []],
			["timezone", ["timezone"]],
			["subdivision", []],
		]);
	});

	it("does nothing without an open map", async () => {
		h.enrichMetadata = false;
		await enrich(
			{ type: "Everything" },
			{ on: { kind: "pending", name: "viewer" }, resolve: false },
		);
		expect(h.runs).toBe(0);
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
		});
	});

	it("takes the engine's transient-status retry default", () => {
		expect(exactDateProvider.procedure!.retry).toBeUndefined();
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

	it("resolves panos in chunks of 200 within the search radius", () => {
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
