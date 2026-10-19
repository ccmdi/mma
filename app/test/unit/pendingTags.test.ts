import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tag } from "@/types";

const h = vi.hoisted(() => ({
	records: {} as Record<number, Tag>,
	values: vi.fn(async (_field: string, edits: unknown[]) => ({
		keys: edits.map((_, i) => 100 + i),
	})),
}));
vi.mock("@/store/tag", () => ({ Tag: { get: (id: number) => h.records[id] } }));
vi.mock("@/store/edit", () => ({ Edit: { values: h.values } }));

const { addPendingTag, togglePendingTag, pendingTagIds } = await import("@/lib/data/tags");

const urban: Tag = {
	id: 1,
	name: "Urban",
	color: "#000",
	visible: true,
	order: null,
	doclinks: [],
};
const none = { ids: [], names: [] };

beforeEach(() => {
	h.records = { 1: urban };
	h.values.mockClear();
});

describe("pending tags", () => {
	it("stage typed text naming an existing tag as its id, ignoring case", () => {
		expect(addPendingTag(none, "urban", [urban])).toEqual({ ids: [1], names: [] });
	});

	it("stage a brand-new name as typed", () => {
		expect(addPendingTag(none, "Coastal", [urban])).toEqual({ ids: [], names: ["Coastal"] });
	});

	it("leave pending unchanged when the tag is already staged", () => {
		const byId = { ids: [1], names: [] };
		const byName = { ids: [], names: ["Coastal"] };
		expect(addPendingTag(byId, "URBAN", [urban])).toBe(byId);
		expect(addPendingTag(byName, "coastal", [urban])).toBe(byName);
	});

	it("toggle a tag on and off by id", () => {
		expect(togglePendingTag(none, 1)).toEqual({ ids: [1], names: [] });
		expect(togglePendingTag({ ids: [1, 2], names: ["x"] }, 1)).toEqual({ ids: [2], names: ["x"] });
	});

	it("save existing tags as their ids, so a rename while staged cannot change them", async () => {
		h.records = { 1: { ...urban, name: "City" } };
		expect(await pendingTagIds({ ids: [1], names: [] })).toEqual([1]);
		expect(h.values).not.toHaveBeenCalled();
	});

	it("create only the typed names on save", async () => {
		expect(await pendingTagIds({ ids: [1], names: ["Coastal"] })).toEqual([1, 100]);
		expect(h.values).toHaveBeenCalledWith("tags", [{ add: { id: 0, name: "Coastal" } }]);
	});

	it("leave out a staged tag deleted before save", async () => {
		h.records = {};
		expect(await pendingTagIds({ ids: [1], names: [] })).toEqual([]);
	});
});
