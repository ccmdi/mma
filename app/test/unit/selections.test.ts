import { selectionFixture } from "./fixtures/selection";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFieldDef } from "@/types";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	all,
	any,
	childSelections,
	has,
	lacks,
	not,
	panoIdSelector,
	selectionDisplayName,
	tagSelector,
	unpannedSelector,
	untaggedSelector,
	withChildren,
} from "@/store/selections";
import { displayTagName } from "@/lib/data/tags";
import { setSetting } from "@/store/settings";

// The store binds tag and field-def lookups internally; back them with settable fakes.
const h = vi.hoisted(() => ({
	tags: {} as Record<number, { id: number; name: string; color: string; visible: boolean }>,
	fieldDefs: {} as Record<string, unknown>,
}));
const setUserFieldDefs = (defs: Record<string, unknown>) => {
	h.fieldDefs = defs;
};
vi.mock("@/store/useMapStore", () => ({
	getTag: (id: number) => h.tags[id],
	getVisibleTags: () => Object.values(h.tags).filter((t) => t.visible !== false),
	getMapState: () => ({ fieldDefs: h.fieldDefs }),
}));

beforeEach(() => {
	h.tags = {};
});

// This suite runs in node (no DOM); back setSetting's localStorage with a stub.
if (typeof localStorage === "undefined") {
	let store: Record<string, string> = {};
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
		removeItem: (k: string) => {
			delete store[k];
		},
		clear: () => {
			store = {};
		},
	});
}

describe("selector combinators", () => {
	const tag = tagSelector;
	const types = (sel: { selections: { selector: { type: string } }[] }) =>
		sel.selections.map((c) => c.selector.type);

	it("all intersects, flattening nested intersections and dropping Everything", () => {
		const out = all(all(tag(1), tag(2)), { type: "Everything" }, has("x"));
		expect(out.type).toBe("Intersection");
		expect(types(out as any)).toEqual(["Filter", "Filter", "Filter"]);
	});

	it("all of nothing is Everything, and of one is that one", () => {
		expect(all()).toEqual({ type: "Everything" });
		expect(all({ type: "Everything" }, tag(1))).toEqual(tag(1));
	});

	it("any unions, flattening nested unions", () => {
		const out = any(any(tag(1), tag(2)), tag(1));
		expect(out.type).toBe("Union");
		expect(types(out as any)).toEqual(["Filter", "Filter", "Filter"]);
		expect(any(tag(3))).toEqual(tag(3));
	});

	it("any of nothing is an empty union", () => {
		expect(any()).toEqual({ type: "Union", selections: [] });
	});

	it("not inverts, and inverting twice gives the selector back", () => {
		const inverted = not(tag(1));
		expect(inverted.type).toBe("Invert");
		expect(not(inverted)).toEqual(tag(1));
	});

	it("has and lacks are presence filters on a field", () => {
		expect(has("panoId")).toEqual({ type: "Filter", field: "panoId", test: { op: "has" } });
		expect(lacks("panoId")).toEqual({ type: "Filter", field: "panoId", test: { op: "nothas" } });
	});
});

