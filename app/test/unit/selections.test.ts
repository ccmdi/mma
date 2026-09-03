/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFieldDef } from "@/types";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	colorForKey,
	buildSelection,
	addSelection,
	removeSelection,
	intersectSelections,
	unionSelections,
	invertSelections,
	toggleManualSelection,
	selectionDisplayName,
	displayTagName,
	SELECTIONS,
	reorderSelections,
	composeSelections,
	decomposeChild,
	removeFromComposite,
	composeSiblings,
	composeWithChild,
	replaceSelection,
	sampleIds,
	polygonSelectionsContaining,
	isolateGhostKeys,
	rewriteSelectionFields,
} from "@/store/selections";
import { ValidationState } from "@/bindings.consts";
import type { PolygonGeometry } from "@/bindings.gen";
import { setUserFieldDefs } from "@/lib/data/fieldDefRegistry";
import { setSetting } from "@/store/settings";

// The store binds tag lookups internally; back them with a settable fake tag set.
const h = vi.hoisted(() => ({
	tags: {} as Record<number, { id: number; name: string; color: string; visible: boolean }>,
}));
vi.mock("@/store/useMapStore", () => ({
	getTag: (id: number) => h.tags[id],
	getVisibleTags: () => Object.values(h.tags).filter((t) => t.visible !== false),
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

describe("colorForKey", () => {
	it("returns an RGB tuple", () => {
		const [r, g, b] = colorForKey("test");
		expect(r).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThanOrEqual(255);
		expect(g).toBeGreaterThanOrEqual(0);
		expect(b).toBeGreaterThanOrEqual(0);
	});

	it("is deterministic", () => {
		expect(colorForKey("foo")).toEqual(colorForKey("foo"));
	});

	it("produces different colors for different keys", () => {
		expect(colorForKey("alpha")).not.toEqual(colorForKey("beta"));
	});
});

describe("polygon color mode", () => {
	const polygon: PolygonGeometry = {
		coordinates: [
			[
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 0],
			],
		],
		extraPolygons: null,
	};
	const build = () => buildSelection({ type: "Polygon", polygon, includeInformational: false });

	afterEach(() => setSetting("polygonColorMode", "random"));

	it("random gives each polygon its own key-hashed color", () => {
		setSetting("polygonColorMode", "random");
		const a = build();
		const other = buildSelection({
			type: "Polygon",
			polygon: {
				coordinates: [
					[
						[5, 5],
						[6, 5],
						[6, 6],
						[5, 5],
					],
				],
				extraPolygons: null,
			},
			includeInformational: false,
		});
		expect(a.color).toEqual(colorForKey(a.key));
		expect(other.color).toEqual(colorForKey(other.key));
		expect(a.key).not.toBe(other.key);
	});

	it("fixed gives every polygon the configured color", () => {
		setSetting("polygonColorMode", "fixed");
		setSetting("polygonColor", [1, 2, 3]);
		expect(build().color).toEqual([1, 2, 3]);
		expect(build().color).toEqual([1, 2, 3]);
	});

	it("fixed does not affect non-polygon selections", () => {
		setSetting("polygonColorMode", "fixed");
		setSetting("polygonColor", [1, 2, 3]);
		expect(buildSelection({ type: "Untagged" }).color).toEqual(colorForKey("untagged"));
	});
});

describe("polygon selection keys", () => {
	const square = (o: number): PolygonGeometry => ({
		coordinates: [
			[
				[o, o],
				[o + 1, o],
				[o + 1, o + 1],
				[o, o],
			],
		],
		extraPolygons: null,
	});
	const build = (polygon: ReturnType<typeof square>) =>
		buildSelection({ type: "Polygon", polygon, includeInformational: false });

	it("identical geometry keys identically, so rebuilds keep identity", () => {
		// Key is identity for recolor/reorder/remove; a rebuild (replaceSelection,
		// tree transforms) must not mint a fresh key for an unchanged polygon.
		expect(build(square(0)).key).toBe(build(square(0)).key);
	});

	it("different geometry gets different keys", () => {
		expect(build(square(0)).key).not.toBe(build(square(5)).key);
		const withHole = {
			coordinates: [...square(0).coordinates, ...square(0.25).coordinates],
			extraPolygons: null,
		};
		expect(build(withHole).key).not.toBe(build(square(0)).key);
		const multi = {
			...square(0),
			extraPolygons: [square(5).coordinates],
		};
		expect(build(multi).key).not.toBe(build(square(0)).key);
	});

	it("identical repeat adds dedupe instead of stacking", () => {
		const once = addSelection([], {
			type: "Polygon",
			polygon: square(0),
			includeInformational: false,
		});
		const twice = addSelection(once, {
			type: "Polygon",
			polygon: square(0),
			includeInformational: false,
		});
		expect(twice.length).toBe(1);
	});
});

describe("review overlay colors stay clear of the active marker", () => {
	// The active-location marker is red (hue 0 by default). The reviewed/unreviewed overlays must
	// not blend into it, or into each other, or the cursor gets lost in a field of queued markers.
	const hueOf = ([r, g, b]: [number, number, number]): number => {
		const max = Math.max(r, g, b);
		const d = max - Math.min(r, g, b);
		if (d === 0) return 0;
		let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h *= 60;
		return h < 0 ? h + 360 : h;
	};
	const circ = (a: number, b: number): number => {
		const d = Math.abs(a - b) % 360;
		return Math.min(d, 360 - d);
	};
	const colorFor = (mode: "reviewed" | "unreviewed") =>
		buildSelection({ type: "Reviewed", locations: [], sessionId: "s", mode }).color;
	const ACTIVE_HUE = 0; // default active-location marker is red

	it("unreviewed is well clear of red", () => {
		expect(circ(hueOf(colorFor("unreviewed")), ACTIVE_HUE)).toBeGreaterThanOrEqual(60);
	});
	it("reviewed is well clear of red", () => {
		expect(circ(hueOf(colorFor("reviewed")), ACTIVE_HUE)).toBeGreaterThanOrEqual(60);
	});
	it("reviewed and unreviewed are well separated from each other", () => {
		expect(circ(hueOf(colorFor("reviewed")), hueOf(colorFor("unreviewed")))).toBeGreaterThanOrEqual(
			60,
		);
	});
});

describe("buildSelection", () => {
	it("Everything gets correct key", () => {
		const sel = buildSelection({ type: "Everything" });
		expect(sel.key).toBe("everything");
	});

	it("Tag gets key with tagId", () => {
		const sel = buildSelection({ type: "Tag", tagId: 42 });
		expect(sel.key).toBe("tag:42");
	});

	it("Untagged gets correct key", () => {
		const sel = buildSelection({ type: "Untagged" });
		expect(sel.key).toBe("untagged");
	});

	it("Unpanned gets correct key", () => {
		const sel = buildSelection({ type: "Unpanned" });
		expect(sel.key).toBe("unpanned");
	});

	it("PanoIds / NotPanoIds get correct keys", () => {
		expect(buildSelection({ type: "PanoIds" }).key).toBe("panoids");
		expect(buildSelection({ type: "NotPanoIds" }).key).toBe("notpanoids");
	});

	it("Manual gets correct key", () => {
		const sel = buildSelection({ type: "Manual", locations: [1, 2] });
		expect(sel.key).toBe("manual");
	});

	it("Filter generates key with field/op/value", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "altitude",
			test: { op: "gt", value: 500 },
		});
		expect(sel.key).toBe("filter:altitude:gt:500");
	});

	it("Filter between includes both bounds", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "altitude",
			test: { op: "between", lo: 0, hi: 1000 },
		});
		expect(sel.key).toBe("filter:altitude:between:0:1000");
	});

	it("assigns a color", () => {
		const sel = buildSelection({ type: "Everything" });
		expect(sel.color).toHaveLength(3);
		expect(sel.color[0]).toBeGreaterThanOrEqual(0);
	});
});

