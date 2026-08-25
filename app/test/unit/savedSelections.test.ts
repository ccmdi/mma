import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { SavedSelection, Selection, Selector } from "@/bindings.gen";

// The store binds tag lookups internally; back them with a settable fake tag set. The
// Rust table is a plain array here, so the module's cache/refresh path is exercised.
const h = vi.hoisted(() => ({
	tags: {} as Record<number, { id: number; name: string; color: string; visible: boolean }>,
	rows: [] as SavedSelection[],
	added: [] as Selector[][],
	calls: [] as string[],
}));

vi.mock("@/store/useMapStore", () => ({
	addSelections: (selectors: Selector[]) => h.added.push(selectors),
	getTag: (id: number) => h.tags[id],
	getVisibleTags: () => Object.values(h.tags).filter((t) => t.visible !== false),
}));
vi.mock("@/store/settings", () => ({ getSettings: () => ({}) }));
vi.mock("@/lib/util/log", () => ({
	log: { warn: vi.fn(), error: vi.fn() },
	fireAndForget: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeListSavedSelections: async () => {
			h.calls.push("list");
			return h.rows.map(({ id, name, color, createdAt }) => ({ id, name, color, createdAt }));
		},
		storeGetSavedSelections: async (ids: string[]) => {
			h.calls.push(`get:${ids.join(",")}`);
			return structuredClone(h.rows.filter((r) => ids.includes(r.id)));
		},
		storeSaveSelection: async (
			name: string,
			selector: Selector,
			tagNames: Record<number, string>,
			color: [number, number, number],
		) => {
			const row = { id: `s${h.rows.length + 1}`, name, selector, tagNames, color, createdAt: "" };
			h.rows.push(row);
			return row;
		},
		storeDeleteSavedSelection: async (id: string) => {
			h.rows = h.rows.filter((r) => r.id !== id);
		},
		storeImportLegacySavedSelections: async () => 0,
	},
}));

import {
	MAP_LOCAL_TYPES,
	applySavedSelection,
	deleteSavedSelection,
	getSavedSelectionIndex,
	isSaveable,
	loadAllSavedSelections,
	loadSavedSelections,
	saveCurrentSelections,
	savedParts,
	savedSelector,
} from "@/store/savedSelections";
import { buildSelection } from "@/store/selections";

/** Matches nothing: what a `Tag` leaf resolves to when its saved name is gone here. */
const NOTHING: Selector = { type: "Locations", locations: [], name: null };

const rule = (selector: Selector, tagNames: Record<number, string> = {}): SavedSelection => ({
	id: "s1",
	name: "rule",
	selector,
	tagNames,
	color: [1, 2, 3],
	createdAt: "2026-01-01T00:00:00.000Z",
});

const sel = (selector: Selector, color: [number, number, number] = [0, 0, 0]): Selection => ({
	...buildSelection(selector),
	color,
});

beforeEach(async () => {
	h.tags = {};
	h.rows = [];
	h.added = [];
	h.calls = [];
	// Drop any index/bodies the previous test left behind.
	await loadAllSavedSelections();
	h.calls = [];
});

// ============================================================================
// INVARIANT: saved selections are global name-based rules, resolved fresh against
// the open map. The stored tree is never rewritten -- a tag rename on one map only
// changes what the rule resolves to there, and a rule whose tag is missing stays a
// whole rule with one dead leaf.
// ============================================================================