describe("selectionDisplayName", () => {
	// Core field defs live in Rust now, not in a JS table, so seed fake fields covering
	// each type. These exercise the display mechanics (label, op symbol, enum/date/month
	// formatting) without depending on any specific real field's catalog entry.
	beforeEach(() => {
		setUserFieldDefs({
			label: createFieldDef("string", { label: "Country code" }),
			height: createFieldDef("number", { label: "Altitude" }),
			cam: createFieldDef("enum", {
				label: "Camera type",
				values: [{ value: "gen4", label: "Gen 4" }],
			}),
			month: createFieldDef("month", { label: "Image date" }),
			exact: createFieldDef("date", { label: "Exact date" }),
		});
	});
	afterEach(() => {
		setUserFieldDefs({});
	});

	it("returns type name for simple types", () => {
		const sel = selectionFixture({ type: "Everything" });
		expect(selectionDisplayName(sel)).toBe("Everything");
	});

	it("returns tag name for Tag selection", () => {
		h.tags = { 42: { id: 42, name: "My Tag", color: "#f00", visible: true } };
		const sel = selectionFixture(tagSelector(42));
		expect(selectionDisplayName(sel)).toBe("Tag: My Tag");
	});

	it("falls back to tag ID if tag not found", () => {
		const sel = selectionFixture(tagSelector(999));
		expect(selectionDisplayName(sel)).toBe("Tag: 999");
	});

	it("display name for Filter eq", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "label",
			test: { op: "eq", value: "BR" },
		});
		expect(selectionDisplayName(sel)).toBe("Country code = BR");
	});

	it("display name for Filter between", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "between", lo: 0, hi: 3000 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude between 0..3000");
	});

	it("display name for Filter neq", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "label",
			test: { op: "neq", value: "BR" },
		});
		expect(selectionDisplayName(sel)).toBe("Country code != BR");
	});

	it("display name for Filter gt", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "gt", value: 500 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude > 500");
	});

	it("display name for Filter lt", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "lt", value: 100 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude < 100");
	});

	it("display name for Filter gte", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "gte", value: 200 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude >= 200");
	});

	it("display name for Filter lte", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "lte", value: 300 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude <= 300");
	});

	it("display name for Filter has", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "has" },
		});
		expect(selectionDisplayName(sel)).toBe("has Altitude");
	});

	it("display name for Filter nothas", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "height",
			test: { op: "nothas" },
		});
		expect(selectionDisplayName(sel)).toBe("missing Altitude");
	});

	it("display name for Filter between_anyyear formats MM-DD as month day", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "month",
			test: { op: "between_anyyear", lo: "01-15", hi: "03-20" },
		});
		expect(selectionDisplayName(sel)).toBe("Image date between (any year) Jan 15..Mar 20");
	});

	it("display name for Filter between_anytime uses raw values", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "month",
			test: { op: "between_anytime", lo: "08:00", hi: "16:00" },
		});
		expect(selectionDisplayName(sel)).toBe("Image date between (any date) 08:00..16:00");
	});

	it("display name for Filter enum field shows label not raw value", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "cam",
			test: { op: "eq", value: "gen4" },
		});
		expect(selectionDisplayName(sel)).toBe("Camera type = Gen 4");
	});

	it("display name for Filter date field formats unix timestamp", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "exact",
			test: { op: "gt", value: 1700000000 },
		});
		// Chip labels render date fields in local time to match the DatePicker.
		const d = new Date(1700000000 * 1000);
		const p = (n: number) => String(n).padStart(2, "0");
		const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		expect(selectionDisplayName(sel)).toBe(`Exact date > ${expected}`);
	});

	it("display name for tzLocal filters renders wall-clock values in UTC", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "exact",
			test: { op: "between", lo: 1583020800, hi: 1583107140, tzLocal: true },
		});
		expect(selectionDisplayName(sel)).toBe(
			"Exact date between 2020-03-01 00:00..2020-03-01 23:59 (location time)",
		);
	});

	it("display name for Filter uses raw field name when no fieldDef exists", () => {
		const sel = selectionFixture({
			type: "Filter",
			field: "unknownField",
			test: { op: "eq", value: "test" },
		});
		expect(selectionDisplayName(sel)).toBe("unknownField = test");
	});

	it("display name for Filter enum uses user-defined field defs", () => {
		setUserFieldDefs({
			myCustomField: createFieldDef("enum", {
				label: "Custom",
				values: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				],
			}),
		});
		const sel = selectionFixture({
			type: "Filter",
			field: "myCustomField",
			test: { op: "eq", value: "a" },
		});
		expect(selectionDisplayName(sel)).toBe("Custom = Alpha");
	});

	it("display name for Locations with name", () => {
		const sel = selectionFixture({ type: "Locations", locations: [1, 2], name: "My Set" });
		expect(selectionDisplayName(sel)).toBe("My Set");
	});

	it("display name for Locations without name", () => {
		const sel = selectionFixture({ type: "Locations", locations: [1], name: null });
		expect(selectionDisplayName(sel)).toBe("Selection");
	});

	it("display name for Polygon without name", () => {
		const sel = selectionFixture({
			type: "Polygon",
			polygon: {
				coordinates: [
					[
						[0, 0],
						[1, 0],
						[1, 1],
						[0, 0],
					],
				],
				extraPolygons: null,
			},
		});
		expect(selectionDisplayName(sel)).toBe("Polygon");
	});

	it("display name for Polygon with name", () => {
		const sel = selectionFixture({
			type: "Polygon",
			polygon: {
				coordinates: [
					[
						[0, 0],
						[1, 0],
						[1, 1],
						[0, 0],
					],
				],
				extraPolygons: null,
				properties: { name: "Europe" },
			},
		});
		expect(selectionDisplayName(sel)).toBe("Polygon: Europe");
	});

	it("display name for Duplicates", () => {
		const sel = selectionFixture({ type: "Duplicates", distance: 100 });
		setSetting("units", "metric");
		expect(selectionDisplayName(sel)).toBe("Duplicates (100 m)");
		setSetting("units", "imperial");
		expect(selectionDisplayName(sel)).toBe("Duplicates (328 ft)");
		setSetting("units", "auto");
	});

	it("display name for Manual", () => {
		const sel = selectionFixture({ type: "Manual", locations: [1, 2, 3] });
		expect(selectionDisplayName(sel)).toBe("Manual selection");
	});

	it("display name for a Validation category", () => {
		const sel = selectionFixture({ type: "Validation", locations: [1], category: "notFound" });
		expect(selectionDisplayName(sel)).toBe("Not found");
	});

	it("display name for a composed Validation category", () => {
		const sel = selectionFixture({ type: "Validation", locations: [2], category: "updateApplied" });
		expect(selectionDisplayName(sel)).toBe("Coverage updated since last view");
	});

	it("display name for an unknown Validation category is its key", () => {
		const sel = selectionFixture({ type: "Validation", locations: [2], category: "gone" });
		expect(selectionDisplayName(sel)).toBe("gone");
	});

	it("display name for Intersection", () => {
		const s1 = selectionFixture(panoIdSelector(true));
		const s2 = selectionFixture(untaggedSelector());
		const inter = [selectionFixture({ type: "Intersection", selections: [s1, s2] })];
		expect(selectionDisplayName(inter[0])).toBe("Intersection");
	});

	it("display name for Union", () => {
		const s1 = selectionFixture(panoIdSelector(true));
		const s2 = selectionFixture(untaggedSelector());
		const union = [selectionFixture({ type: "Union", selections: [s1, s2] })];
		expect(selectionDisplayName(union[0])).toBe("Union");
	});

	it("display name for Invert includes child name", () => {
		const s1 = selectionFixture(panoIdSelector(true));
		const inverted = [selectionFixture({ type: "Invert", selections: [s1] })];
		expect(selectionDisplayName(inverted[0])).toBe("Coordinate locations");
	});

	it("every named selection is recognised from what its builder derives", () => {
		expect(selectionDisplayName(selectionFixture(untaggedSelector()))).toBe("Untagged");
		expect(selectionDisplayName(selectionFixture(unpannedSelector()))).toBe("Unpanned");
		expect(selectionDisplayName(selectionFixture(panoIdSelector(true)))).toBe("Pano ID locations");
	});

	it("names a selection carrying a key saved before the field system", () => {
		const stale = { ...selectionFixture(panoIdSelector(true)), key: "panoids" };
		expect(selectionDisplayName(stale)).toBe("Pano ID locations");
	});
});

