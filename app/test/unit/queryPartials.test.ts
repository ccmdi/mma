import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	listens: 0,
	unlistened: 0,
	onResult: null as ((p: unknown) => void) | null,
	resolveQuery: null as ((raw: string) => void) | null,
	token: 0,
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/useMapStore", () => ({ holdAutosave: () => () => {} }));
vi.mock("@/lib/data/fieldDefs", () => ({
	derivedFrom: () => new Set<string>(),
	getProviderForField: () => undefined,
	getProviders: () => [],
}));
vi.mock("@/bindings.gen", () => ({
	events: {
		procedureResult: {
			listen: (cb: (e: { payload: unknown }) => void) => {
				h.listens++;
				h.onResult = (p) => cb({ payload: p });
				return Promise.resolve(() => h.unlistened++);
			},
		},
	},
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		procedureQuery: (_decl: unknown, _input: string, token: number) => {
			h.token = token;
			return new Promise<string>((resolve) => (h.resolveQuery = resolve));
		},
		procedureReserveRun: () => Promise.resolve(41),
		procedureCancel: () => Promise.resolve(null),
	},
}));

import { queryProcedure } from "@/lib/data/procedures";

const SPEC = { entry: "e.js" } as Parameters<typeof queryProcedure>[0];

async function flush(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("queryProcedure partials", () => {
	beforeEach(() => {
		h.listens = 0;
		h.unlistened = 0;
		h.onResult = null;
		h.resolveQuery = null;
	});

	it("hands pages to onPartial under its own token and unlistens after", async () => {
		const got: { id: number; value: unknown }[][] = [];
		const p = queryProcedure(SPEC, { op: "x" }, undefined, (entries) => got.push(entries));
		await flush();

		h.onResult!({
			runId: h.token,
			providerId: "e.js",
			entries: [{ id: 3, json: '{"state":"found"}' }],
			failed: [],
		});
		h.onResult!({
			runId: h.token + 999,
			providerId: "e.js",
			entries: [{ id: 9, json: "1" }],
			failed: [],
		});
		h.onResult!({ runId: h.token, providerId: "e.js", entries: [], failed: [] });
		h.resolveQuery!("[]");

		await expect(p).resolves.toEqual([]);
		expect(got).toEqual([[{ id: 3, value: { state: "found" } }]]);
		expect(h.unlistened).toBe(1);
	});

	it("never subscribes without an onPartial", async () => {
		const p = queryProcedure(SPEC, { op: "x" });
		await flush();
		h.resolveQuery!("[]");
		await p;
		expect(h.listens).toBe(0);
	});
});
