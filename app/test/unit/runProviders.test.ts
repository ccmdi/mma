import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcedureProgress, Selector } from "@/bindings.gen";

// Bulk work is selector-first: JS never reads rows, it hands the Rust engine a set of
// provider declarations plus the caller's Selector. These mocks record every declaration.
const h = vi.hoisted(() => ({
	decls: [] as {
		id: string;
		select: Selector;
		fields: string[];
		config: string | null;
		sink: string;
		force: boolean | null;
	}[],
	total: 5,
	failed: 0,
	skipped: 0,
	/// When set, the exact progress payloads the engine emits, in order, instead of one
	/// finished snapshot per declaration. Must end with every declaration finished.
	script: [] as Omit<ProcedureProgress, "runId">[],
	enrichFields: null as string[] | null,
	onProgress: null as ((p: unknown) => void) | null,
	onResult: null as ((p: unknown) => void) | null,
	/// Answers a collect provider delivers, per provider id.
	answers: {} as Record<string, { id: number; json: string }[]>,
	/// Ids a provider fails, per provider id.
	failedIds: {} as Record<string, number[]>,
	queries: [] as { entry: string; input: string; cancel: number | null }[],
	rowRuns: [] as { ids: number[]; force: boolean; cancel: number | null }[],
	cancelled: [] as number[],
	queryAnswer: ((input: string) => Promise.resolve(input)) as (i: string) => Promise<string>,
}));

vi.mock("@/lib/util/log", () => ({
	log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {} },
}));
vi.mock("@/lib/i18n", () => ({ msg: (s: string) => s, t: (s: string) => s }));
vi.mock("@/lib/util/toast", () => ({ toast: () => {} }));
vi.mock("@/lib/sv/query", () => ({ svMetadata: async () => [] }));

vi.mock("@/store/useMapStore", () => ({
	holdAutosave: () => () => {},
	updateLocations: async () => {},
	getMapState: () => ({
		map: { settings: { enrichMetadata: true, enrichFields: h.enrichFields } },
	}),
}));

// The real fieldDefs module runs here, so the field catalog it reads has to be present.
vi.mock("@/bindings.consts", () => ({
	LocationFlag: { None: 0, LoadAsPanoId: 1, Informational: 2 },
	BUILTIN_FIELDS: [
		{ key: "panoId", label: "Pano ID", type: "string", kind: null, comparison: null },
		{ key: "heading", label: "Heading", type: "number", kind: "writable", comparison: null },
	],
	KNOWN_FIELDS: [
		{ key: "altitude", type: "number", label: "Altitude", defaultOff: false },
		{ key: "countryCode", type: "string", label: "Country code", defaultOff: false },
		{ key: "cameraType", type: "enum", label: "Camera type", defaultOff: false },
		{ key: "panoType", type: "enum", label: "Pano type", defaultOff: false },
		{ key: "imageDate", type: "month", label: "Image date", defaultOff: false },
		{ key: "datetime", type: "date", label: "Exact date", defaultOff: true },
		{ key: "timezone", type: "enum", label: "Timezone", defaultOff: true },
		{ key: "drivingDirection", type: "number", label: "Driving direction", defaultOff: true },
		{ key: "uploaderName", type: "string", label: "Uploader", defaultOff: true },
		{ key: "coverageDates", type: "array", label: "Coverage dates", defaultOff: true },
		{ key: "subdivision", type: "string", label: "Subdivision", defaultOff: true },
	].map((f) => ({ ...f, values: [], labels: [], circularPeriod: null })),
}));

