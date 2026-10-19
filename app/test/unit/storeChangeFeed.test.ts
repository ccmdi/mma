import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { Tag } from "@/store/tag";
import { Mutation } from "@/store/mutation";
import { Autosave } from "@/store/autosave";
import { Edit } from "@/store/edit";
import { createFieldDef } from "@/types";
import { subscribe } from "@/lib/events";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the change-feed contract: an event is a JSON Patch over the derived state the window
// holds. What it does not touch keeps its reference (the render gate for useMapState
// selectors is reference identity).

const feed = vi.hoisted(() => ({
	onmessage: null as ((e: unknown) => void) | null,
	duringOpen: null as unknown,
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy, openMapResult } = await import("./fixtures/mocks");
	return cmdProxy({
		storeOpenMap: async (...args: unknown[]) => {
			feed.onmessage = (args[1] as { onmessage: (e: unknown) => void }).onmessage;
			if (feed.duringOpen) feed.onmessage(feed.duringOpen);
			return openMapResult({ tagCounts: { 1: 2 }, fieldDefs: { alt: createFieldDef("number") } });
		},
		storeEdit: async () => ({ mutation: { version: 0, keys: [5] } }),
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
import { getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import type { ChangeEvent, MapMeta } from "@/bindings.gen";
import { SelectionList } from "@/store/selectionList";
import { add, changeEvent as event, remove, replace } from "./fixtures/patch";

const arrive = (e: ChangeEvent) => feed.onmessage!(e);

beforeEach(async () => {
	await Maps.open("m1");
});

describe("change feed patches", () => {
	it("metadata arrives as a complete row and replaces the map snapshot", () => {
		const before = Store.get().map!;
		const next = {
			...before,
			name: "Renamed",
			settings: { ...before.settings, searchRadius: 25 },
		} as MapMeta;
		arrive(event([replace("/map", next)]));
		expect(Store.get().map).toBe(next);
		expect(Store.get().map!.settings).toEqual({ ...before.settings, searchRadius: 25 });
		const updated = Store.get().map;
		arrive(event());
		expect(Store.get().map).toBe(updated);
	});

	it("untouched slices keep their reference", () => {
		const before = Store.get();
		const tagsBefore = Tag.all();
		const countsBefore = Tag.counts();
		arrive(event());
		expect(Tag.counts()).toBe(countsBefore);
		expect(Tag.all()).toBe(tagsBefore);
		expect(Store.get().map).toBe(before.map);
	});

	it("replaced scalars change, untouched ones hold", () => {
		arrive(
			event([
				replace("/locationCount", 42),
				replace("/history", { edits: { undo: true, redo: true } }),
			]),
		);
		let s = Store.get();
		expect(s.locationCount).toBe(42);
		expect(s.history).toEqual({ edits: { undo: true, redo: true } });
		arrive(event([replace("/history", { edits: { undo: true, redo: false } })]));
		s = Store.get();
		expect(s.locationCount).toBe(42);
		expect(s.history).toEqual({ edits: { undo: true, redo: false } });
	});

	it("added values replace their slot; a tag change never re-mints the map", () => {
		const mapBefore = Store.get().map;
		arrive(
			event([
				add("/fieldValues/tags/1", { record: { name: "red", color: "#ff0000" }, count: 5 }),
				add("/fieldValues/tags/2", { record: { name: "blue", color: "#0000ff" }, count: 0 }),
			]),
		);
		expect(Tag.all()[1]).toMatchObject({ id: 1, name: "red", color: "#ff0000", visible: true });
		expect(Tag.all()[2].visible).toBe(false);
		expect(Tag.counts()).toEqual({ 1: 5, 2: 0 });
		expect(Store.get().map).toBe(mapBefore);
	});

	it("a tag's doclinks are the strings its record holds", () => {
		arrive(
			event([
				add("/fieldValues/tags/3", {
					record: { name: "pole", doclinks: ["https://a", 7, null] },
					count: 1,
				}),
				add("/fieldValues/tags/4", { record: { name: "mast", doclinks: "https://b" }, count: 1 }),
			]),
		);
		expect(Tag.all()[3].doclinks).toEqual(["https://a"]);
		expect(Tag.all()[4].doclinks).toEqual([]);
	});

	it("field values move one at a time: an added one replaces itself, a removed one is gone", () => {
		arrive(
			event([
				add("/fieldValues/tags/1", { record: { name: "red" }, count: 1 }),
				add("/fieldValues/tags/2", { record: { name: "blue" }, count: 1 }),
			]),
		);
		arrive(
			event([
				add("/fieldValues/tags/1", { record: { name: "red" }, count: 3 }),
				remove("/fieldValues/tags/2"),
			]),
		);
		expect(Tag.counts()).toEqual({ 1: 3 });
		expect(Tag.all()[2]).toBeUndefined();
	});

	it("keeps dark tag metadata addressable but out of the visible set", () => {
		arrive(
			event([
				add("/fieldValues/tags/4", { record: { name: "Paris", color: "#f00" }, count: 1 }),
				add("/fieldValues/tags/9", { record: { name: "Empty", color: "#00f" }, count: 0 }),
			]),
		);

		expect(
			Tag.visible()
				.map((tag) => tag.id)
				.sort((a, b) => a - b),
		).toEqual([1, 4]);
		expect(Tag.get(9)).toMatchObject({ name: "Empty", visible: false });
		expect(Tag.names([9, 404])).toEqual(["Empty"]);
	});

	it("a counted value without a record is not a tag", () => {
		arrive(event([add("/fieldValues/tags/9", { record: null, count: 2 })]));
		expect(Tag.all()[9]).toBeUndefined();
	});

	// The field registry ships whole when it changed; the known-key set is its key set
	// and holds its reference when nothing arrived.
	it("fieldDefs replace the registry when patched and hold when untouched", () => {
		expect([...getKnownFieldKeys()]).toEqual(["alt"]);
		arrive(
			event([
				replace("/fieldDefs", { alt: createFieldDef("number"), foo: createFieldDef("string") }),
			]),
		);
		expect([...getKnownFieldKeys()].sort()).toEqual(["alt", "foo"]);

		arrive(event([replace("/fieldDefs", { foo: createFieldDef("string") })]));
		expect([...getKnownFieldKeys()]).toEqual(["foo"]);

		const held = getKnownFieldKeys();
		arrive(event());
		expect(getKnownFieldKeys()).toBe(held);
	});

	it("selectionCounts replace when patched", () => {
		arrive(event([replace("/selectionCounts", { "tag:1": 7 })]));
		expect(Store.get().selectionCounts).toEqual({ "tag:1": 7 });
	});

	it("the listed selections follow their rows and order", () => {
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
		arrive(event([add("/selectionRows/tag:1", row), replace("/selectionOrder", ["tag:1"])]));
		expect(SelectionList.listed()).toEqual([row]);
		const held = SelectionList.listed();
		arrive(event());
		expect(SelectionList.listed()).toBe(held);
		arrive(event([remove("/selectionRows/tag:1"), replace("/selectionOrder", [])]));
		expect(SelectionList.listed()).toEqual([]);
	});

	it("settles each write only after the feed reaches its version", async () => {
		let firstDone = false;
		let secondDone = false;
		const first = Mutation.settle({ version: 50, keys: [] }).then(() => (firstDone = true));
		const second = Mutation.settle({ version: 51, keys: [] }).then(() => (secondDone = true));

		arrive(event([replace("/locationCount", 12)], 50));
		await first;
		expect(firstDone).toBe(true);
		expect(secondDone).toBe(false);
		expect(Store.get().locationCount).toBe(12);

		arrive(event([replace("/locationCount", 13)], 51));
		await second;
		expect(secondDone).toBe(true);
		expect(Store.get().locationCount).toBe(13);
	});

	it("a write whose map closes before its feed event arrives still settles", async () => {
		const pending = Mutation.settle({ version: 99, keys: [] });
		Maps.discard();
		await expect(pending).resolves.toBeUndefined();
	});

	it("a write the open already covers settles without waiting for the feed", async () => {
		await expect(Mutation.settle({ version: 1, keys: [] })).resolves.toBeUndefined();
	});
});

describe("changes during the open", () => {
	it("a change that arrives before the open returns lands once the open applies", async () => {
		feed.duringOpen = event([replace("/locationCount", 9)], 2);
		await Maps.open("m1");
		feed.duringOpen = null;
		expect(Store.get()).toMatchObject({ locationCount: 9, version: 2 });
	});

	it("a change on the channel of an earlier open is dropped", async () => {
		const earlier = feed.onmessage!;
		await Maps.open("m1");
		earlier(event([replace("/locationCount", 7)], 3));
		expect(Store.get().locationCount).not.toBe(7);
	});
});

describe("edits at another map", () => {
	it("settle at once on the receipt that map's edit returns", async () => {
		const r = await Edit.locations({ kind: "map", id: "m2" }, [{ remove: 1 }]);
		expect(r.mutation).toEqual({ version: 0, keys: [5] });
	});
});

describe("work on no map", () => {
	it("resolves to an empty result without reaching the store", async () => {
		Maps.discard();
		const r = await Edit.work({ type: "Everything" }, { kind: "delete", keys: ["alt"] });
		expect(r).toEqual({ mutation: { version: 0, keys: [] }, changed: 0, failed: [] });
		expect(r.mutation).not.toBe(Mutation.none());
	});
});

describe("store announcements", () => {
	it("applying a patch announces the snapshot change the way Store.patch does", () => {
		const heard = vi.fn();
		const off = subscribe("snapshot:changed", heard);
		Store.apply(event([replace("/locationCount", 9)]).patch, 1);
		expect(heard).toHaveBeenCalledOnce();
		Store.patch({});
		expect(heard).toHaveBeenCalledTimes(2);
		off();
	});

	it("the snapshot keeps the version and unsaved state the feed last delivered", () => {
		arrive(event([replace("/unsaved", true)], 5));
		expect(Store.get()).toMatchObject({ version: 5, unsaved: true });
		arrive(event([], 6));
		expect(Store.get()).toMatchObject({ version: 6, unsaved: true });
		arrive(event([replace("/unsaved", false)], 6));
		expect(Store.get().unsaved).toBe(false);
	});

	it("a feed event announces the snapshot change exactly once", () => {
		const heard = vi.fn();
		const off = subscribe("snapshot:changed", heard);
		arrive(event([replace("/locationCount", 4)], 2));
		expect(heard).toHaveBeenCalledOnce();
		off();
	});
});

describe("autosave follows the map version", () => {
	it("a held edit, which leaves the version where it was, schedules no autosave", async () => {
		const schedule = vi.spyOn(Autosave, "schedule");
		arrive(event([replace("/writingLayers", ["import:main"])], 1));
		await Mutation.settle({ version: 1, keys: [] });
		expect(schedule).not.toHaveBeenCalled();
		schedule.mockRestore();
	});

	it("an edit that moves the version schedules exactly one autosave", async () => {
		const schedule = vi.spyOn(Autosave, "schedule");
		const settling = Mutation.settle({ version: 2, keys: [] });
		arrive(event([replace("/locationCount", 3)], 2));
		await settling;
		expect(schedule).toHaveBeenCalledOnce();
		schedule.mockRestore();
	});
});