describe("addSelection / removeSelection", () => {
	it("addSelection appends a new selection", () => {
		const result = addSelection([], { type: "Everything" });
		expect(result).toHaveLength(1);
		expect(result[0].key).toBe("everything");
	});

	it("addSelection deduplicates by key", () => {
		const first = addSelection([], { type: "Everything" });
		const second = addSelection(first, { type: "Everything" });
		expect(second).toHaveLength(1);
	});

	it("removeSelection removes by key", () => {
		const sels = addSelection([], { type: "Everything" });
		const result = removeSelection(sels, "everything");
		expect(result).toHaveLength(0);
	});

	it("removeSelection decomposes composite on remove", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const composite = buildSelection({ type: "Intersection", selections: [s1, s2] });
		const result = removeSelection([composite], composite.key);
		expect(result).toHaveLength(2);
	});
});

describe("intersectSelections", () => {
	it("creates intersection of two selections", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = intersectSelections([s1, s2], null);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Intersection");
	});

	it("does nothing with fewer than 2 selections", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const result = intersectSelections([s1], null);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("PanoIds");
	});

	it("flattens nested intersections", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const inter = intersectSelections([s1, s2], null);
		const s3 = buildSelection({ type: "Unpanned" });
		const result = intersectSelections([...inter, s3], null);
		expect(result).toHaveLength(1);
		const children = (result[0].selector as { type: "Intersection"; selections: any[] }).selections;
		expect(children).toHaveLength(3);
	});
});

describe("unionSelections", () => {
	it("creates union of two selections", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = unionSelections([s1, s2], null);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Union");
	});

	it("flattens nested unions", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const union = unionSelections([s1, s2], null);
		const s3 = buildSelection({ type: "Unpanned" });
		const result = unionSelections([...union, s3], null);
		expect(result).toHaveLength(1);
		const children = (result[0].selector as { type: "Union"; selections: any[] }).selections;
		expect(children).toHaveLength(3);
	});
});

