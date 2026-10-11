import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { Editor } from "@/store/editor";
import { Query } from "@/store/query";
import type { Answer, Ask, Location, PartitionBucket, CountBy } from "@/bindings.gen";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy } = await import("./fixtures/mocks");
	return cmdProxy({ storeRead: h.read });
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
import { createLocation } from "@/types";

const selector = { type: "Everything" } as const;
beforeEach(() => h.read.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("read payloads", () => {
	it.each([
		{ name: "ids", ask: { kind: "ids" }, answer: { kind: "ids", ids: [2, 5] }, expected: [2, 5] },
		{ name: "count", ask: { kind: "count" }, answer: { kind: "count", count: 2 }, expected: 2 },
		{
			name: "columns",
			ask: { kind: "columns", fields: ["lat", "tags"] },
			answer: {
				kind: "columns",
				columns: [
					[1, 2],
					[[3], []],
				],
			},
			expected: [
				[1, 2],
				[[3], []],
			],
		},
		{
			name: "values",
			ask: { kind: "values", field: "countryCode" },
			answer: { kind: "values", values: ["FR", "JP"] },
			expected: ["FR", "JP"],
		},
		{
			name: "groupBy",
			ask: { kind: "groupBy", field: "countryCode", key: { kind: "value" } },
			answer: { kind: "groupBy", groups: [{ key: "FR", ids: [2, 5], bin: null }] },
			expected: [{ key: "FR", ids: [2, 5], bin: null }],
		},
		{
			name: "countBy",
			ask: { kind: "countBy", fields: ["tags"], key: { kind: "value" } },
			answer: { kind: "countBy", counts: [{ counts: [["3", 2]], covered: 2 }] },
			expected: [{ counts: [["3", 2]], covered: 2 }],
		},
		{
			name: "coverage",
			ask: { kind: "coverage" },
			answer: { kind: "coverage", coverage: [["lat", 2]] },
			expected: [["lat", 2]],
		},
		{
			name: "duplicateGroups",
			ask: { kind: "duplicateGroups", distance: 25 },
			answer: { kind: "duplicateGroups", groups: [[2, 5]] },
			expected: [[2, 5]],
		},
		{
			name: "nearAny",
			ask: { kind: "nearAny", lats: [0, 1], lngs: [0, 1], radiusM: 50 },
			answer: { kind: "nearAny", values: [true, false] },
			expected: [true, false],
		},
		{
			name: "bounds",
			ask: { kind: "bounds" },
			answer: { kind: "bounds", bounds: [-2, -1, 4, 3] },
			expected: [-2, -1, 4, 3],
		},
	] satisfies { name: string; ask: Ask; answer: Answer; expected: unknown }[])(
		"returns the $name answer payload",
		async ({ ask, answer, expected }) => {
			h.read.mockResolvedValue(answer);
			await expect(Query.read(selector, ask as Ask)).resolves.toEqual(expected);
		},
	);
	it("infers payloads from literal and union requests", async () => {
		h.read.mockResolvedValue({ kind: "count", count: 0 } satisfies Answer);
		const count = Query.read(selector, { kind: "count" });
		expectTypeOf(count).toEqualTypeOf<Promise<number>>();
		expect(await count).toBe(0);
		expectTypeOf<ReturnType<typeof Query.read<{ kind: "ids" }>>>().toEqualTypeOf<
			Promise<number[]>
		>();
		expectTypeOf<ReturnType<typeof Query.read<{ kind: "locations" }>>>().toEqualTypeOf<
			Promise<Location[]>
		>();
		expectTypeOf<ReturnType<typeof Query.read<Extract<Ask, { kind: "groupBy" }>>>>().toEqualTypeOf<
			Promise<PartitionBucket[]>
		>();
		expectTypeOf<ReturnType<typeof Query.read<Extract<Ask, { kind: "countBy" }>>>>().toEqualTypeOf<
			Promise<CountBy[]>
		>();
		expectTypeOf<ReturnType<typeof Query.read<Extract<Ask, { kind: "nearAny" }>>>>().toEqualTypeOf<
			Promise<boolean[]>
		>();
		// Keep the request statically a union while choosing a deterministic runtime branch.
		const ask = (): Extract<Ask, { kind: "count" | "bounds" }> => ({ kind: "bounds" });
		h.read.mockResolvedValue({ kind: "bounds", bounds: null });
		const union = Query.read(selector, ask());
		expectTypeOf(union).toEqualTypeOf<Promise<number | [number, number, number, number] | null>>();
		await expect(union).resolves.toBeNull();
	});

	it("preserves multiple payload fields and forwards the pending target", async () => {
		h.read.mockResolvedValue({ kind: "spacing", ids: [2, 8], spacingM: 75 } satisfies Answer);
		const picked = Query.read(selector, { kind: "spacing" }, Editor.layer(1));
		expectTypeOf(picked).toEqualTypeOf<Promise<{ ids: number[]; spacingM: number }>>();
		expect(await picked).toEqual({ ids: [2, 8], spacingM: 75 });
		expect(h.read).toHaveBeenCalledWith(Editor.layer(1), selector, { kind: "spacing" });
	});

	it("loads inline and file-backed rows through the same public read", async () => {
		const rows = [createLocation({ lat: 1, lng: 2 })];
		h.read.mockResolvedValue({
			kind: "locations",
			locations: { kind: "inline", locations: rows },
		} satisfies Answer);
		expect(await Query.read(selector, { kind: "locations" })).toEqual(rows);
		const fetch = vi.fn(async () => ({ json: async () => rows }));
		vi.stubGlobal("fetch", fetch);
		h.read.mockResolvedValue({
			kind: "locations",
			locations: { kind: "file", path: "read-test.json" },
		} satisfies Answer);
		expect(await Query.read(selector, { kind: "locations" })).toEqual(rows);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("rejects a mismatched answer rather than returning the wrong payload", async () => {
		h.read.mockResolvedValue({ kind: "ids", ids: [] } satisfies Answer);
		await expect(Query.read(selector, { kind: "count" })).rejects.toThrow(
			"read answered ids, expected count",
		);
	});
});