vi.mock("@/bindings.gen", () => ({
	events: {
		procedureProgress: {
			listen: (cb: (e: { payload: unknown }) => void) => {
				h.onProgress = (p) => cb({ payload: p });
				return Promise.resolve(() => {});
			},
		},
		procedureResult: {
			listen: (cb: (e: { payload: unknown }) => void) => {
				h.onResult = (p) => cb({ payload: p });
				return Promise.resolve(() => {});
			},
		},
	},
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		checkBorderFile: async () => true,
		downloadBorderFile: async () => {},
		procedureRun: (decls: typeof h.decls) => {
			h.decls.push(...decls);
			queueMicrotask(() => {
				for (const d of decls) {
					const entries = h.answers[d.id] ?? [];
					const failed = h.failedIds[d.id] ?? [];
					if (entries.length || failed.length)
						h.onResult?.({ runId: 7, providerId: d.id, entries, failed });
				}
				if (h.script.length > 0) {
					for (const p of h.script) h.onProgress?.({ runId: 7, ...p });
					return;
				}
				for (const d of decls)
					h.onProgress?.({
						runId: 7,
						providerId: d.id,
						done: h.total,
						total: h.total,
						failed: h.failed,
						skipped: h.skipped,
						finished: true,
					});
			});
			return Promise.resolve(7);
		},
		procedureCancel: () => Promise.resolve(),
		procedureRunRows: async (
			decls: typeof h.decls,
			force: boolean,
			rows: { id: number; extra: Record<string, unknown> | null }[],
			cancel: number | null,
		) => {
			h.decls.push(...decls);
			h.rowRuns.push({ ids: rows.map((r) => r.id), force, cancel });
			return {
				rows: rows.map((r) => ({ ...r, extra: { ...r.extra, ran: true } })),
				failed: { [decls[0].id]: [rows[0].id] },
			};
		},
		procedureQuery: (
			entry: string,
			input: string,
			_config: string | null,
			cancel: number | null,
		) => {
			h.queries.push({ entry, input, cancel });
			return h.queryAnswer(input);
		},
		procedureQueryCancel: (cancel: number) => {
			h.cancelled.push(cancel);
			return Promise.resolve();
		},
	},
}));