describe("invertSelections", () => {
	it("wraps a single selection in Invert", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const result = invertSelections([s1], null);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Invert");
	});

	it("double invert unwraps back to original", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const inverted = invertSelections([s1], null);
		const result = invertSelections(inverted, null);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("PanoIds");
	});

	it("inverts a nested child in place, leaving the parent group intact", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const union = buildSelection({ type: "Union", selections: [s1, s2] });
		const result = invertSelections([union], [s1.key]);
		expect(result).toHaveLength(1);
		const top = result[0].selector as { type: "Union"; selections: any[] };
		expect(top.type).toBe("Union");
		expect(top.selections).toHaveLength(2);
		const inverted = top.selections.find((c) => c.selector.type === "Invert");
		expect(inverted).toBeDefined();
		expect(inverted.selector.selections[0].key).toBe(s1.key);
	});

	it("toggles a nested invert back off without collapsing the group", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const union = buildSelection({ type: "Union", selections: [s1, s2] });
		const inverted = invertSelections([union], [s1.key]);
		const invertedChild = (inverted[0].selector as { selections: any[] }).selections.find(
			(c) => c.selector.type === "Invert",
		);
		const result = invertSelections(inverted, [invertedChild.key]);
		expect(result).toHaveLength(1);
		const top = result[0].selector as { type: "Union"; selections: any[] };
		expect(top.type).toBe("Union");
		expect(top.selections.map((c) => c.key).sort()).toEqual([s1.key, s2.key].sort());
	});
});

describe("toggleManualSelection", () => {
	it("creates manual selection if none exists", () => {
		const result = toggleManualSelection([], 1);
		expect(result).toHaveLength(1);
		expect(result[0].key).toBe("manual");
	});

	it("adds to existing manual selection", () => {
		const initial = toggleManualSelection([], 1);
		const result = toggleManualSelection(initial, 2);
		const ids = (result[0].selector as { type: "Manual"; locations: number[] }).locations;
		expect(ids).toContain(1);
		expect(ids).toContain(2);
	});

	it("removes from existing manual selection", () => {
		let sels = toggleManualSelection([], 1);
		sels = toggleManualSelection(sels, 2);
		sels = toggleManualSelection(sels, 1);
		const ids = (sels[0].selector as { type: "Manual"; locations: number[] }).locations;
		expect(ids).toEqual([2]);
	});

	it("removes manual selection entirely when last location toggled off", () => {
		let sels = toggleManualSelection([], 1);
		sels = toggleManualSelection(sels, 1);
		expect(sels).toHaveLength(0);
	});
});