describe("saved selections survive map-local renames untouched", () => {
	const deepFreeze = <T>(obj: T): T => {
		if (obj && typeof obj === "object") {
			Object.values(obj).forEach(deepFreeze);
			Object.freeze(obj);
		}
		return obj;
	};

	it("a Tag leaf tracks the current map's tags by name, not by stored id", () => {
		const saved = deepFreeze(rule({ type: "Tag", tagId: 5 }, { 5: "Japan" }));

		// The name resolves to a different id here: the leaf follows the name.
		h.tags = { 9: { id: 9, name: "japan", color: "#0f0", visible: true } };
		expect(savedParts(saved)[0].selector).toEqual({ type: "Tag", tagId: 9 });

		// Renamed away: the rule is not rewritten, its leaf just stops matching.
		h.tags = { 9: { id: 9, name: "Asia/Japan", color: "#0f0", visible: true } };
		expect(savedParts(saved)[0].selector).toEqual(NOTHING);
		expect(saved.selector).toEqual({ type: "Tag", tagId: 5 });
	});

	it("a soft-deleted tag is never resurrected by name", () => {
		h.tags = { 3: { id: 3, name: "Coastal", color: "#00f", visible: false } };
		const saved = rule({ type: "Tag", tagId: 3 }, { 3: "Coastal" });
		expect(savedParts(saved)[0].selector).toEqual(NOTHING);
	});

	it("a dead leaf leaves the composite around it intact", () => {
		h.tags = { 1: { id: 1, name: "Valid", color: "#aaa", visible: true } };
		const saved = rule(
			{
				type: "Intersection",
				selections: [sel({ type: "Tag", tagId: 7 }), sel({ type: "Tag", tagId: 8 })],
			},
			{ 7: "Valid", 8: "Gone" },
		);
		const resolved = savedParts(saved)[0].selector;
		expect(resolved.type).toBe("Intersection");
		if (resolved.type !== "Intersection") return;
		expect(resolved.selections.map((c) => c.selector)).toEqual([
			{ type: "Tag", tagId: 1 },
			NOTHING,
		]);
	});

	it("a Filter rule outlives its field's deletion in the current map", () => {
		// JS holds no field registry per rule: the Filter passes through verbatim and Rust
		// treats a missing field as non-matching. Deletion must not drop the rule.
		const selector: Selector = { type: "Filter", field: "deleted-everywhere", op: "eq", value: 1 };
		expect(savedParts(rule(selector))[0].selector).toEqual(selector);
	});

	it("labels a missing tag with the name it was saved under", () => {
		const saved = rule({ type: "Tag", tagId: 5 }, { 5: "Japan" });
		expect(savedParts(saved)[0].label).toBe("Tag: Japan");
	});
});

// ============================================================================
// isSaveable
// ============================================================================

describe("isSaveable", () => {
	it("accepts portable leaves", () => {
		expect(isSaveable({ type: "Everything" })).toBe(true);
		expect(isSaveable({ type: "Tag", tagId: 1 })).toBe(true);
		expect(isSaveable({ type: "Duplicates", distance: 50 })).toBe(true);
	});

	it("rejects every map-local leaf", () => {
		expect(isSaveable({ type: "Locations", locations: [1], name: null })).toBe(false);
		expect(isSaveable({ type: "Manual", locations: [1] })).toBe(false);
		expect(isSaveable({ type: "ValidationState", locations: [1], state: 0 })).toBe(false);
		expect(isSaveable({ type: "Reviewed", locations: [1], sessionId: "s", mode: "reviewed" })).toBe(
			false,
		);
	});

	it("rejects a composite that hides a map-local leaf at any depth", () => {
		const reviewed: Selector = {
			type: "Reviewed",
			locations: [1, 2, 3],
			sessionId: "session-1",
			mode: "unreviewed",
		};
		const nested: Selector = {
			type: "Union",
			selections: [
				sel({ type: "Untagged" }),
				sel({ type: "Intersection", selections: [sel(reviewed)] }),
			],
		};
		expect(isSaveable(nested)).toBe(false);
	});
});

// ============================================================================
// INVARIANT: every generated Selector variant is either named map-local (never
// saved) or fully saveable and describable. A new Rust variant is saveable by
// default, so it must not be able to slip through unhandled.
// ============================================================================

describe("Selector coverage", () => {
	const SAMPLES: Record<string, Selector> = {
		Locations: { type: "Locations", locations: [1], name: null },
		Everything: { type: "Everything" },
		Polygon: {
			type: "Polygon",
			polygon: {
				coordinates: [
					[
						[0, 0],
						[1, 0],
						[1, 1],
					],
				],
				properties: { name: "P" },
			},
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
		Intersection: { type: "Intersection", selections: [sel({ type: "Everything" })] },
		Union: { type: "Union", selections: [sel({ type: "Everything" })] },
		Invert: { type: "Invert", selections: [sel({ type: "Everything" })] },
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
			const mapLocal = (MAP_LOCAL_TYPES as readonly string[]).includes(type);
			expect(isSaveable(SAMPLES[type]), `${type} saveability`).toBe(!mapLocal);
			if (mapLocal) continue;
			const [part] = savedParts(rule(SAMPLES[type]));
			expect(typeof part.label, `${type} is describable`).toBe("string");
			expect(part.label.length).toBeGreaterThan(0);
		}
	});

	it("a Reviewed session id can never reach storage", async () => {
		const reviewed: Selector = {
			type: "Reviewed",
			locations: [1, 2, 3],
			sessionId: "session-1",
			mode: "unreviewed",
		};
		expect(
			await saveCurrentSelections("mixed", [sel(reviewed), sel({ type: "Untagged" })]),
		).toBe(true);
		expect(JSON.stringify(h.rows)).not.toContain("session-1");
		expect(h.rows[0].selector).toEqual({ type: "Untagged" });
	});
});

// ============================================================================
// Save / apply round trip
// ============================================================================