import {
	runProcedure,
	runProviders,
	queryProcedure,
	resolveFieldLabels,
	type ProviderPart,
} from "@/lib/data/procedures";
import { createLocation } from "@/types";
import { registerProvider, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { enrichAll, enrichRuns, panoResolveProvider, svMetaProvider } from "@/lib/sv/enrich";
import { bulkPinToPano } from "@/lib/sv/pinPano";
import { bulkPanHeading } from "@/lib/sv/headingRoad";
import type { Provider, ProcedureSpec } from "@/lib/data/fieldDefs";

const plainProvider: Provider = {
	id: "prov",
	label: "Prov",
	fieldDefs: {
		altitude: { type: "number", label: "Altitude", values: null, labels: null, comparison: null },
	},
	procedure: { entry: "res://p.js", batch: { mode: "chunk", size: 10 } },
};

const coreProvider: Provider = {
	id: "core",
	provides: ["panoId"],
	procedure: { entry: "res://procedures/c.js", batch: { mode: "chunk", size: 10 } },
};

beforeEach(() => {
	h.decls = [];
	h.total = 5;
	h.failed = 0;
	h.skipped = 0;
	h.script = [];
	h.enrichFields = null;
	h.queries = [];
	h.cancelled = [];
	h.answers = {};
	h.failedIds = {};
	h.queryAnswer = (input) => Promise.resolve(input);
});

const ids = () => h.decls.map((d) => d.id);

const collectProvider: Provider = {
	id: "collect",
	procedure: { entry: "res://q.js", batch: { mode: "perRow" }, sink: "collect" },
};

describe("a collect provider's answers reach the caller", () => {
	it("declares the sink its procedure asks for", async () => {
		await runProviders([{ provider: collectProvider }], { type: "Everything" });
		expect(h.decls[0].sink).toBe("collect");
	});

	it("defaults to the patch sink", async () => {
		await runProviders([{ provider: plainProvider }], { type: "Everything" });
		expect(h.decls[0].sink).toBe("patch");
	});

	it("runProcedure borrows a writing procedure for its answers alone, typed by its spec", async () => {
		h.answers = { core: [{ id: 1, json: '{"panoId":"ABC"}' }] };
		const spec = coreProvider.procedure as ProcedureSpec<{ panoId: string }>;
		const run = await runProcedure(spec, { type: "Everything" }, { id: "core", sink: "collect" });
		expect(h.decls[0]).toMatchObject({ id: "core", sink: "collect", fields: [] });
		expect(run.collected?.[0].value.panoId).toBe("ABC");
	});

	it("hands back every delivered entry, parsed", async () => {
		h.answers = {
			collect: [
				{ id: 1, json: "3" },
				{ id: 2, json: '{"panoId":"ABC"}' },
			],
		};
		const run = await runProviders([{ provider: collectProvider }], { type: "Everything" });
		expect(run.collect.collected).toEqual([
			{ id: 1, value: 3 },
			{ id: 2, value: { panoId: "ABC" } },
		]);
	});

	it("leaves `collected` off a provider that wrote its results", async () => {
		const run = await runProviders([{ provider: plainProvider }], { type: "Everything" });
		expect(run.prov.collected).toBeUndefined();
	});

	it("drops an entry that is not JSON rather than the run", async () => {
		h.answers = { collect: [{ id: 1, json: "not json" }] };
		const run = await runProviders([{ provider: collectProvider }], { type: "Everything" });
		expect(run.collect.collected).toEqual([{ id: 1, value: null }]);
	});
});

describe("runProviders hands the engine the caller's selector", () => {
	it("passes the run selector through when the procedure declares no select of its own", async () => {
		const selector: Selector = { type: "Manual", locations: [1, 2] };
		await runProviders([{ provider: plainProvider }], selector);

		expect(h.decls).toHaveLength(1);
		expect(h.decls[0].select).toEqual(selector);
	});

	it("drops a provider whose every field was deselected", async () => {
		await runProviders([{ provider: plainProvider, fields: [] }], { type: "Everything" });
		expect(h.decls).toEqual([]);
	});

	it("keeps a provider with no fieldDefs whatever the field selection is", async () => {
		await runProviders([{ provider: coreProvider, fields: [] }], { type: "Everything" });
		expect(ids()).toEqual(["core"]);
		expect(h.decls[0].fields).toEqual(["panoId"]);
	});

	it("lets the caller override the config the procedure declares", async () => {
		const withConfig: Provider = {
			...coreProvider,
			procedure: { ...coreProvider.procedure, config: { radius: 50 } },
		};
		await runProviders([{ provider: withConfig, config: { radius: 999 } }], { type: "Everything" });
		expect(h.decls[0].config).toBe(JSON.stringify({ radius: 999 }));

		h.decls = [];
		await runProviders([{ provider: withConfig }], { type: "Everything" });
		expect(h.decls[0].config).toBe(JSON.stringify({ radius: 50 }));
	});

	it("reports a success count and the failed ids", async () => {
		h.total = 10;
		h.failed = 3;
		h.failedIds = { prov: [4, 8, 9] };
		const result = await runProviders([{ provider: plainProvider }], { type: "Everything" });
		expect(result.prov).toMatchObject({ succeeded: 7, failed: [4, 8, 9] });
	});
});

describe("the implicit provider set", () => {
	it("holds every field-producing provider and no core-column one", () => {
		const set = enrichRuns(null).map((r) => r.provider.id);
		expect(set).toEqual(expect.arrayContaining(["svMeta", "exactDate", "timezone", "subdivision"]));
		expect(set).not.toContain("panoResolve");
		expect(set).not.toContain("pinPano");
		expect(set).not.toContain("headingRoad");
	});

	it("enrichAll resolves pano ids first, then every active field provider", async () => {
		// The default field set is the opt-out one, so only the metadata pass joins.
		await enrichAll({ type: "Everything" });
		expect(ids()).toEqual(["panoResolve", "svMeta"]);

		h.decls = [];
		h.enrichFields = ["imageDate", "datetime", "timezone", "subdivision"];
		await enrichAll({ type: "Everything" });
		expect(ids()[0]).toBe("panoResolve");
		expect(ids()).toEqual(
			expect.arrayContaining(["svMeta", "exactDate", "timezone", "subdivision"]),
		);
		expect(ids()).not.toContain("pinPano");
		expect(ids()).not.toContain("headingRoad");
	});

	it("enrichAll resolves a pano only for a row still lacking a wanted field", async () => {
		await enrichAll({ type: "Everything" });
		expect(h.decls[0].id).toBe("panoResolve");
		expect(h.decls[0].select.type).toBe("Intersection");
		const json = JSON.stringify(h.decls[0].select);
		for (const key of getDefaultEnrichKeys()) expect(json).toContain(`"${key}"`);
		expect(json).toContain('"nothas"');
	});

	it("a forced enrichAll re-derives fields but never re-resolves a stored pano", async () => {
		await enrichAll({ type: "Everything" }, { force: true });
		expect(h.decls[0].id).toBe("panoResolve");
		expect(h.decls[0].force).toBe(false);
		expect(h.decls[0].select).toEqual({ type: "Everything" });
	});

	it("the single-location path runs no core-column provider", async () => {
		await runProviders(enrichRuns(null, ["svMeta"]), {
			type: "Locations",
			locations: [42],
			name: null,
		});
		expect(ids()).not.toContain("panoResolve");
		expect(ids()).not.toContain("pinPano");
		expect(ids()).not.toContain("svMeta");
		for (const d of h.decls)
			expect(d.select).toEqual({ type: "Locations", locations: [42], name: null });
	});
});

describe("the bulk operations name their own providers", () => {
	it("bulkPinToPano runs panoResolve then pinPano, with the useLatest config", async () => {
		const out = await bulkPinToPano({ type: "Everything" }, { useLatest: true, force: true });
		expect(ids()).toEqual(["panoResolve", "pinPano"]);
		const pin = h.decls[1];
		expect(pin.config).toBe(JSON.stringify({ useLatest: true }));
		// Forced, so the run is not narrowed away from the caller's selector.
		expect(pin.select).toEqual({ type: "Everything" });
		expect(out.succeeded).toBe(5);
	});

	it("without force pinPano only sees rows that are not already pinned", async () => {
		await bulkPinToPano({ type: "Everything" });
		const pin = h.decls[1];
		expect(pin.select.type).toBe("Intersection");
		expect(JSON.stringify(pin.select)).toContain('"NotPanoIds"');
	});

	it("a row the forced re-resolve fails is excluded from the pin wave", async () => {
		h.failedIds = { panoResolve: [3, 9] };
		const out = await bulkPinToPano({ type: "Everything" }, { force: true });
		const pin = h.decls[1];
		expect(pin.id).toBe("pinPano");
		expect(pin.select.type).toBe("Intersection");
		const json = JSON.stringify(pin.select);
		expect(json).toContain('"Invert"');
		expect(json).toContain("[3,9]");
		expect(out.failed).toEqual([3, 9]);
	});

	it("bulkPanHeading runs panoResolve then headingRoad, with the direction", async () => {
		const out = await bulkPanHeading({ type: "Everything" }, "backwards");
		expect(ids()).toEqual(["panoResolve", "headingRoad"]);
		expect(h.decls[1].config).toBe(JSON.stringify({ direction: "backwards" }));
		expect(out.succeeded).toBe(5);
	});

	it("panoResolve declares panoId, so the engine schedules it before its consumers", () => {
		expect(panoResolveProvider.provides).toEqual(["panoId"]);
		expect(panoResolveProvider.fieldDefs).toBeUndefined();
		expect(panoResolveProvider.procedure.entry).toBe("res://procedures/panoResolve.js");
	});
});

describe("the query surface", () => {
	it("carries JSON both ways and only sends a config when one is given", async () => {
		h.queryAnswer = () => Promise.resolve('{"ok":true}');
		expect(await queryProcedure("res://q.js", { op: "label" })).toEqual({ ok: true });
		expect(h.queries).toEqual([
			{ entry: "res://q.js", input: '{"op":"label"}', cancel: expect.any(Number) as number },
		]);
	});

	it("names a query it can cancel, cancels it on abort, and rejects with the reason", async () => {
		const ac = new AbortController();
		let answer = () => {};
		h.queryAnswer = () => new Promise<string>((resolve) => (answer = () => resolve("[]")));
		const pending = queryProcedure("res://q.js", { op: "at" }, undefined, ac.signal);
		await Promise.resolve();
		const token = h.queries[0].cancel;
		expect(token).not.toBeNull();
		ac.abort();
		expect(h.cancelled).toEqual([token]);
		answer();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("a call without a signal is still named, and nothing cancels it", async () => {
		h.queryAnswer = () => Promise.resolve("[]");
		await queryProcedure("res://q.js", { op: "at" });
		expect(h.queries[0].cancel).toEqual(expect.any(Number));
		expect(h.cancelled).toEqual([]);
	});

	it("asks the field's provider for display labels", async () => {
		registerProvider({
			id: "labelled",
			procedure: { entry: "res://procedures/labelled.js", batch: { mode: "perRow" } },
			fieldDefs: {
				labelledField: { type: "string", label: "L", values: null, labels: null, comparison: null },
			},
		});
		h.queryAnswer = () => Promise.resolve('["\u00a9 2019","\u00a9 2022"]');

		expect(await resolveFieldLabels("labelledField", ["2019", "2022"])).toEqual([
			"\u00a9 2019",
			"\u00a9 2022",
		]);
		expect(JSON.parse(h.queries[0].input)).toEqual({
			op: "label",
			field: "labelledField",
			values: ["2019", "2022"],
		});
	});

	it("keeps the raw keys when the module has no query, throws, or answers wrong", async () => {
		// No provider owns this field at all.
		expect(await resolveFieldLabels("unowned", ["a"])).toEqual(["a"]);
		expect(h.queries).toEqual([]);

		h.queryAnswer = () => Promise.reject(new Error("module exports no `query`"));
		expect(await resolveFieldLabels("labelledField", ["a", "b"])).toEqual(["a", "b"]);

		h.queryAnswer = () => Promise.resolve('["only one"]');
		expect(await resolveFieldLabels("labelledField", ["a", "b"])).toEqual(["a", "b"]);

		h.queryAnswer = () => Promise.resolve('{"error":"nope"}');
		expect(await resolveFieldLabels("labelledField", ["a"])).toEqual(["a"]);
	});

	it("never queries for an empty key set", async () => {
		expect(await resolveFieldLabels("labelledField", [])).toEqual([]);
		expect(h.queries).toEqual([]);
	});

	it("has no per-row transform hook: display formatting is a module query", () => {
		const provider: Provider = {
			id: "no-transform",
			procedure: { entry: "res://procedures/x.js", batch: { mode: "perRow" } },
			// @ts-expect-error Provider.transform was deleted in favour of `query`.
			transform: () => null,
		};
		expect(provider.id).toBe("no-transform");
	});
});

// --- Progress ---------------------------------------------------------------------
// The bar reports rows finished through every provider in the run: skipped rows leave
// both sides of the fraction, and the slowest provider's count is the bar.

const provA: Provider = {
	id: "provA",
	label: "Prov A",
	provides: ["panoId"],
	procedure: { entry: "res://a.js", batch: { mode: "perRow" } },
};

const provB: Provider = {
	id: "provB",
	label: "Prov B",
	requires: ["panoId"],
	provides: ["heading"],
	procedure: { entry: "res://b.js", batch: { mode: "perRow" } },
};

type Tick = [number, number];

/** Run `providers` against a scripted engine event stream, collecting every `onProgress`. */
async function ticks(providers: Provider[], script: Omit<ProcedureProgress, "runId">[]) {
	h.script = script;
	const seen: Tick[] = [];
	await runProviders(
		providers.map((provider) => ({ provider })),
		{ type: "Everything" },
		{ onProgress: (done, total) => seen.push([done, total]) },
	);
	return seen;
}

const step = (
	providerId: string,
	done: number,
	total: number,
	rest: Partial<ProcedureProgress> = {},
): Omit<ProcedureProgress, "runId"> => ({
	providerId,
	done,
	total,
	failed: 0,
	skipped: 0,
	finished: false,
	...rest,
});

describe("the progress bar counts real work", () => {
	it("drops skipped rows from both sides of the fraction", async () => {
		expect(
			await ticks(
				[provA],
				[
					step("provA", 4, 10, { skipped: 4 }),
					step("provA", 7, 10, { skipped: 4 }),
					step("provA", 10, 10, { skipped: 4, finished: true }),
				],
			),
		).toEqual([
			[0, 6],
			[3, 6],
			[6, 6],
		]);
	});

	it("shrinks the denominator as later pages discover more skipped rows", async () => {
		const seen = await ticks(
			[provA],
			[
				step("provA", 2, 100, { skipped: 0 }),
				step("provA", 40, 100, { skipped: 30 }),
				step("provA", 100, 100, { skipped: 80, finished: true }),
			],
		);
		expect(seen.map(([, total]) => total)).toEqual([100, 70, 20]);
		expect(seen.map(([done]) => done)).toEqual([2, 10, 20]);
	});

	it("reports no work at all when every row is skipped", async () => {
		expect(await ticks([provA], [step("provA", 10, 10, { skipped: 10, finished: true })])).toEqual([
			[0, 0],
		]);
	});

	it("never reports a run it was not asked to make", async () => {
		const seen: Tick[] = [];
		// Every field of the only provider was deselected, so no provider ever starts.
		const result = await runProviders(
			[{ provider: plainProvider, fields: [] }],
			{ type: "Everything" },
			{ onProgress: (done, total) => seen.push([done, total]) },
		);
		expect(seen).toEqual([]);
		expect(result).toEqual({});
	});
});

describe("the progress bar is rows finished through every provider", () => {
	it("stays on the slowest provider, so it is monotonic across the whole run", async () => {
		expect(
			await ticks(
				[provA, provB],
				[
					step("provA", 5, 10),
					step("provA", 10, 10, { finished: true }),
					step("provB", 3, 10),
					step("provB", 10, 10, { finished: true }),
				],
			),
		).toEqual([
			// provB has not started, so nothing is finished through every provider yet.
			[0, 10],
			[0, 10],
			[3, 10],
			[10, 10],
		]);
	});

	it("combines concurrent providers as min over one row universe, never a sum", async () => {
		expect(
			await ticks(
				[provA, { ...provB, requires: [], provides: ["heading"] }],
				[
					step("provA", 2, 10),
					step("provB", 1, 10),
					step("provA", 10, 10, { finished: true }),
					step("provB", 5, 10),
					step("provB", 10, 10, { finished: true }),
				],
			),
		).toEqual([
			[0, 10],
			[1, 10],
			[1, 10],
			[5, 10],
			[10, 10],
		]);
	});

	it("hands every labeled provider's own counts to the caller, zeros before it starts", async () => {
		h.script = [
			step("provA", 2, 10),
			step("provB", 1, 10, { failed: 1 }),
			step("provA", 10, 10, { finished: true }),
			step("provB", 10, 10, { failed: 1, finished: true }),
		];
		const parts: ProviderPart[][] = [];
		await runProviders(
			[provA, { ...provB, requires: [], provides: ["heading"] }].map((provider) => ({ provider })),
			{ type: "Everything" },
			{ onProgress: (_d, _t, p) => parts.push(p) },
		);
		expect(parts[0]).toEqual([
			{ label: "Prov A", done: 2, total: 10, failed: 0, finished: false },
			{ label: "Prov B", done: 0, total: 0, failed: 0, finished: false },
		]);
		expect(parts[1]).toEqual([
			{ label: "Prov A", done: 2, total: 10, failed: 0, finished: false },
			{ label: "Prov B", done: 1, total: 10, failed: 1, finished: false },
		]);
		expect(parts[2]).toEqual([
			{ label: "Prov A", done: 10, total: 10, failed: 0, finished: true },
			{ label: "Prov B", done: 1, total: 10, failed: 1, finished: false },
		]);
	});

	it("tracks only itself on a single-provider run", async () => {
		expect(
			await ticks([provA], [step("provA", 3, 8), step("provA", 8, 8, { finished: true })]),
		).toEqual([
			[3, 8],
			[8, 8],
		]);
	});

	it("a provider that skipped everything does not pin the bar at zero", async () => {
		expect(
			await ticks(
				[provA, { ...provB, requires: [], provides: ["heading"] }],
				[
					step("provA", 10, 10, { skipped: 10, finished: true }),
					step("provB", 4, 10),
					step("provB", 10, 10, { finished: true }),
				],
			),
		).toEqual([
			[0, 0],
			[4, 10],
			[10, 10],
		]);
	});

	it("keeps success counts on raw engine totals, not the bar's net ones", async () => {
		h.script = [step("provA", 10, 10, { failed: 3, skipped: 2, finished: true })];
		const result = await runProviders([{ provider: provA }], { type: "Everything" });
		expect(result.provA).toMatchObject({ succeeded: 5 });
	});
});

describe("runProviders over rows handed in", () => {
	it("runs in the engine under stand-in ids and answers the rows under their own", async () => {
		h.decls = [];
		h.rowRuns = [];
		const rows = [
			{ ...createLocation({ lat: 1, lng: 2 }), id: -3, extra: { keep: 1 } },
			{ ...createLocation({ lat: 3, lng: 4 }), id: 42 },
		];
		const out = await runProviders([{ provider: svMetaProvider }], rows);
		expect(h.rowRuns).toEqual([
			{ ids: [1, 2], force: false, cancel: expect.any(Number) as number },
		]);
		expect(h.decls.map((d) => d.select)).toEqual([{ type: "Everything" }]);
		expect(out.rows.map((r) => r.id)).toEqual([-3, 42]);
		expect(out.rows[0].extra).toEqual({ keep: 1, ran: true });
		expect(out.failed).toEqual({ svMeta: [-3] });
	});

	it("names the run for cancellation when the caller hands it a signal", async () => {
		h.rowRuns = [];
		const ac = new AbortController();
		await runProviders([{ provider: svMetaProvider }], [createLocation({ lat: 1, lng: 2 })], {
			signal: ac.signal,
		});
		expect(h.rowRuns[0].cancel).not.toBeNull();
	});
});