describe("reorderSelections", () => {
	it("moves selection before target", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const s3 = buildSelection({ type: "Unpanned" });
		const result = reorderSelections([s1, s2, s3], s3.key, s1.key, "before");
		expect(result.map((s) => s.key)).toEqual([s3.key, s1.key, s2.key]);
	});

	it("moves selection after target", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const s3 = buildSelection({ type: "Unpanned" });
		const result = reorderSelections([s1, s2, s3], s1.key, s3.key, "after");
		expect(result.map((s) => s.key)).toEqual([s2.key, s3.key, s1.key]);
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
				values: ["gen4"],
				labels: { gen4: "Gen 4" },
			}),
			month: createFieldDef("month", { label: "Image date" }),
			exact: createFieldDef("date", { label: "Exact date" }),
		});
	});
	afterEach(() => {
		setUserFieldDefs({});
	});

	it("returns type name for simple types", () => {
		const sel = buildSelection({ type: "Everything" });
		expect(selectionDisplayName(sel)).toBe("Everything");
	});

	it("returns tag name for Tag selection", () => {
		h.tags = { 42: { id: 42, name: "My Tag", color: "#f00", visible: true } };
		const sel = buildSelection({ type: "Tag", tagId: 42 });
		expect(selectionDisplayName(sel)).toBe("Tag: My Tag");
	});

	it("falls back to tag ID if tag not found", () => {
		const sel = buildSelection({ type: "Tag", tagId: 999 });
		expect(selectionDisplayName(sel)).toBe("Tag: 999");
	});

	it("display name for Filter eq", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "label",
			test: { op: "eq", value: "BR" },
		});
		expect(selectionDisplayName(sel)).toBe("Country code = BR");
	});

	it("display name for Filter between", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "between", lo: 0, hi: 3000 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude between 0..3000");
	});

	it("display name for Filter neq", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "label",
			test: { op: "neq", value: "BR" },
		});
		expect(selectionDisplayName(sel)).toBe("Country code != BR");
	});

	it("display name for Filter gt", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "gt", value: 500 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude > 500");
	});

	it("display name for Filter lt", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "lt", value: 100 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude < 100");
	});

	it("display name for Filter gte", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "gte", value: 200 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude >= 200");
	});

	it("display name for Filter lte", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "lte", value: 300 },
		});
		expect(selectionDisplayName(sel)).toBe("Altitude <= 300");
	});

	it("display name for Filter has", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "has" },
		});
		expect(selectionDisplayName(sel)).toBe("has Altitude");
	});

	it("display name for Filter nothas", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "height",
			test: { op: "nothas" },
		});
		expect(selectionDisplayName(sel)).toBe("missing Altitude");
	});

	it("display name for Filter between_anyyear formats MM-DD as month day", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "month",
			test: { op: "between_anyyear", lo: "01-15", hi: "03-20" },
		});
		expect(selectionDisplayName(sel)).toBe("Image date between (any year) Jan 15..Mar 20");
	});

	it("display name for Filter between_anytime uses raw values", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "month",
			test: { op: "between_anytime", lo: "08:00", hi: "16:00" },
		});
		expect(selectionDisplayName(sel)).toBe("Image date between (any date) 08:00..16:00");
	});

	it("display name for Filter enum field shows label not raw value", () => {
		const sel = buildSelection({
			type: "Filter",
			field: "cam",
			test: { op: "eq", value: "gen4" },
		});
		expect(selectionDisplayName(sel)).toBe("Camera type = Gen 4");
	});

	it("display name for Filter date field formats unix timestamp", () => {
		const sel = buildSelection({
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
		const sel = buildSelection({
			type: "Filter",
			field: "exact",
			test: { op: "between", lo: 1583020800, hi: 1583107140, tzLocal: true },
		});
		expect(selectionDisplayName(sel)).toBe(
			"Exact date between 2020-03-01 00:00..2020-03-01 23:59 (location time)",
		);
	});

	it("tzLocal filters get a distinct key from absolute-frame filters", () => {
		const abs = buildSelection({
			type: "Filter",
			field: "exact",
			test: { op: "between", lo: 1, hi: 2 },
		});
		const local = buildSelection({
			type: "Filter",
			field: "exact",
			test: { op: "between", lo: 1, hi: 2, tzLocal: true },
		});
		expect(abs.key).not.toBe(local.key);
		expect(local.key.endsWith(":local")).toBe(true);
	});

	it("display name for Filter uses raw field name when no fieldDef exists", () => {
		const sel = buildSelection({
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
				values: ["a", "b"],
				labels: { a: "Alpha", b: "Beta" },
			}),
		});
		const sel = buildSelection({
			type: "Filter",
			field: "myCustomField",
			test: { op: "eq", value: "a" },
		});
		expect(selectionDisplayName(sel)).toBe("Custom = Alpha");
	});

	it("display name for Locations with name", () => {
		const sel = buildSelection({ type: "Locations", locations: [1, 2], name: "My Set" });
		expect(selectionDisplayName(sel)).toBe("My Set");
	});

	it("display name for Locations without name", () => {
		const sel = buildSelection({ type: "Locations", locations: [1], name: null });
		expect(selectionDisplayName(sel)).toBe("Selection");
	});

	it("display name for Polygon without name", () => {
		const sel = buildSelection({
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
			includeInformational: false,
		});
		expect(selectionDisplayName(sel)).toBe("Polygon");
	});

	it("display name for Polygon with name", () => {
		const sel = buildSelection({
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
			includeInformational: false,
		});
		expect(selectionDisplayName(sel)).toBe("Polygon: Europe");
	});

	it("display name for Duplicates", () => {
		const sel = buildSelection({ type: "Duplicates", distance: 100 });
		setSetting("units", "metric");
		expect(selectionDisplayName(sel)).toBe("Duplicates (100 m)");
		setSetting("units", "imperial");
		expect(selectionDisplayName(sel)).toBe("Duplicates (328 ft)");
		setSetting("units", "auto");
	});

	it("display name for Manual", () => {
		const sel = buildSelection({ type: "Manual", locations: [1, 2, 3] });
		expect(selectionDisplayName(sel)).toBe("Manual selection");
	});

	it("display name for ValidationState", () => {
		const sel = buildSelection({
			type: "ValidationState",
			locations: [1],
			state: ValidationState.NotFound,
		});
		expect(selectionDisplayName(sel)).toBe("Not found");
	});

	it("display name for ValidationState PanoIdBroke", () => {
		const sel = buildSelection({
			type: "ValidationState",
			locations: [2],
			state: ValidationState.PanoIdBroke,
		});
		expect(selectionDisplayName(sel)).toBe("Pano ID broke");
	});

	it("display name for Intersection", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const inter = intersectSelections([s1, s2], null);
		expect(selectionDisplayName(inter[0])).toBe("Intersection");
	});

	it("display name for Union", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const union = unionSelections([s1, s2], null);
		expect(selectionDisplayName(union[0])).toBe("Union");
	});

	it("display name for Invert includes child name", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const inverted = invertSelections([s1], null);
		expect(selectionDisplayName(inverted[0])).toBe("Invert: Pano ID locations");
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

describe("SELECTIONS.locations", () => {
	it("copies the ids out rather than aliasing them", () => {
		const locs = [10, 20, 30];
		const result = SELECTIONS.Manual.locations!({ type: "Manual", locations: locs });
		expect(result).toEqual([10, 20, 30]);
		expect(result).not.toBe(locs);
	});

	it("is declared by exactly the variants that carry an id list", () => {
		const carriers = Object.entries(SELECTIONS)
			.filter(([, d]) => d.locations)
			.map(([type]) => type)
			.sort();
		expect(carriers).toEqual(["Locations", "Manual", "Reviewed", "ValidationState"]);
	});
});

describe("reorderSelections edge cases", () => {
	it("returns unchanged when from key not found", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = reorderSelections([s1, s2], "nonexistent", s2.key, "before");
		expect(result.map((s) => s.key)).toEqual([s1.key, s2.key]);
	});

	it("returns unchanged when to key not found", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = reorderSelections([s1, s2], s1.key, "nonexistent", "before");
		expect(result.map((s) => s.key)).toEqual([s1.key, s2.key]);
	});

	it("returns unchanged when from and to are the same", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = reorderSelections([s1, s2], s1.key, s1.key, "before");
		expect(result.map((s) => s.key)).toEqual([s1.key, s2.key]);
	});
});

