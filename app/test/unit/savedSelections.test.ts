import { selectionFixture } from "./fixtures/selection";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { SavedSelection, Selection } from "@/bindings.gen";
import type { Selector } from "@/types";

// The store binds tag lookups internally; back them with a settable fake tag set. The
// Rust table is a plain array here, so the module's cache/refresh path is exercised.
const h = vi.hoisted(() => ({
	tags: {} as Record<number, { id: number; name: string; color: string; visible: boolean }>,
	rows: [] as SavedSelection[],
	added: [] as string[],
	calls: [] as string[],
}));

vi.mock("@/store/store", () => ({
	Store: {
		get: () => ({ fieldDefs: {} }),
	},
}));
vi.mock("@/store/tag", () => ({
	Tag: {
		get: (id: number) => h.tags[id],
		visible: () => Object.values(h.tags).filter((t) => t.visible !== false),
	},
}));
vi.mock("@/store/mutation", () => ({
	Mutation: {
		run: (fn: () => Promise<unknown>) => fn(),
	},
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
		storeApplySavedSelection: async (id: string) => {
			h.added.push(id);
			return { mutation: { version: 0, keys: [] } };
		},
		storeSaveSelection: async (
			name: string,
			selector: Selector,
			color: [number, number, number],
		) => {
			const row = {
				id: `s${h.rows.length + 1}`,
				name,
				selector: selectionFixture(selector).selector,
				tagNames: {},
				color,
				createdAt: "",
			};
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
} from "@/store/savedSelections";
import { tagSelector, unpannedSelector, untaggedSelector } from "@/store/selections";

const rule = (selector: Selector, tagNames: Record<number, string> = {}): SavedSelection => ({
	id: "s1",
	name: "rule",
	selector: selectionFixture(selector).selector,
	tagNames,
	color: [1, 2, 3],
	createdAt: "2026-01-01T00:00:00.000Z",
});

const sel = (selector: Selector, color: [number, number, number] = [0, 0, 0]): Selection => ({
	...selectionFixture(selector),
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
	it("a Filter rule outlives its field's deletion in the current map", () => {
		// JS holds no field registry per rule: the Filter passes through verbatim and Rust
		// treats a missing field as non-matching. Deletion must not drop the rule.
		const selector: Selector = {
			type: "Filter",
			field: "deleted-everywhere",
			test: { op: "eq", value: 1 },
		};
		expect(savedParts(rule(selector))[0].selector).toEqual(selector);
	});

	it("labels a missing tag with the name it was saved under", () => {
		const saved = rule(tagSelector(5), { 5: "Japan" });
		expect(savedParts(saved)[0].label).toBe("Tag: Japan");
	});
});

// ============================================================================
// isSaveable
// ============================================================================

describe("isSaveable", () => {
	it("accepts portable leaves", () => {
		expect(isSaveable({ type: "Everything" })).toBe(true);
		expect(isSaveable(tagSelector(1))).toBe(true);
		expect(isSaveable({ type: "Duplicates", distance: 50 })).toBe(true);
	});

	it("rejects every map-local leaf", () => {
		expect(isSaveable({ type: "Locations", locations: [1], name: null })).toBe(false);
		expect(isSaveable({ type: "Manual", locations: [1] })).toBe(false);
		expect(isSaveable({ type: "Validation", locations: [1], category: "valid" })).toBe(false);
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
				sel(untaggedSelector()),
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
				extraPolygons: null,
				properties: { name: "P" },
			},
		},
		Uncommitted: { type: "Uncommitted" },
		Selected: { type: "Selected" },
		Manual: { type: "Manual", locations: [1] },
		Duplicates: { type: "Duplicates", distance: 25 },
		Validation: { type: "Validation", locations: [1], category: "valid" },
		Reviewed: { type: "Reviewed", locations: [1], sessionId: "s", mode: "reviewed" },
		Intersection: { type: "Intersection", selections: [sel({ type: "Everything" })] },
		Union: { type: "Union", selections: [sel({ type: "Everything" })] },
		Invert: { type: "Invert", selections: [sel({ type: "Everything" })] },
		Filter: { type: "Filter", field: "altitude", test: { op: "gt", value: 1, tzLocal: true } },
		Ranked: {
			type: "Ranked",
			selection: sel({ type: "Filter", field: "altitude", test: { op: "has" } }),
			expr: "altitude",
			k: 5,
			ascending: false,
		},
		Sample: { type: "Sample", selection: null, n: 5 },
		Spaced: { type: "Spaced", selection: null, thin: { by: "count", n: 5 } },
		EvenlySpaced: { type: "EvenlySpaced", selection: null, thin: { by: "metres", m: 100 } },
		Nearby: { type: "Nearby", selection: null, lat: 1, lng: 2, radiusM: 50 },
		Nearest: { type: "Nearest", selection: null, lat: 1, lng: 2 },
	};

	// Read the variants off the generated union so a new Rust variant fails here. A
	// doc-commented variant wraps onto its own line, so read the whole declaration
	// block rather than its first line.
	const generatedTypes = (): string[] => {
		const src = readFileSync(new URL("../../src/bindings.gen.ts", import.meta.url), "utf8");
		const decl = src.slice(src.indexOf("export type Selector<")).split("\n\n")[0];
		return [...decl.matchAll(/type: "(\w+)"/g)].map((m) => m[1]);
	};

	it("sees a child a selector wraps outside a `selections` list", () => {
		// Ranked holds one child under `selection`; a walk that only knew `selections`
		// would call a map-local tree saveable.
		expect(
			isSaveable({
				type: "Ranked",
				selection: sel({ type: "Manual", locations: [1] }),
				expr: "altitude",
				k: null,
				ascending: false,
			}),
		).toBe(false);
	});

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
		expect(await saveCurrentSelections("mixed", [sel(reviewed), sel(untaggedSelector())])).toBe(
			true,
		);
		expect(JSON.stringify(h.rows)).not.toContain("session-1");
		expect(h.rows[0].selector).toEqual(untaggedSelector());
	});
});