describe("displayTagName", () => {
	afterEach(() => {
		setSetting("tagViewMode", "flat");
		setSetting("truncateTagPaths", false);
	});

	it("computes unique suffixes over visible tags only, ignoring soft-deleted ghosts", () => {
		setSetting("tagViewMode", "tree");
		setSetting("truncateTagPaths", true);
		h.tags = {
			1: { id: 1, name: "Europe/France", color: "#111", visible: true },
			// Deleted tag kept for undo — must not widen the survivor's suffix.
			2: { id: 2, name: "Asia/France", color: "#222", visible: false },
		};
		expect(displayTagName("Europe/France")).toBe("France");
	});

	it("returns the name verbatim outside tree/truncate mode", () => {
		h.tags = { 1: { id: 1, name: "Europe/France", color: "#111", visible: true } };
		expect(displayTagName("Europe/France")).toBe("Europe/France");
	});
});

describe("childSelections", () => {
	it("returns selections array for Intersection", () => {
		const a = selectionFixture(panoIdSelector(true));
		const b = selectionFixture(untaggedSelector());
		const sel = { type: "Intersection" as const, selections: [a, b] };
		expect(childSelections(sel)).toEqual([a, b]);
	});

	it("returns selections array for Union", () => {
		const a = selectionFixture(panoIdSelector(true));
		const sel = { type: "Union" as const, selections: [a] };
		expect(childSelections(sel)).toEqual([a]);
	});

	it("returns single-element array for Ranked with selection", () => {
		const inner = selectionFixture(untaggedSelector());
		const sel = { type: "Ranked" as const, selection: inner, expr: "lat", k: 5, ascending: true };
		expect(childSelections(sel)).toEqual([inner]);
	});

	it("returns empty array for Ranked without selection", () => {
		const sel = {
			type: "Ranked" as const,
			selection: null,
			expr: "lat",
			k: null,
			ascending: false,
		};
		expect(childSelections(sel)).toEqual([]);
	});

	it("returns empty array for leaf selectors", () => {
		expect(childSelections({ type: "Everything" })).toEqual([]);
		expect(childSelections(tagSelector(1))).toEqual([]);
		expect(childSelections(untaggedSelector())).toEqual([]);
		expect(childSelections({ type: "Duplicates", distance: 10 })).toEqual([]);
		expect(childSelections({ type: "Filter", field: "x", test: { op: "has" } })).toEqual([]);
	});
});