describe("composeSelections", () => {
	it("drag onto drop creates intersection", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = composeSelections([s1, s2], s2.key, s1.key, "Intersection");
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Intersection");
	});

	it("drag onto drop creates union", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const result = composeSelections([s1, s2], s2.key, s1.key, "Union");
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Union");
	});

	it("drag onto existing composite adds as child", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const composed = composeSelections([s1, s2], s2.key, s1.key, "Intersection");
		const s3 = buildSelection({ type: "Unpanned" });
		const result = composeSelections([...composed, s3], s3.key, composed[0].key, "Intersection");
		expect(result).toHaveLength(1);
		const children = (result[0].selector as { selections: any[] }).selections;
		expect(children).toHaveLength(3);
	});

	it("returns unchanged if drag equals drop", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const result = composeSelections([s1], s1.key, s1.key, "Intersection");
		expect(result).toEqual([s1]);
	});

	it("returns unchanged if key not found", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const result = composeSelections([s1], "nonexistent", s1.key, "Intersection");
		expect(result).toEqual([s1]);
	});
});

describe("composeSiblings / composeWithChild preserve the Invert wrapper", () => {
	const invertedGroup = () => {
		const a = buildSelection({ type: "PanoIds" });
		const b = buildSelection({ type: "Untagged" });
		const c = buildSelection({ type: "Unpanned" });
		const group = buildSelection({ type: "Union", selections: [a, b, c] });
		const inv = buildSelection({ type: "Invert", selections: [group] });
		return { a, b, c, inv };
	};

	it("composeSiblings keeps Invert when nesting two children of an inverted group", () => {
		const { a, b, inv } = invertedGroup();
		const result = composeSiblings([inv], inv.key, a.key, b.key, "Intersection");
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Invert");
		const innerGroup = (result[0].selector as { selections: any[] }).selections[0];
		expect(innerGroup.selector.type).toBe("Union");
	});

	it("composeWithChild keeps Invert when nesting a top-level selection onto a child", () => {
		const { a, inv } = invertedGroup();
		const drag = buildSelection({ type: "Tag", tagId: 7 });
		const result = composeWithChild([inv, drag], drag.key, inv.key, a.key, "Intersection");
		expect(result.some((s) => s.selector.type === "Invert")).toBe(true);
		const invResult = result.find((s) => s.selector.type === "Invert")!;
		expect((invResult.selector as { selections: any[] }).selections[0].selector.type).toBe("Union");
	});
});

