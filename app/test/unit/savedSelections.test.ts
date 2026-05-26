/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import {
	selectionToSaved,
	savedToSelectionProps,
	describeRule,
	type SavedSelectionProps,
} from "@/store/savedSelections.add";
import type { MapData, Tag } from "@/types";
import type { Selection } from "@/store/selections";

function makeMap(tags: Record<number, Tag> = {}): MapData {
	return {
		meta: {
			id: "map1",
			name: "Test",
			description: "",
			folder: null,
			locationCount: 0,
			tags,
			settings: {
				pointAlongRoad: false,
				preferDirection: null,
				preferOfficial: false,
				preferHigherQuality: false,
				onlyOfficial: false,
				cameraTypes: null,
				defaultPanoId: false,
				exportZoom: false,
				exportUnpanned: false,
			},
			scoreBounds: "auto",
			createdAt: "",
			updatedAt: "",
		},
	};
}

function makeSel(props: Selection["props"]): Selection {
	return { key: "test", color: [100, 100, 100], props, count: 0 };
}

// ============================================================================
// selectionToSaved
// ============================================================================

describe("selectionToSaved", () => {
	it("converts Everything selection", () => {
		const result = selectionToSaved(makeSel({ type: "Everything" }), makeMap());
		expect(result).toEqual({ type: "Everything" });
	});

	it("converts Untagged selection", () => {
		const result = selectionToSaved(makeSel({ type: "Untagged" }), makeMap());
		expect(result).toEqual({ type: "Untagged" });
	});

	it("converts Unpanned selection", () => {
		const result = selectionToSaved(makeSel({ type: "Unpanned" }), makeMap());
		expect(result).toEqual({ type: "Unpanned" });
	});

	it("converts PanoIds selection", () => {
		const result = selectionToSaved(makeSel({ type: "PanoIds" }), makeMap());
		expect(result).toEqual({ type: "PanoIds" });
	});

	it("converts NotPanoIds selection", () => {
		const result = selectionToSaved(makeSel({ type: "NotPanoIds" }), makeMap());
		expect(result).toEqual({ type: "NotPanoIds" });
	});

	it("converts Duplicates selection with distance", () => {
		const result = selectionToSaved(
			makeSel({ type: "Duplicates", distance: 50 }),
			makeMap(),
		);
		expect(result).toEqual({ type: "Duplicates", distance: 50 });
	});

	it("converts Tag selection to TagName using map tag lookup", () => {
		const tags = { 7: { id: 7, name: "Mountains", color: "#ff0000", visible: true } };
		const result = selectionToSaved(
			makeSel({ type: "Tag", tagId: 7 }),
			makeMap(tags),
		);
		expect(result).toEqual({ type: "TagName", tagName: "Mountains" });
	});

	it("returns null for Tag selection with unknown tagId", () => {
		const result = selectionToSaved(
			makeSel({ type: "Tag", tagId: 999 }),
			makeMap(),
		);
		expect(result).toBeNull();
	});

	it("returns null for Manual selection (not saveable)", () => {
		const result = selectionToSaved(
			makeSel({ type: "Manual", locations: [1, 2, 3] }),
			makeMap(),
		);
		expect(result).toBeNull();
	});

	it("returns null for Locations selection (not saveable)", () => {
		const result = selectionToSaved(
			makeSel({ type: "Locations", locations: [1, 2], name: null }),
			makeMap(),
		);
		expect(result).toBeNull();
	});

	it("returns null for ValidationState selection (not saveable)", () => {
		const result = selectionToSaved(
			makeSel({ type: "ValidationState", locations: [1], state: 0 }),
			makeMap(),
		);
		expect(result).toBeNull();
	});

	it("converts Filter selection", () => {
		const result = selectionToSaved(
			makeSel({ type: "Filter", field: "altitude", op: "gt", value: 1000, value2: null }),
			makeMap(),
		);
		expect(result).toEqual({
			type: "Filter",
			field: "altitude",
			op: "gt",
			value: 1000,
			value2: null,
		});
	});

	it("converts Union of saveable children", () => {
		const tags = { 1: { id: 1, name: "A", color: "#aaa", visible: true } };
		const map = makeMap(tags);
		const sel = makeSel({
			type: "Union",
			selections: [
				{ key: "panoids", color: [0, 0, 0], props: { type: "PanoIds" }, count: 0 },
				{ key: "tag:1", color: [0, 0, 0], props: { type: "Tag", tagId: 1 }, count: 0 },
			],
		});
		const result = selectionToSaved(sel, map);
		expect(result).toEqual({
			type: "Union",
			selections: [
				{ type: "PanoIds" },
				{ type: "TagName", tagName: "A" },
			],
		});
	});

	it("returns null for composite where all children are unsaveable", () => {
		const sel = makeSel({
			type: "Intersection",
			selections: [
				{ key: "manual", color: [0, 0, 0], props: { type: "Manual", locations: [1] }, count: 0 },
			],
		});
		const result = selectionToSaved(sel, makeMap());
		expect(result).toBeNull();
	});
});

