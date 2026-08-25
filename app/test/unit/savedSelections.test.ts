/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// The store binds tag lookups internally; back them with a settable fake tag set.
const h = vi.hoisted(() => ({
	tags: {} as Record<number, { id: number; name: string; color: string; visible: boolean }>,
	saved: [] as unknown[],
	resolve: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("@/store/useMapStore", () => ({
	addSelections: vi.fn(),
	getTag: (id: number) => h.tags[id],
	getVisibleTags: () => Object.values(h.tags).filter((t) => t.visible !== false),
	resolveIds: (selector: unknown) => h.resolve(selector),
}));
vi.mock("@/store/settings", () => ({
	getSettings: () => ({ savedSelections: h.saved }),
	setSetting: vi.fn(),
}));

import {
	selectorToSaved,
	savedToSelector,
	describeRule,
	savedSelector,
	MAP_LOCAL_TYPES,
	type SavedSelection,
	type SavedSelectionProps,
} from "@/store/savedSelections";
import type { Selection } from "@/bindings.gen";

beforeEach(() => {
	h.tags = {};
	h.saved = [];
	h.resolve = vi.fn();
});

// ============================================================================
// INVARIANT: saved selections are global name-based rules, resolved fresh
// against the open map. Map-local renames/deletes never rewrite them — an
// unresolvable rule is skipped at resolution, never mutated or dropped.
// ============================================================================

describe("saved selections survive map-local renames untouched", () => {
	const deepFreeze = <T>(obj: T): T => {
		if (obj && typeof obj === "object") {
			Object.values(obj).forEach(deepFreeze);
			Object.freeze(obj);
		}
		return obj;
	};

	it("a TagName rule tracks the current map's tags, not a snapshot", () => {
		const rule = deepFreeze<SavedSelectionProps>({ type: "TagName", tagName: "Japan" });

		h.tags = { 1: { id: 1, name: "Japan", color: "#f00", visible: true } };
		expect(savedToSelector(rule)).toEqual({ type: "Tag", tagId: 1 });

		// Rename in the "current map": the rule is not rewritten, it just stops resolving.
		h.tags = { 1: { id: 1, name: "Asia/Japan", color: "#f00", visible: true } };
		expect(savedToSelector(rule)).toBeNull();
		expect(rule).toEqual({ type: "TagName", tagName: "Japan" });

		// A map where the name exists (or the rename is undone) resolves again.
		h.tags = { 9: { id: 9, name: "japan", color: "#0f0", visible: true } };
		expect(savedToSelector(rule)).toEqual({ type: "Tag", tagId: 9 });
	});

	it("a Filter rule outlives its field's deletion in the current map", () => {
		// JS holds no field registry per rule: the Filter passes through verbatim and
		// Rust treats a missing field as non-matching. Deletion must not drop the rule.
		const rule = deepFreeze<SavedSelectionProps>({
			type: "Filter",
			field: "deleted-everywhere",
			op: "eq",
			value: 1,
		});
		expect(savedToSelector(rule)).toEqual(rule);
	});

	it("resolution never mutates the saved definition", () => {
		const saved: SavedSelection = deepFreeze({
			id: "s1",
			name: "n",
			items: [
				{ props: { type: "TagName", tagName: "Gone" }, color: [0, 0, 0] },
				{ props: { type: "Untagged" }, color: [0, 0, 0] },
			],
		} as SavedSelection);
		h.saved = [saved];
		expect(savedSelector("s1")).toEqual({
			type: "Union",
			selections: [expect.objectContaining({ selector: { type: "Untagged" } })],
		});
		expect(saved.items).toHaveLength(2);
	});
});

// ============================================================================
// selectorToSaved
// ============================================================================

describe("selectorToSaved", () => {
	it("converts Everything selection", () => {
		const result = selectorToSaved({ type: "Everything" });
		expect(result).toEqual({ type: "Everything" });
	});

	it("converts Untagged selection", () => {
		const result = selectorToSaved({ type: "Untagged" });
		expect(result).toEqual({ type: "Untagged" });
	});

	it("converts Unpanned selection", () => {
		const result = selectorToSaved({ type: "Unpanned" });
		expect(result).toEqual({ type: "Unpanned" });
	});

	it("converts PanoIds selection", () => {
		const result = selectorToSaved({ type: "PanoIds" });
		expect(result).toEqual({ type: "PanoIds" });
	});

	it("converts NotPanoIds selection", () => {
		const result = selectorToSaved({ type: "NotPanoIds" });
		expect(result).toEqual({ type: "NotPanoIds" });
	});

	it("converts Duplicates selection with distance", () => {
		const result = selectorToSaved({ type: "Duplicates", distance: 50 });
		expect(result).toEqual({ type: "Duplicates", distance: 50 });
	});

	it("converts Tag selection to TagName using map tag lookup", () => {
		h.tags = { 7: { id: 7, name: "Mountains", color: "#ff0000", visible: true } };
		const result = selectorToSaved({ type: "Tag", tagId: 7 });
		expect(result).toEqual({ type: "TagName", tagName: "Mountains" });
	});

	it("returns null for Tag selection with unknown tagId", () => {
		const result = selectorToSaved({ type: "Tag", tagId: 999 });
		expect(result).toBeNull();
	});

	it("returns null for Manual selection (not saveable)", () => {
		const result = selectorToSaved({ type: "Manual", locations: [1, 2, 3] });
		expect(result).toBeNull();
	});

	it("returns null for Locations selection (not saveable)", () => {
		const result = selectorToSaved({ type: "Locations", locations: [1, 2], name: null });
		expect(result).toBeNull();
	});

	it("returns null for ValidationState selection (not saveable)", () => {
		const result = selectorToSaved({ type: "ValidationState", locations: [1], state: 0 });
		expect(result).toBeNull();
	});

	it("converts Filter selection", () => {
		const result = selectorToSaved({
			type: "Filter",
			field: "altitude",
			op: "gt",
			value: 1000,
			value2: null,
		});
		expect(result).toEqual({
			type: "Filter",
			field: "altitude",
			op: "gt",
			value: 1000,
			value2: null,
		});
	});

	it("converts Union of saveable children", () => {
		h.tags = { 1: { id: 1, name: "A", color: "#aaa", visible: true } };
		const sel: Selection["selector"] = {
			type: "Union",
			selections: [
				{ key: "panoids", color: [0, 0, 0], selector: { type: "PanoIds" } },
				{ key: "tag:1", color: [0, 0, 0], selector: { type: "Tag", tagId: 1 } },
			],
		};
		const result = selectorToSaved(sel);
		expect(result).toEqual({
			type: "Union",
			selections: [{ type: "PanoIds" }, { type: "TagName", tagName: "A" }],
		});
	});

	it("returns null for composite where all children are unsaveable", () => {
		const sel: Selection["selector"] = {
			type: "Intersection",
			selections: [
				{ key: "manual", color: [0, 0, 0], selector: { type: "Manual", locations: [1] } },
			],
		};
		const result = selectorToSaved(sel);
		expect(result).toBeNull();
	});
});

// ============================================================================
// savedToSelector
// ============================================================================

describe("savedToSelector", () => {
	it("resolves TagName to Tag using map lookup (case-insensitive)", () => {
		h.tags = { 3: { id: 3, name: "Coastal", color: "#00f", visible: true } };
		const result = savedToSelector({ type: "TagName", tagName: "coastal" });
		expect(result).toEqual({ type: "Tag", tagId: 3 });
	});

	it("returns null for TagName when tag no longer exists", () => {
		const result = savedToSelector({ type: "TagName", tagName: "Deleted" });
		expect(result).toBeNull();
	});

	it("passes through Everything unchanged", () => {
		const result = savedToSelector({ type: "Everything" });
		expect(result).toEqual({ type: "Everything" });
	});

	it("passes through PanoIds unchanged", () => {
		const result = savedToSelector({ type: "PanoIds" });
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
		const result = savedToSelector(saved);
		expect(result).toEqual(saved);
	});

	it("returns null for composite with all unresolvable children", () => {
		const saved: SavedSelectionProps = {
			type: "Intersection",
			selections: [{ type: "TagName", tagName: "NoSuchTag" }],
		};
		const result = savedToSelector(saved);
		expect(result).toBeNull();
	});

	it("resolves composite with mixed resolvable/unresolvable children", () => {
		h.tags = { 1: { id: 1, name: "Valid", color: "#aaa", visible: true } };
		const saved: SavedSelectionProps = {
			type: "Union",
			selections: [
				{ type: "TagName", tagName: "Valid" },
				{ type: "TagName", tagName: "Missing" },
			],
		};
		const result = savedToSelector(saved);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("Union");
		if (result!.type === "Union") {
			expect(result!.selections).toHaveLength(1);
			expect(result!.selections[0].selector.type).toBe("Tag");
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
			selections: [
				{ type: "TagName", tagName: "A" },
				{ type: "TagName", tagName: "B" },
			],
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

// ============================================================================
// INVARIANT: every generated Selector variant is either named map-local
// (never saved) or fully saveable — convertible and describable. A new Rust
// variant is saveable by default, so it must not be able to slip through
// unhandled.
// ============================================================================

describe("Selector coverage", () => {
	const SAMPLES: Record<string, Selection["selector"]> = {
		Locations: { type: "Locations", locations: [1], name: null },
		Everything: { type: "Everything" },
		Polygon: {
			type: "Polygon",
			polygon: { type: "Feature", geometry: {}, properties: { name: "P" } } as any,
			includeInformational: false,
		},
		Tag: { type: "Tag", tagId: 1 },
		Untagged: { type: "Untagged" },
		Unpanned: { type: "Unpanned" },
		PanoIds: { type: "PanoIds" },
		NotPanoIds: { type: "NotPanoIds" },
		Uncommitted: { type: "Uncommitted" },
		Manual: { type: "Manual", locations: [1] },
		Duplicates: { type: "Duplicates", distance: 25 },
		ValidationState: { type: "ValidationState", locations: [1], state: 0 },
		Reviewed: { type: "Reviewed", locations: [1], sessionId: "s", mode: "reviewed" },
		Intersection: {
			type: "Intersection",
			selections: [{ key: "e", color: [0, 0, 0], selector: { type: "Everything" } }],
		},
		Union: {
			type: "Union",
			selections: [{ key: "e", color: [0, 0, 0], selector: { type: "Everything" } }],
		},
		Invert: {
			type: "Invert",
			selections: [{ key: "e", color: [0, 0, 0], selector: { type: "Everything" } }],
		},
		Filter: { type: "Filter", field: "altitude", op: "gt", value: 1, tzLocal: true },
		TopK: { type: "TopK", field: "altitude", k: 5, ascending: false },
	};

	// Read the variants off the generated union so a new Rust variant fails here. A
	// doc-commented variant wraps onto its own line, so read the whole declaration
	// block rather than its first line.
	const generatedTypes = (): string[] => {
		const src = readFileSync(new URL("../../src/bindings.gen.ts", import.meta.url), "utf8");
		const decl = src.slice(src.indexOf("export type Selector =")).split("\n\n")[0];
		return [...decl.matchAll(/type: "(\w+)"/g)].map((m) => m[1]);
	};

	it("has a sample for every generated variant", () => {
		expect(generatedTypes().sort()).toEqual(Object.keys(SAMPLES).sort());
	});

	it("every variant is map-local or saveable and describable", () => {
		h.tags = { 1: { id: 1, name: "T", color: "#fff", visible: true } };
		for (const type of generatedTypes()) {
			const saved = selectorToSaved(SAMPLES[type]);
			if ((MAP_LOCAL_TYPES as readonly string[]).includes(type)) {
				expect(saved, `${type} is map-local`).toBeNull();
				continue;
			}
			expect(saved, `${type} is saveable`).not.toBeNull();
			const desc = describeRule(saved!);
			expect(typeof desc, `${type} is describable`).toBe("string");
			expect(desc.length).toBeGreaterThan(0);
		}
	});

	it("Reviewed never persists a session snapshot", () => {
		const reviewed: Selection["selector"] = {
			type: "Reviewed",
			locations: [1, 2, 3],
			sessionId: "session-1",
			mode: "unreviewed",
		};
		expect(selectorToSaved(reviewed)).toBeNull();

		// Nor smuggled in through a composite: the composite drops to null with it.
		const composite: Selection["selector"] = {
			type: "Union",
			selections: [{ key: "rev", color: [0, 0, 0], selector: reviewed }],
		};
		expect(selectorToSaved(composite)).toBeNull();

		const mixed = selectorToSaved({
			type: "Union",
			selections: [
				{ key: "rev", color: [0, 0, 0], selector: reviewed },
				{ key: "untagged", color: [0, 0, 0], selector: { type: "Untagged" } },
			],
		});
		expect(mixed).toEqual({ type: "Union", selections: [{ type: "Untagged" }] });
		expect(JSON.stringify(mixed)).not.toContain("session-1");
	});
});

// ============================================================================
// savedSelector
// ============================================================================

describe("savedSelector", () => {
	const entry = (items: SavedSelectionProps[]): SavedSelection => ({
		id: "s1",
		name: "n",
		items: items.map((props) => ({ props, color: [0, 0, 0] as [number, number, number] })),
		createdAt: 0,
	});

	const types = (sel: Selector) =>
		sel.type === "Union" ? sel.selections.map((c) => c.selector.type) : [sel.type];

	it("unions every item", () => {
		h.saved = [entry([{ type: "Untagged" }, { type: "Unpanned" }])];
		expect(types(savedSelector("s1"))).toEqual(["Untagged", "Unpanned"]);
	});

	it("skips items that no longer resolve", () => {
		h.saved = [entry([{ type: "TagName", tagName: "gone" }, { type: "Untagged" }])];
		expect(types(savedSelector("s1"))).toEqual(["Untagged"]);
	});

	it("is an empty union for an unknown id", () => {
		expect(savedSelector("nope")).toEqual({ type: "Union", selections: [] });
	});
});