describe("decomposeChild", () => {
	it("extracts a child from a composite", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const s3 = buildSelection({ type: "Unpanned" });
		const composed = composeSelections(
			composeSelections([s1, s2], s2.key, s1.key, "Intersection").concat(s3),
			s3.key,
			composeSelections([s1, s2], s2.key, s1.key, "Intersection")[0].key,
			"Intersection",
		);
		const parentKey = composed[0].key;
		const result = decomposeChild(composed, parentKey, s2.key);
		expect(result.length).toBeGreaterThan(composed.length);
	});

	it("extracts a nested group without leaking its children into the parent", () => {
		const a = buildSelection({ type: "PanoIds" });
		const b = buildSelection({ type: "Untagged" });
		const c = buildSelection({ type: "Unpanned" });
		const union = buildSelection({ type: "Union", selections: [a, b] });
		const parent = buildSelection({ type: "Intersection", selections: [union, c] });

		const result = decomposeChild([parent], parent.key, union.key);

		// Parent had two children, so it collapses to the one left: C. The Union comes out whole.
		expect(result.map((s) => s.selector.type)).toEqual(["Unpanned", "Union"]);
		expect((result[1].selector as { selections: any[] }).selections.map((s: any) => s.key)).toEqual(
			[a.key, b.key],
		);
	});

	it("drops the parent when its only child is extracted", () => {
		const a = buildSelection({ type: "PanoIds" });
		const b = buildSelection({ type: "Untagged" });
		const union = buildSelection({ type: "Union", selections: [a, b] });
		const parent = buildSelection({ type: "Intersection", selections: [union] });

		const result = decomposeChild([parent], parent.key, union.key);

		expect(result).toHaveLength(1);
		expect(result[0].key).toBe(union.key);
	});
});

describe("removeFromComposite", () => {
	it("removes a child and reduces composite", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const s3 = buildSelection({ type: "Unpanned" });
		let sels = [s1, s2, s3];
		sels = composeSelections(sels, s2.key, s1.key, "Intersection");
		sels = composeSelections([...sels, s3], s3.key, sels[0].key, "Intersection");
		const parentKey = sels[0].key;
		const result = removeFromComposite(sels, parentKey, s2.key);
		expect(result).toHaveLength(sels.length);
		const children = (result[0].selector as { selections: any[] }).selections;
		expect(children.every((c: any) => c.key !== s2.key)).toBe(true);
	});

	// Deleting a nested group ungroups it: its children stay behind in the parent. Deliberate,
	// and the one place a removal is allowed to keep the removed node's children.
	it("ungroups a nested group into the parent", () => {
		const a = buildSelection({ type: "PanoIds" });
		const b = buildSelection({ type: "Untagged" });
		const c = buildSelection({ type: "Unpanned" });
		const union = buildSelection({ type: "Union", selections: [a, b] });
		const parent = buildSelection({ type: "Intersection", selections: [union, c] });

		const result = removeFromComposite([parent], parent.key, union.key);

		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Intersection");
		expect((result[0].selector as { selections: any[] }).selections.map((s: any) => s.key)).toEqual(
			[a.key, b.key, c.key],
		);
	});

	it("removes a composite that has no children left", () => {
		const a = buildSelection({ type: "PanoIds" });
		const b = buildSelection({ type: "Untagged" });
		const inner = buildSelection({ type: "Union", selections: [a, b] });
		const outer = buildSelection({ type: "Intersection", selections: [inner] });

		// Inner drops to one child, so it collapses, and so does the outer wrapping it.
		expect(removeFromComposite([outer], inner.key, a.key)).toEqual([b]);
		// Nothing left in the parent at all: the parent goes too.
		const solo = buildSelection({ type: "Intersection", selections: [a] });
		expect(removeFromComposite([solo], solo.key, a.key)).toEqual([]);
	});

	it("preserves the Invert wrapper when removing a child from an inverted group", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const s3 = buildSelection({ type: "Unpanned" });
		const group = buildSelection({ type: "Intersection", selections: [s1, s2, s3] });
		const inv = buildSelection({ type: "Invert", selections: [group] });
		const result = removeFromComposite([inv], inv.key, s1.key);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Invert");
		const innerGroup = (result[0].selector as { selections: any[] }).selections[0];
		expect(innerGroup.selector.type).toBe("Intersection");
		const children = (innerGroup.selector as { selections: any[] }).selections;
		expect(children.map((c: any) => c.key).sort()).toEqual([s2.key, s3.key].sort());
	});

	it("keeps Invert when the inverted group collapses to a single child", () => {
		const s1 = buildSelection({ type: "PanoIds" });
		const s2 = buildSelection({ type: "Untagged" });
		const group = buildSelection({ type: "Intersection", selections: [s1, s2] });
		const inv = buildSelection({ type: "Invert", selections: [group] });
		const result = removeFromComposite([inv], inv.key, s1.key);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Invert");
		expect((result[0].selector as { selections: any[] }).selections[0].key).toBe(s2.key);
	});
});

