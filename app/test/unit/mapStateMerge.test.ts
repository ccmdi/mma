import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the applyMutation contract: a MutationResult is a JSON merge patch onto
// MapState — present fields are set, null fields were unchanged and must be
// skipped so untouched slices keep their reference (the render gate for
// useMapState selectors is reference identity).

vi.mock("@/lib/commands", () => {
	const map = {
		id: "m1",
		meta: {
			id: "m1",
			name: "test",
			description: "",
			folder: null,
			locationCount: 2,
			tags: { 1: { id: 1, name: "red", color: "#ff0000", visible: true } },
			settings: {},
			scoreBounds: null,
			createdAt: "",
			updatedAt: "",
			extra: null,
		},
	};
	const handlers: Record<string, (...args: unknown[]) => unknown> = {
		storeGetMap: async () => map,
		storeOpenMap: async () => ({
			tagCounts: { 1: 2 },
			canUndo: false,
			canRedo: false,
			knownFieldKeys: ["alt"],
		}),
	};
	return {
		cmd: new Proxy({}, { get: (_t, name: string) => handlers[name] ?? (async () => null) }),
	};
});
vi.mock("@/lib/util/log", () => ({
	log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
	fireAndForget: (p: Promise<unknown> | undefined) => void p?.catch(() => {}),
}));

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

	// knownFieldKeys is a wholesale mirror of the status snapshot (Rust forgets erased
	// keys), extended by the same mutation's newFieldDefs (registered after the snapshot).
	it("knownFieldKeys mirrors the status snapshot plus newFieldDefs", async () => {
		expect([...getMapState().knownFieldKeys]).toEqual(["alt"]);
		await mutate(() =>
			Promise.resolve(
				result({ knownFieldKeys: ["alt"], newFieldDefs: { foo: { type: "string" } } }),
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