describe("saveCurrentSelections", () => {
	it("stores one selection as itself and its tag names beside it", async () => {
		h.tags = { 4: { id: 4, name: "Japan", color: "#f00", visible: true } };
		expect(await saveCurrentSelections("japan", [sel({ type: "Tag", tagId: 4 }, [9, 9, 9])])).toBe(
			true,
		);
		expect(h.rows[0]).toMatchObject({
			name: "japan",
			selector: { type: "Tag", tagId: 4 },
			tagNames: { 4: "Japan" },
			color: [9, 9, 9],
		});
	});

	it("unions several selections into one rule, keeping their colors", async () => {
		await saveCurrentSelections("two", [
			sel({ type: "Untagged" }, [1, 1, 1]),
			sel({ type: "Unpanned" }, [2, 2, 2]),
		]);
		const parts = savedParts(h.rows[0]);
		expect(parts.map((p) => p.selector.type)).toEqual(["Untagged", "Unpanned"]);
		expect(parts.map((p) => p.color)).toEqual([
			[1, 1, 1],
			[2, 2, 2],
		]);
	});

	it("captures tag names from every depth of the tree", async () => {
		h.tags = {
			1: { id: 1, name: "A", color: "#a", visible: true },
			2: { id: 2, name: "B", color: "#b", visible: true },
		};
		await saveCurrentSelections("nested", [
			sel({
				type: "Intersection",
				selections: [sel({ type: "Tag", tagId: 1 }), sel({ type: "Tag", tagId: 2 })],
			}),
		]);
		expect(h.rows[0].tagNames).toEqual({ 1: "A", 2: "B" });
	});

	it("refuses a save with nothing saveable in it", async () => {
		expect(await saveCurrentSelections("nope", [sel({ type: "Manual", locations: [1] })])).toBe(
			false,
		);
		expect(h.rows).toHaveLength(0);
	});
});

describe("applySavedSelection", () => {
	it("adds one selection per saved part", () => {
		h.tags = { 9: { id: 9, name: "Japan", color: "#f00", visible: true } };
		const saved = rule(
			{ type: "Union", selections: [sel({ type: "Tag", tagId: 5 }), sel({ type: "Untagged" })] },
			{ 5: "Japan" },
		);
		expect(applySavedSelection(saved)).toBe(2);
		expect(h.added[0]).toEqual([{ type: "Tag", tagId: 9 }, { type: "Untagged" }]);
	});

	it("adds a non-union rule as a single selection", () => {
		expect(applySavedSelection(rule({ type: "Untagged" }))).toBe(1);
		expect(h.added[0]).toEqual([{ type: "Untagged" }]);
	});
});

describe("the index and the bodies", () => {
	it("follows saves and deletes", async () => {
		expect(getSavedSelectionIndex()).toEqual([]);
		await saveCurrentSelections("a", [sel({ type: "Untagged" })]);
		await saveCurrentSelections("b", [sel({ type: "Unpanned" })]);
		expect(getSavedSelectionIndex().map((s) => s.name)).toEqual(["a", "b"]);

		await deleteSavedSelection(getSavedSelectionIndex()[0].id);
		expect(getSavedSelectionIndex().map((s) => s.name)).toEqual(["b"]);
	});

	it("never reads a body just to list the rules", async () => {
		h.rows = [rule({ type: "Untagged" })];
		await loadAllSavedSelections();
		h.calls = [];

		getSavedSelectionIndex();
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual([]);
	});

	it("fetches a body once and reuses it", async () => {
		h.rows = [rule({ type: "Untagged" })];
		await loadSavedSelections(["s1"]);
		await loadSavedSelections(["s1"]);
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual(["get:s1"]);
	});

	it("does not re-request a rule that is not there", async () => {
		await loadSavedSelections(["ghost"]);
		await loadSavedSelections(["ghost"]);
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual(["get:ghost"]);
	});
});

describe("savedSelector", () => {
	it("matches nothing until the body arrives, then resolves it", async () => {
		h.rows = [rule({ type: "Untagged" })];
		// First read only knows the id: it starts the fetch and matches nothing meanwhile.
		expect(savedSelector("s1")).toEqual(NOTHING);
		await loadSavedSelections(["s1"]);
		expect(savedSelector("s1")).toEqual({ type: "Untagged" });
	});

	it("is the whole rule as one resolved Selector", async () => {
		await saveCurrentSelections("two", [sel({ type: "Untagged" }), sel({ type: "Unpanned" })]);
		const selector = savedSelector(getSavedSelectionIndex()[0].id);
		expect(selector.type).toBe("Union");
		if (selector.type !== "Union") return;
		expect(selector.selections.map((c) => c.selector.type)).toEqual(["Untagged", "Unpanned"]);
	});

	it("matches nothing for an unknown id", () => {
		expect(savedSelector("nope")).toEqual(NOTHING);
	});
});