describe("replaceSelection", () => {
	const filterA = {
		type: "Filter" as const,
		field: "year",
		test: { op: "between" as const, lo: 2010, hi: 2015 },
	};
	const filterAEdited = { ...filterA, test: { ...filterA.test, lo: 2012, hi: 2020 } };

	it("replaces a top-level selection and updates its key", () => {
		const sel = buildSelection(filterA);
		const result = replaceSelection([sel], sel.key, filterAEdited);
		expect(result).toHaveLength(1);
		expect(result[0].key).toBe(buildSelection(filterAEdited).key);
		expect(result[0].key).not.toBe(sel.key);
		expect((result[0].selector as typeof filterAEdited).test.lo).toBe(2012);
	});

	it("preserves the Invert wrapper when editing a child of an inverted group", () => {
		const a = buildSelection(filterA);
		const b = buildSelection({ type: "Untagged" });
		const group = buildSelection({ type: "Union", selections: [a, b] });
		const inv = buildSelection({ type: "Invert", selections: [group] });
		const result = replaceSelection([inv], a.key, filterAEdited);
		expect(result).toHaveLength(1);
		expect(result[0].selector.type).toBe("Invert");
		const innerGroup = (result[0].selector as { selections: any[] }).selections[0];
		expect(innerGroup.selector.type).toBe("Union");
		const children = (innerGroup.selector as { selections: any[] }).selections;
		expect(children.some((c: any) => c.key === buildSelection(filterAEdited).key)).toBe(true);
		expect(children.some((c: any) => c.key === b.key)).toBe(true);
	});

	it("replaces a child inside a composite and rebuilds the parent key", () => {
		const a = buildSelection(filterA);
		const b = buildSelection({ type: "Untagged" });
		const composed = intersectSelections([a, b], null); // [Intersection(a,b)]
		const parent = composed[0];
		const result = replaceSelection(composed, a.key, filterAEdited);

		expect(result).toHaveLength(1);
		expect(result[0].key).not.toBe(parent.key); // parent key rebuilt
		const children = (result[0].selector as { selections: any[] }).selections;
		expect(children).toHaveLength(2);
		expect(children.some((c: any) => c.key === buildSelection(filterAEdited).key)).toBe(true);
		expect(children.some((c: any) => c.key === b.key)).toBe(true); // sibling preserved
		expect(children.some((c: any) => c.key === a.key)).toBe(false); // old child gone
	});

	it("is a no-op when the key is not found", () => {
		const sel = buildSelection(filterA);
		const input = [sel];
		const result = replaceSelection(input, "nonexistent", filterAEdited);
		expect(result).toBe(input); // unchanged reference
		expect(result[0].key).toBe(sel.key);
	});

	it("merges into the existing selection when the re-key collides, keeping the existing one", () => {
		const a = buildSelection(filterA);
		const b = buildSelection(filterAEdited);
		const result = replaceSelection([a, b], a.key, filterAEdited); // edit A onto B's value
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(b); // pre-existing selection kept, untouched
	});

	it("keeps the existing selection regardless of list order (existing always wins)", () => {
		const a = buildSelection(filterA);
		const b = buildSelection(filterAEdited);
		const result = replaceSelection([b, a], a.key, filterAEdited); // existing sits before the edit
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(b);
	});

	it("merges a child onto a sibling and unwraps the collapsed group", () => {
		const a = buildSelection(filterA);
		const b = buildSelection(filterAEdited);
		const group = unionSelections([a, b], null); // [Union(a, b)]
		const result = replaceSelection(group, a.key, filterAEdited); // edit a -> b's value
		expect(result).toHaveLength(1);
		expect(result[0].key).toBe(b.key); // (b OR b) collapsed to just b
		expect(result[0].selector.type).toBe("Filter"); // unwrapped, no longer a Union
	});

	it("merges recursively when an edit makes two groups identical", () => {
		const shared = buildSelection({ type: "PanoIds" });
		const b = buildSelection(filterA);
		const c = buildSelection(filterAEdited);
		const g1 = intersectSelections([shared, b], null)[0]; // Intersection(shared, b)
		const g2 = intersectSelections([shared, c], null)[0]; // Intersection(shared, c)
		const result = replaceSelection([g1, g2], c.key, filterA); // edit c -> b's value
		expect(result).toHaveLength(1);
		expect(result[0].key).toBe(g1.key); // g2 became g1 -> kept the pre-existing g1
	});
});

describe("sampleIds", () => {
	const ids = Array.from({ length: 20 }, (_, i) => i + 1);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns exactly n distinct ids drawn from the input", () => {
		const out = sampleIds(ids, 5);
		expect(out).toHaveLength(5);
		expect(new Set(out).size).toBe(5); // no duplicates
		for (const x of out) expect(ids).toContain(x);
	});

	it("clamps n to the input length", () => {
		const out = sampleIds(ids, 999);
		expect(out).toHaveLength(ids.length);
		expect(new Set(out)).toEqual(new Set(ids)); // a permutation of all ids
	});

	it("floors fractional counts", () => {
		expect(sampleIds(ids, 3.9)).toHaveLength(3);
	});

	it("returns an empty array for non-positive counts", () => {
		expect(sampleIds(ids, 0)).toEqual([]);
		expect(sampleIds(ids, -4)).toEqual([]);
	});

	it("does not mutate the input array", () => {
		const input = ids.slice();
		sampleIds(input, 10);
		expect(input).toEqual(ids);
	});

	it("is deterministic given a fixed RNG", () => {
		vi.spyOn(Math, "random").mockReturnValue(0); // always pick the first remaining element
		expect(sampleIds([10, 20, 30, 40], 2)).toEqual([10, 20]);
	});
});

