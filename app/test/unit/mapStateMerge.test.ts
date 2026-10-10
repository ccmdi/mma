import { createFieldDef } from "@/types";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the change-feed contract: an event carries only what moved. A present value
// replaces its slice; a null value was untouched and must keep its reference (the
// render gate for useMapState selectors is reference identity).

const feed = vi.hoisted(() => ({
	onmessage: null as ((e: unknown) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	return cmdProxy({
		storeGetMap: async () =>
			testMap({
				locationCount: 2,
				tags: { 1: { id: 1, name: "red", color: "#ff0000", visible: true } },
				extra: { fields: { alt: createFieldDef("number") } },
			}),
		storeOpenMap: async () =>
			openMapResult({ tagCounts: { 1: 2 }, fieldDefs: { alt: createFieldDef("number") } }),
		storeSubscribeChanges: async (...args: unknown[]) => {
			feed.onmessage = (args[0] as { onmessage: (e: unknown) => void }).onmessage;
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { openMap, getMapState, getTags, getTagCounts, settled } from "@/store/useMapStore";
import { getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import type { ChangeEvent } from "@/bindings.gen";
const event = (derived: Partial<ChangeEvent["derived"]> = {}): ChangeEvent => ({
	version: 0,
	added: [],
	removed: [],
	updated: [],
	derived: {
		locationCount: null,
		meta: null,
		history: null,
		fieldValues: null,
		fieldDefs: null,
		selectionCounts: null,
		selectionList: null,
		...derived,
	},
});

const arrive = (e: ChangeEvent) => feed.onmessage!(e);

beforeEach(async () => {
	await openMap("m1");
});

describe("change feed merge semantics", () => {
	it("metadata arrives through the feed and preserves untouched map fields", () => {
		const before = getMapState().map!;
		arrive(event({ meta: { id: before.id, name: "Renamed" } }));
		expect(getMapState().map).toEqual({ ...before, name: "Renamed" });
		expect(getMapState().map!.settings).toBe(before.settings);
		const updated = getMapState().map;
		arrive(event());
		expect(getMapState().map).toBe(updated);
	});

	it("null values are skipped: untouched slices keep their reference", () => {
		const before = getMapState();
		const tagsBefore = getTags();
		const countsBefore = getTagCounts();
		arrive(event());
		expect(getTagCounts()).toBe(countsBefore);
		expect(getTags()).toBe(tagsBefore);
		expect(getMapState().map).toBe(before.map);
	});

	it("present scalars replace, absent ones hold", () => {
		arrive(event({ locationCount: 42, history: { rows: { undo: true, redo: true } } }));
		let s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.history).toEqual({ rows: { undo: true, redo: true } });
		arrive(event({ history: { rows: { undo: true, redo: false } } }));
		s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.history).toEqual({ rows: { undo: true, redo: false } });
	});

	it("present values replace their slice; a tag change never re-mints the map", () => {
		const mapBefore = getMapState().map;
		arrive(
			event({
				fieldValues: {
					tags: {
						1: { record: { name: "red", color: "#ff0000" }, count: 5 },
						2: { record: { name: "blue", color: "#0000ff" }, count: 0 },
					},
				},
			}),
		);
		expect(getTags()[1]).toMatchObject({ id: 1, name: "red", color: "#ff0000", visible: true });
		expect(getTags()[2].visible).toBe(false);
		expect(getTagCounts()).toEqual({ 1: 5, 2: 0 });
		expect(getMapState().map).toBe(mapBefore);
	});

	it("field values merge per value: a present one replaces itself, a null one is gone", () => {
		arrive(
			event({
				fieldValues: {
					tags: {
						1: { record: { name: "red" }, count: 1 },
						2: { record: { name: "blue" }, count: 1 },
					},
				},
			}),
		);
		arrive(event({ fieldValues: { tags: { 1: { record: { name: "red" }, count: 3 }, 2: null } } }));
		expect(getTagCounts()).toEqual({ 1: 3 });
		expect(getTags()[2]).toBeUndefined();
	});

	it("a counted value without a record shows under a derived name", () => {
		arrive(event({ fieldValues: { tags: { 9: { record: null, count: 2 } } } }));
		expect(getTags()[9]).toMatchObject({ id: 9, name: "Tag 9", visible: true });
	});

	// The field registry ships whole when it changed; the known-key set is its key set
	// and holds its reference when nothing arrived.
	it("fieldDefs replace the registry when present and hold when absent", () => {
		expect([...getKnownFieldKeys()]).toEqual(["alt"]);
		arrive(event({ fieldDefs: { alt: createFieldDef("number"), foo: createFieldDef("string") } }));
		expect([...getKnownFieldKeys()].sort()).toEqual(["alt", "foo"]);

		arrive(event({ fieldDefs: { foo: createFieldDef("string") } }));
		expect([...getKnownFieldKeys()]).toEqual(["foo"]);

		const held = getKnownFieldKeys();
		arrive(event());
		expect(getKnownFieldKeys()).toBe(held);
	});

	it("selectionCounts replace when present", () => {
		arrive(event({ selectionCounts: { "tag:1": 7 } }));
		expect(getMapState().selectionCounts).toEqual({ "tag:1": 7 });
	});

	it("the store's selection list replaces the listed selections when present", () => {
		const row = {
			selection: {
				key: "tag:1",
				color: [1, 2, 3] as [number, number, number],
				selector: {
					type: "Filter" as const,
					field: "tags",
					test: { op: "contains" as const, value: 1 },
				},
			},
			ghosted: false,
		};
		arrive(event({ selectionList: [row] }));
		expect(getMapState().selectionList).toEqual([row]);
		const held = getMapState().selectionList;
		arrive(event());
		expect(getMapState().selectionList).toBe(held);
	});

	it("a write the open already covers settles without waiting for the feed", async () => {
		const outcome = await Promise.race([
			settled({ version: 1, added: [] }).then(() => "settled"),
			new Promise((r) => setTimeout(() => r("waiting"), 50)),
		]);
		expect(outcome).toBe("settled");
	});
});