describe("withChildren", () => {
	it("replaces children in Intersection", () => {
		const a = selectionFixture(panoIdSelector(true));
		const b = selectionFixture(untaggedSelector());
		const sel = { type: "Intersection" as const, selections: [a] };
		const result = withChildren(sel, [a, b]);
		expect((result as { selections: unknown[] }).selections).toEqual([a, b]);
	});

	it("replaces children in Union", () => {
		const a = selectionFixture(panoIdSelector(true));
		const sel = { type: "Union" as const, selections: [a] };
		const result = withChildren(sel, []);
		expect((result as { selections: unknown[] }).selections).toEqual([]);
	});

	it("replaces the optional selection in Ranked", () => {
		const inner = selectionFixture(untaggedSelector());
		const replacement = selectionFixture(panoIdSelector(true));
		const sel = { type: "Ranked" as const, selection: inner, expr: "lat", k: 5, ascending: true };
		const result = withChildren(sel, [replacement]);
		expect((result as { selection: unknown }).selection).toBe(replacement);
	});

	it("sets selection to null when children is empty for Ranked", () => {
		const inner = selectionFixture(untaggedSelector());
		const sel = {
			type: "Ranked" as const,
			selection: inner,
			expr: "lat",
			k: null,
			ascending: true,
		};
		const result = withChildren(sel, []);
		expect((result as { selection: unknown }).selection).toBeNull();
	});

	it("returns the selector unchanged for leaf types", () => {
		const leaf = { type: "Everything" as const };
		expect(withChildren(leaf, [])).toEqual(leaf);
	});

	it("roundtrips: withChildren(sel, childSelections(sel)) preserves shape", () => {
		const a = selectionFixture(panoIdSelector(true));
		const b = selectionFixture(untaggedSelector());
		const intersection = { type: "Intersection" as const, selections: [a, b] };
		const result = withChildren(intersection, childSelections(intersection));
		expect((result as { selections: unknown[] }).selections).toEqual([a, b]);
	});
});