describe("isolateGhostKeys", () => {
	const keys = ["a", "b", "c"];

	it("ghosts every key except the isolated one", () => {
		expect(isolateGhostKeys(keys, new Set(), "b")).toEqual(new Set(["a", "c"]));
	});

	it("un-isolates (empty set) when the key is already the sole visible one", () => {
		const isolated = new Set(["a", "c"]); // b is the only non-ghosted key
		expect(isolateGhostKeys(keys, isolated, "b")).toEqual(new Set());
	});

	it("re-isolates a different key when another is currently isolated", () => {
		const isolated = new Set(["a", "c"]); // b soloed
		expect(isolateGhostKeys(keys, isolated, "a")).toEqual(new Set(["b", "c"]));
	});

	it("makes a currently-ghosted key the visible one", () => {
		const ghosted = new Set(["b"]);
		expect(isolateGhostKeys(keys, ghosted, "b")).toEqual(new Set(["a", "c"]));
	});

	it("un-isolates a lone visible selection (no-op toward visible)", () => {
		expect(isolateGhostKeys(["a"], new Set(), "a")).toEqual(new Set());
	});
});

describe("polygonSelectionsContaining", () => {
	const square = (_key: string, ox: number, oy: number) =>
		buildSelection({
			type: "Polygon",
			polygon: {
				coordinates: [
					[
						[ox, oy],
						[ox + 2, oy],
						[ox + 2, oy + 2],
						[ox, oy + 2],
						[ox, oy],
					],
				],
				extraPolygons: null,
			},
			includeInformational: false,
		});

	it("returns keys of polygons containing the point (lng/lat order)", () => {
		const a = { ...square("a", 0, 0), key: "a" };
		const b = { ...square("b", 10, 10), key: "b" };
		// point at lng=1, lat=1 -> inside a only
		expect(polygonSelectionsContaining([a, b], 1, 1)).toEqual(["a"]);
	});

	it("returns every overlapping polygon", () => {
		const a = { ...square("a", 0, 0), key: "a" };
		const b = { ...square("b", 1, 1), key: "b" };
		expect(polygonSelectionsContaining([a, b], 1.5, 1.5).sort()).toEqual(["a", "b"]);
	});

	it("ignores non-Polygon selections and misses", () => {
		const a = { ...square("a", 0, 0), key: "a" };
		const tag = { ...buildSelection({ type: "Tag", tagId: 1 }), key: "t" };
		expect(polygonSelectionsContaining([a, tag], 50, 50)).toEqual([]);
	});

	it("matches inside an extraPolygons part (MultiPolygon)", () => {
		const sel = {
			...buildSelection({
				type: "Polygon",
				polygon: {
					coordinates: [
						[
							[0, 0],
							[2, 0],
							[2, 2],
							[0, 2],
							[0, 0],
						],
					],
					extraPolygons: [
						[
							[
								[10, 10],
								[12, 10],
								[12, 12],
								[10, 12],
								[10, 10],
							],
						],
					],
				},
				includeInformational: false,
			}),
			key: "multi",
		};
		expect(polygonSelectionsContaining([sel], 11, 11)).toEqual(["multi"]);
	});
});

describe("rewriteSelectionFields", () => {
	const filter = (field: string) =>
		buildSelection({ type: "Filter", field, test: { op: "eq", value: 1 } });

	it("rewrites a Filter field and regenerates its key", () => {
		const out = rewriteSelectionFields([filter("a")], "a", "b");
		expect(out).toHaveLength(1);
		expect((out[0].selector as { field: string }).field).toBe("b");
		expect(out[0].key).toBe("filter:b:eq:1");
	});

	it("leaves unrelated filters untouched", () => {
		const f = filter("c");
		const out = rewriteSelectionFields([f], "a", "b");
		expect(out[0].key).toBe(f.key);
	});

	it("drops a Filter when the field is deleted (to = null)", () => {
		expect(rewriteSelectionFields([filter("a")], "a", null)).toEqual([]);
	});

	it("rewrites filters nested in a composite", () => {
		const union = buildSelection({ type: "Union", selections: [filter("a"), filter("c")] });
		const out = rewriteSelectionFields([union], "a", "b");
		const children = (out[0].selector as { selections: { selector: { field: string } }[] })
			.selections;
		expect(children.map((c) => c.selector.field)).toEqual(["b", "c"]);
	});

	it("collapses a group to its sole survivor when a child is deleted", () => {
		const tag = buildSelection({ type: "Tag", tagId: 1 });
		const union = buildSelection({ type: "Union", selections: [filter("a"), tag] });
		const out = rewriteSelectionFields([union], "a", null);
		expect(out).toHaveLength(1);
		expect(out[0].selector.type).toBe("Tag");
	});
});
