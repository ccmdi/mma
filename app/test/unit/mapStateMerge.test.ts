import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the applyMutation contract: a MutationResult is a JSON merge patch onto
// MapState — present fields are set, null fields were unchanged and must be
// skipped so untouched slices keep their reference (the render gate for
// useMapState selectors is reference identity).

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
	delta: { added: [], updated: [], removed: [], fullReset: false },
	selectionSync: null,
	newFieldDefs: null,
	tags: null,
	version: 0,
	locationCount: 3,
	canUndo: true,
	canRedo: false,
	tagCounts: null,
	knownFieldKeys: [],
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

	it("scalars always track the result", async () => {
		await mutate(() =>
			Promise.resolve(result({ locationCount: 42, canUndo: true, canRedo: true })),
		);
		const s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.canUndo).toBe(true);
		expect(s.canRedo).toBe(true);
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

	// knownFieldKeys is a wholesale mirror of the status snapshot: Rust registers a
	// mutation's new keys before it snapshots, and forgets erased ones, so JS never unions.
	it("knownFieldKeys mirrors the status snapshot", async () => {
		expect([...getMapState().knownFieldKeys]).toEqual(["alt"]);
		await mutate(() =>
			Promise.resolve(
				result({ knownFieldKeys: ["alt", "foo"], newFieldDefs: { foo: { type: "string" } } }),
			),
		);
		expect([...getMapState().knownFieldKeys].sort()).toEqual(["alt", "foo"]);

		// A snapshot that no longer lists a key drops it from the mirror.
		await mutate(() => Promise.resolve(result({ knownFieldKeys: ["foo"] })));
		expect([...getMapState().knownFieldKeys]).toEqual(["foo"]);
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
