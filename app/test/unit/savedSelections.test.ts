import { selectionFixture } from "./fixtures/selection";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { Selection } from "@/bindings.gen";
import type { Selector } from "@/types";

// The store binds tag lookups internally; back them with a settable fake tag set. The
// Rust table is a plain array here, so the module's cache/refresh path is exercised.
const h = vi.hoisted(() => ({
	tags: {} as Record<number, { id: number; name: string; color: string; visible: boolean }>,
	rows: [] as SavedSelection[],
	added: [] as string[],
	calls: [] as string[],
	fieldDefs: {} as Record<string, unknown>,
	fieldValues: {} as Record<string, Record<number, { record: { name: string } }>>,
}));

vi.mock("@/store/store", () => ({
	Store: {
		get: () => ({ fieldDefs: h.fieldDefs, fieldValues: h.fieldValues }),
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
		storeEditSelections: async (op: { kind: string; id: string }) => {
			h.added.push(op.id);
			return { version: 0, keys: [] };
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
				valueNames: {},
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
import { SavedSelection } from "@/store/savedSelection";
import { tagSelector, unpannedSelector, untaggedSelector } from "@/store/selections";

const rule = (selector: Selector, tagNames: Record<number, string> = {}): SavedSelection => ({
	id: "s1",
	name: "rule",
	selector: selectionFixture(selector).selector,
	valueNames: { tags: tagNames },
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
	await SavedSelection.loadAll();
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
		expect(SavedSelection.parts(rule(selector))[0].selector).toEqual(selector);
	});

	it("labels a missing tag with the name it was saved under", () => {
		const saved = rule(tagSelector(5), { 5: "Japan" });
		expect(SavedSelection.parts(saved)[0].label).toBe("Tag: Japan");
	});

	it("labels membership of any interned field by its value's name", () => {
		h.fieldDefs = { brand: { type: "array", label: "Brand", interned: true } };
		const member: Selector = { type: "Filter", field: "brand", test: { op: "contains", value: 3 } };
		const saved = { ...rule(member), valueNames: { brand: { 3: "Shell" } } };
		expect(SavedSelection.parts(saved)[0].label).toBe("Brand: Shell");
		h.fieldValues = { brand: { 3: { record: { name: "BP" } } } };
		expect(SavedSelection.parts(saved)[0].label).toBe("Brand: BP");
		h.fieldDefs = {};
		h.fieldValues = {};
	});
});

// ============================================================================
// isSaveable
// ============================================================================

describe("isSaveable", () => {
	it("accepts portable leaves", () => {
		expect(SavedSelection.isSaveable({ type: "Everything" })).toBe(true);
		expect(SavedSelection.isSaveable(tagSelector(1))).toBe(true);
		expect(SavedSelection.isSaveable({ type: "Duplicates", distance: 50 })).toBe(true);
	});

	it("rejects every map-local leaf", () => {
		expect(SavedSelection.isSaveable({ type: "Locations", locations: [1], name: null })).toBe(
			false,
		);
		expect(SavedSelection.isSaveable({ type: "Manual", locations: [1] })).toBe(false);
		expect(
			SavedSelection.isSaveable({ type: "Validation", locations: [1], category: "valid" }),
		).toBe(false);
		expect(
			SavedSelection.isSaveable({
				type: "Reviewed",
				locations: [1],
				sessionId: "s",
				mode: "reviewed",
			}),
		).toBe(false);
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
		expect(SavedSelection.isSaveable(nested)).toBe(false);
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
			SavedSelection.isSaveable({
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
			const mapLocal = (SavedSelection.MAP_LOCAL_TYPES as readonly string[]).includes(type);
			expect(SavedSelection.isSaveable(SAMPLES[type]), `${type} saveability`).toBe(!mapLocal);
			if (mapLocal) continue;
			const [part] = SavedSelection.parts(rule(SAMPLES[type]));
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
		expect(await SavedSelection.save("mixed", [sel(reviewed), sel(untaggedSelector())])).toBe(true);
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
		expect(await SavedSelection.save("japan", [sel(tagSelector(4), [9, 9, 9])])).toBe(true);
		expect(h.rows[0]).toMatchObject({
			name: "japan",
			selector: tagSelector(4),
			valueNames: {},
			color: [9, 9, 9],
		});
	});

	it("unions several selections into one rule, keeping their colors", async () => {
		await SavedSelection.save("two", [
			sel(untaggedSelector(), [1, 1, 1]),
			sel(unpannedSelector(), [2, 2, 2]),
		]);
		const parts = SavedSelection.parts(h.rows[0]);
		expect(parts.map((p) => p.selector.type)).toEqual(["Filter", "Filter"]);
		expect(parts.map((p) => p.color)).toEqual([
			[1, 1, 1],
			[2, 2, 2],
		]);
	});

	it("refuses a save with nothing saveable in it", async () => {
		expect(await SavedSelection.save("nope", [sel({ type: "Manual", locations: [1] })])).toBe(
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
		expect(SavedSelection.apply(saved)).toBe(2);
		expect(h.added[0]).toBe(saved.id);
	});

	it("adds a non-union rule as a single selection", () => {
		expect(SavedSelection.apply(rule(untaggedSelector()))).toBe(1);
		expect(h.added[0]).toBe("s1");
	});
});

describe("the index and the bodies", () => {
	it("follows saves and deletes", async () => {
		expect(SavedSelection.index()).toEqual([]);
		await SavedSelection.save("a", [sel(untaggedSelector())]);
		await SavedSelection.save("b", [sel(unpannedSelector())]);
		expect(SavedSelection.index().map((s) => s.name)).toEqual(["a", "b"]);

		await SavedSelection.remove(SavedSelection.index()[0].id);
		expect(SavedSelection.index().map((s) => s.name)).toEqual(["b"]);
	});

	it("never reads a body just to list the rules", async () => {
		h.rows = [rule(untaggedSelector())];
		await SavedSelection.loadAll();
		h.calls = [];

		SavedSelection.index();
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual([]);
	});

	it("fetches a body once and reuses it", async () => {
		h.rows = [rule(untaggedSelector())];
		await SavedSelection.load(["s1"]);
		await SavedSelection.load(["s1"]);
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual(["get:s1"]);
	});

	it("does not re-request a rule that is not there", async () => {
		await SavedSelection.load(["ghost"]);
		await SavedSelection.load(["ghost"]);
		expect(h.calls.filter((c) => c.startsWith("get:"))).toEqual(["get:ghost"]);
	});
});
