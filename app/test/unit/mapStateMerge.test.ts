import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the applyMutation contract: a MutationResult carries only what moved. A present
// field replaces its slice; a null field was untouched and must keep its reference (the
// render gate for useMapState selectors is reference identity).

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	return cmdProxy({
		storeGetMap: async () =>
			testMap({
				locationCount: 2,
				tags: { 1: { id: 1, name: "red", color: "#ff0000", visible: true } },
			}),
		storeOpenMap: async () => openMapResult({ tagCounts: { 1: 2 }, knownFieldKeys: ["alt"] }),
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { openMap, mutate, getMapState } from "@/store/useMapStore";
import type { MutationResult, Tag } from "@/bindings.gen";

const result = (over: Partial<MutationResult> = {}): MutationResult => ({
	version: 0,
	delta: { added: [], updated: [], removed: [], fullReset: false },
	selectionSync: null,
	locationCount: null,
	canUndo: null,
	canRedo: null,
	tagCounts: null,
	tags: null,
	knownFieldKeys: null,
	newFieldDefs: null,
	...over,
});

beforeEach(async () => {
	await openMap("m1");
});

describe("applyMutation merge semantics", () => {
	it("null fields are skipped: untouched slices keep their reference", async () => {
		const before = getMapState();
		await mutate(() => Promise.resolve(result()));
		const after = getMapState();
		expect(after.tagCounts).toBe(before.tagCounts);
		expect(after.tags).toBe(before.tags);
		expect(after.map).toBe(before.map);
	});

	it("present scalars replace, absent ones hold", async () => {
		await mutate(() =>
			Promise.resolve(result({ locationCount: 42, canUndo: true, canRedo: true })),
		);
		let s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.canUndo).toBe(true);
		expect(s.canRedo).toBe(true);
		await mutate(() => Promise.resolve(result({ canRedo: false })));
		s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.canUndo).toBe(true);
		expect(s.canRedo).toBe(false);
	});

	it("present fields replace their slice; a tag change never re-mints the map", async () => {
		const tags: Record<number, Tag> = {
			1: { id: 1, name: "red", color: "#ff0000", visible: true },
			2: { id: 2, name: "blue", color: "#0000ff", visible: true },
		};
		const mapBefore = getMapState().map;
		await mutate(() => Promise.resolve(result({ tags, tagCounts: { 1: 5, 2: 0 } })));
		const s = getMapState();
		expect(s.tags).toBe(tags);
		expect(s.tagCounts).toEqual({ 1: 5, 2: 0 });
		expect(s.map).toBe(mapBefore);
	});

	// knownFieldKeys ships whole when it changed, and holds its reference when it didn't.
	it("knownFieldKeys replaces when present and holds when absent", async () => {
		expect([...getMapState().knownFieldKeys]).toEqual(["alt"]);
		await mutate(() =>
			Promise.resolve(
				result({ knownFieldKeys: ["alt", "foo"], newFieldDefs: { foo: { type: "string" } } }),
			),
		);
		expect([...getMapState().knownFieldKeys].sort()).toEqual(["alt", "foo"]);

		await mutate(() => Promise.resolve(result({ knownFieldKeys: ["foo"] })));
		expect([...getMapState().knownFieldKeys]).toEqual(["foo"]);

		const held = getMapState().knownFieldKeys;
		await mutate(() => Promise.resolve(result()));
		expect(getMapState().knownFieldKeys).toBe(held);
	});

	it("selectionSync refreshes selectionCounts", async () => {
		await mutate(() =>
			Promise.resolve(
				result({ selectionSync: { counts: { "tag:1": 7 }, bitmask: null, selectedCount: 7 } }),
			),
		);
		expect(getMapState().selectionCounts).toEqual({ "tag:1": 7 });
	});
});
