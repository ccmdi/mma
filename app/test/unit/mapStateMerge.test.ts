import { createFieldDef } from "@/types";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the change-feed contract: an event carries only what moved. A present value
// replaces its slice; a null value was untouched and must keep its reference (the
// render gate for useMapState selectors is reference identity).

const feed = vi.hoisted(() => ({ onmessage: null as ((e: unknown) => void) | null }));

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

import { openMap, getMapState, getTags, getTagCounts } from "@/store/useMapStore";
import { getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import type { ChangeEvent } from "@/bindings.gen";
const event = (
	values: Partial<ChangeEvent["values"]> = {},
	over: Partial<ChangeEvent> = {},
): ChangeEvent => ({
	version: 0,
	added: [],
	removed: [],
	updated: [],
	selections: null,
	values: {
		locationCount: null,
		canUndo: null,
		canRedo: null,
		valueCounts: null,
		valueMeta: null,
		fieldDefs: null,
		...values,
	},
	...over,
});

const arrive = (e: ChangeEvent) => feed.onmessage!(e);

beforeEach(async () => {
	await openMap("m1");
});

describe("change feed merge semantics", () => {
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
		arrive(event({ locationCount: 42, canUndo: true, canRedo: true }));
		let s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.canUndo).toBe(true);
		expect(s.canRedo).toBe(true);
		arrive(event({ canRedo: false }));
		s = getMapState();
		expect(s.locationCount).toBe(42);
		expect(s.canUndo).toBe(true);
		expect(s.canRedo).toBe(false);
	});

	it("present values replace their slice; a tag change never re-mints the map", () => {
		const mapBefore = getMapState().map;
		arrive(
			event({
				valueMeta: {
					tags: { 1: { name: "red", color: "#ff0000" }, 2: { name: "blue", color: "#0000ff" } },
				},
				valueCounts: { tags: { 1: 5, 2: 0 } },
			}),
		);
		expect(getTags()[1]).toMatchObject({ id: 1, name: "red", color: "#ff0000", visible: true });
		expect(getTags()[2].visible).toBe(false);
		expect(getTagCounts()).toEqual({ 1: 5, 2: 0 });
		expect(getMapState().map).toBe(mapBefore);
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

	it("selections refresh selectionCounts", () => {
		arrive(event({}, { selections: { counts: { "tag:1": 7 }, selectedCount: 7 } }));
		expect(getMapState().selectionCounts).toEqual({ "tag:1": 7 });
	});
});