// ============================================================================
// savedToSelectionProps
// ============================================================================

describe("savedToSelectionProps", () => {
	it("resolves TagName to Tag using map lookup (case-insensitive)", () => {
		const tags = { 3: { id: 3, name: "Coastal", color: "#00f", visible: true } };
		const result = savedToSelectionProps({ type: "TagName", tagName: "coastal" }, makeMap(tags));
		expect(result).toEqual({ type: "Tag", tagId: 3 });
	});

	it("returns null for TagName when tag no longer exists", () => {
		const result = savedToSelectionProps({ type: "TagName", tagName: "Deleted" }, makeMap());
		expect(result).toBeNull();
	});

	it("passes through Everything unchanged", () => {
		const result = savedToSelectionProps({ type: "Everything" }, makeMap());
		expect(result).toEqual({ type: "Everything" });
	});

	it("passes through PanoIds unchanged", () => {
		const result = savedToSelectionProps({ type: "PanoIds" }, makeMap());
		expect(result).toEqual({ type: "PanoIds" });
	});

	it("passes through Filter unchanged", () => {
		const saved: SavedSelectionProps = {
			type: "Filter",
			field: "altitude",
			op: "between",
			value: 0,
			value2: 5000,
		};
		const result = savedToSelectionProps(saved, makeMap());
		expect(result).toEqual(saved);
	});

	it("returns null for composite with all unresolvable children", () => {
		const saved: SavedSelectionProps = {
			type: "Intersection",
			selections: [{ type: "TagName", tagName: "NoSuchTag" }],
		};
		const result = savedToSelectionProps(saved, makeMap());
		expect(result).toBeNull();
	});

	it("resolves composite with mixed resolvable/unresolvable children", () => {
		const tags = { 1: { id: 1, name: "Valid", color: "#aaa", visible: true } };
		const saved: SavedSelectionProps = {
			type: "Union",
			selections: [
				{ type: "TagName", tagName: "Valid" },
				{ type: "TagName", tagName: "Missing" },
			],
		};
		const result = savedToSelectionProps(saved, makeMap(tags));
		expect(result).not.toBeNull();
		expect(result!.type).toBe("Union");
		if (result!.type === "Union") {
			expect(result!.selections).toHaveLength(1);
			expect(result!.selections[0].props.type).toBe("Tag");
		}
	});
});

// ============================================================================
// describeRule
// ============================================================================

describe("describeRule", () => {
	it("describes Everything", () => {
		expect(describeRule({ type: "Everything" })).toBe("All");
	});

	it("describes TagName", () => {
		expect(describeRule({ type: "TagName", tagName: "Mountains" })).toBe("Tag: Mountains");
	});

	it("describes Untagged", () => {
		expect(describeRule({ type: "Untagged" })).toBe("Untagged");
	});

	it("describes Unpanned", () => {
		expect(describeRule({ type: "Unpanned" })).toBe("Unpanned");
	});

	it("describes PanoIds", () => {
		expect(describeRule({ type: "PanoIds" })).toBe("Has Pano ID");
	});

	it("describes NotPanoIds", () => {
		expect(describeRule({ type: "NotPanoIds" })).toBe("No Pano ID");
	});

	it("describes Duplicates with distance", () => {
		expect(describeRule({ type: "Duplicates", distance: 100 })).toBe("Dupes (100m)");
	});

	it("describes Filter", () => {
		expect(describeRule({ type: "Filter", field: "altitude", op: "gt", value: 500 })).toBe(
			"altitude gt 500",
		);
	});

	it("describes Polygon with name", () => {
		const polygon = { type: "Feature", geometry: {}, properties: { name: "Europe" } } as any;
		expect(describeRule({ type: "Polygon", polygon, includeInformational: false })).toBe("Europe");
	});

	it("describes Polygon without name", () => {
		const polygon = { type: "Feature", geometry: {}, properties: {} } as any;
		expect(describeRule({ type: "Polygon", polygon, includeInformational: false })).toBe("Polygon");
	});

	it("describes Intersection", () => {
		const result = describeRule({
			type: "Intersection",
			selections: [{ type: "PanoIds" }, { type: "Untagged" }],
		});
		expect(result).toBe("Has Pano ID AND Untagged");
	});

	it("describes Union", () => {
		const result = describeRule({
			type: "Union",
			selections: [{ type: "TagName", tagName: "A" }, { type: "TagName", tagName: "B" }],
		});
		expect(result).toBe("Tag: A OR Tag: B");
	});

	it("describes Invert", () => {
		const result = describeRule({
			type: "Invert",
			selections: [{ type: "Everything" }],
		});
		expect(result).toBe("NOT (All)");
	});
});
