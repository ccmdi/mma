// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import type { ProcedureActivity, ProviderActivity, QueryActivity } from "@/bindings.gen";
import { procedureName } from "@/lib/data/procedures";
import { engineRows } from "@/lib/diagnostics";

function provider(over: Partial<ProviderActivity> = {}): ProviderActivity {
	return {
		runId: 1,
		providerId: "svMeta",
		label: null,
		total: 100,
		done: 25,
		failed: 0,
		skipped: 0,
		instances: 4,
		inflight: 8,
		inflightLimit: 48,
		rateWaiting: 0,
		retries: 0,
		...over,
	};
}

function activity(over: Partial<ProcedureActivity> = {}): ProcedureActivity {
	return { runs: [], queries: [], requestsPerSecond: 0, ...over };
}

describe("procedureName", () => {
	it("is the inverse of a bundled entry point", () => {
		expect(procedureName("res://procedures/svMeta.js")).toBe("svMeta");
	});

	it("leaves a plugin's own path recognisable", () => {
		expect(procedureName("C:/plugins/foo/bar.js")).toBe("C:/plugins/foo/bar");
	});
});

describe("engineRows", () => {
	it("reads as idle with nothing running", () => {
		expect(engineRows(activity()).idle).toBe(true);
		expect(engineRows(null).idle).toBe(true);
	});

	it("falls back to the provider id when it has no label", () => {
		const [row] = engineRows(activity({ runs: [provider()] })).providers;
		expect(row.label).toBe("svMeta");
		expect(row.fraction).toBe(0.25);
	});

	it("prefers the label where the provider has one", () => {
		const [row] = engineRows(activity({ runs: [provider({ label: "Metadata" })] })).providers;
		expect(row.label).toBe("Metadata");
	});

	it("keys a row by its run and provider, so two runs of one provider stay apart", () => {
		const rows = engineRows(
			activity({ runs: [provider({ runId: 1 }), provider({ runId: 2 })] }),
		).providers;
		expect(rows.map((r) => r.key)).toEqual(["1:svMeta", "2:svMeta"]);
	});

	it("keeps a provider with no rows off the bar rather than dividing by zero", () => {
		const [row] = engineRows(activity({ runs: [provider({ total: 0, done: 0 })] })).providers;
		expect(row.fraction).toBe(0);
	});

	it("shortens a query entry to the procedure's name", () => {
		const query: QueryActivity = {
			entry: "res://procedures/timezone.js",
			inflight: 3,
			inflightLimit: 48,
		};
		const rows = engineRows(activity({ queries: [query] }));
		expect(rows.queries).toEqual([{ entry: "timezone", inflight: 3, inflightLimit: 48 }]);
		expect(rows.idle).toBe(false);
	});

	it("carries the engine-wide request rate through", () => {
		expect(engineRows(activity({ requestsPerSecond: 12.5 })).requestsPerSecond).toBe(12.5);
	});
});
