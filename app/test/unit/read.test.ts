import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Answer, Ask, Location, PartitionBucket, CountBy } from "@/bindings.gen";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy } = await import("./fixtures/mocks");
	return cmdProxy({ storeRead: h.read });
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { read, VIEWER } from "@/store/useMapStore";
import { createLocation } from "@/types";

const selector = { type: "Everything" } as const;
beforeEach(() => h.read.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("read payloads", () => {
	it("infers payloads from literal and union requests", async () => {
		h.read.mockResolvedValue({ kind: "count", count: 0 } satisfies Answer);
		const count = read(selector, { kind: "count" });
		expectTypeOf(count).toEqualTypeOf<Promise<number>>();
		expect(await count).toBe(0);
		expectTypeOf<ReturnType<typeof read<{ kind: "ids" }>>>().toEqualTypeOf<Promise<number[]>>();
		expectTypeOf<ReturnType<typeof read<{ kind: "rows" }>>>().toEqualTypeOf<Promise<Location[]>>();
		expectTypeOf<ReturnType<typeof read<Extract<Ask, { kind: "groupBy" }>>>>().toEqualTypeOf<
			Promise<PartitionBucket[]>
		>();
		expectTypeOf<ReturnType<typeof read<Extract<Ask, { kind: "countBy" }>>>>().toEqualTypeOf<
			Promise<CountBy[]>
		>();
		expectTypeOf<ReturnType<typeof read<Extract<Ask, { kind: "nearAny" }>>>>().toEqualTypeOf<
			Promise<boolean[]>
		>();
		const ask: Extract<Ask, { kind: "count" | "bounds" }> =
			Math.random() > 0.5 ? { kind: "count" } : { kind: "bounds" };
		// Keep the request statically a union, while the mock answers its runtime branch.
		h.read.mockResolvedValue(
			ask.kind === "count" ? { kind: "count", count: 2 } : { kind: "bounds", bounds: null },
		);
		const union = read(selector, ask);
		expectTypeOf(union).toEqualTypeOf<Promise<number | [number, number, number, number] | null>>();
		await union;
	});

	it("preserves multiple payload fields and forwards the pending target", async () => {
		h.read.mockResolvedValue({ kind: "spacing", ids: [2, 8], spacingM: 75 } satisfies Answer);
		const picked = read(selector, { kind: "spacing" }, VIEWER);
		expectTypeOf(picked).toEqualTypeOf<Promise<{ ids: number[]; spacingM: number }>>();
		expect(await picked).toEqual({ ids: [2, 8], spacingM: 75 });
		expect(h.read).toHaveBeenCalledWith(VIEWER, selector, { kind: "spacing" });
	});

	it("loads inline and file-backed rows through the same public read", async () => {
		const rows = [createLocation({ lat: 1, lng: 2 })];
		h.read.mockResolvedValue({
			kind: "rows",
			rows: { kind: "inline", locations: rows },
		} satisfies Answer);
		expect(await read(selector, { kind: "rows" })).toEqual(rows);
		const fetch = vi.fn(async () => ({ json: async () => rows }));
		vi.stubGlobal("fetch", fetch);
		h.read.mockResolvedValue({
			kind: "rows",
			rows: { kind: "file", path: "read-test.json" },
		} satisfies Answer);
		expect(await read(selector, { kind: "rows" })).toEqual(rows);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("rejects a mismatched answer rather than returning the wrong payload", async () => {
		h.read.mockResolvedValue({ kind: "ids", ids: [] } satisfies Answer);
		await expect(read(selector, { kind: "count" })).rejects.toThrow(
			"read answered ids, expected count",
		);
	});
});