// ============================================================================
// Save / apply round trip
// ============================================================================

describe("saveCurrentSelections", () => {
	it("sends the rule and requested color to Rust", async () => {
		h.tags = { 4: { id: 4, name: "Japan", color: "#f00", visible: true } };
		expect(await saveCurrentSelections("japan", [sel(tagSelector(4), [9, 9, 9])])).toBe(true);
		expect(h.rows[0]).toMatchObject({
			name: "japan",
			selector: tagSelector(4),
			tagNames: {},
			color: [9, 9, 9],
		});
	});

	it("unions several selections into one rule, keeping their colors", async () => {
		await saveCurrentSelections("two", [
			sel(untaggedSelector(), [1, 1, 1]),
			sel(unpannedSelector(), [2, 2, 2]),
		]);
		const parts = savedParts(h.rows[0]);
		expect(parts.map((p) => p.selector.type)).toEqual(["Filter", "Filter"]);
		expect(parts.map((p) => p.color)).toEqual([
			[1, 1, 1],
			[2, 2, 2],
		]);
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
			{ type: "Union", selections: [sel(tagSelector(5)), sel(untaggedSelector())] },
			{ 5: "Japan" },
		);
		expect(applySavedSelection(saved)).toBe(2);
		expect(h.added[0]).toBe(saved.id);
	});

	it("adds a non-union rule as a single selection", () => {
		expect(applySavedSelection(rule(untaggedSelector()))).toBe(1);
		expect(h.added[0]).toBe("s1");
	});
});

describe("the index and the bodies", () => {
	it("follows saves and deletes", async () => {
		expect(getSavedSelectionIndex()).toEqual([]);
		await saveCurrentSelections("a", [sel(untaggedSelector())]);
		await saveCurrentSelections("b", [sel(unpannedSelector())]);
		expect(getSavedSelectionIndex().map((s) => s.name)).toEqual(["a", "b"]);

		await deleteSavedSelection(getSavedSelectionIndex()[0].id);
		expect(getSavedSelectionIndex().map((s) => s.name)).toEqual(["b"]);
	});

	it("never reads a body just to list the rules", async () => {
		h.rows = [rule(untaggedSelector())];
		await loadAllSavedSelections();
		h.calls = [];

		getSavedSelectionIndex();
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual([]);
	});

	it("fetches a body once and reuses it", async () => {
		h.rows = [rule(untaggedSelector())];
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
