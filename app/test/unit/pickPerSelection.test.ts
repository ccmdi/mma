import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins per-selection picking (issue #139): a count is a per-bucket cap, buckets are the
// active selections, and their picks union (a location in two selections is picked once).

const h = vi.hoisted(() => ({
	sampledSelectors: [] as unknown[],
	spacedSelectors: [] as unknown[],
}));

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	// Tag 1 and tag 2 overlap on ids 4 and 5; tag 3 is disjoint from both.
	const byTag: Record<number, number[]> = {
		1: [1, 2, 3, 4, 5],
		2: [4, 5, 6, 7, 8],
		3: [11, 12, 13, 14, 15],
	};
	type TestSelector = { type: string; tagId?: number; selections?: { selector: TestSelector }[] };
	// Tag leaves resolve against byTag; a Union is the set union of its children -- which is
	// what "the current selection" now is, rather than a sentinel Rust reads back.
	const poolOf = (selector: TestSelector): number[] => {
		if (selector.type === "Tag") return byTag[selector.tagId ?? 0] ?? [];
		if (selector.selections)
			return [...new Set(selector.selections.flatMap((c) => poolOf(c.selector)))];
		return [];
	};
	const handlers: Record<string, (...args: never[]) => unknown> = {
		storeGetMap: async () =>
			testMap({
				locationCount: 20,
				tags: {
					1: { id: 1, name: "a", color: "#ff0000", visible: true },
					2: { id: 2, name: "b", color: "#00ff00", visible: true },
				},
			}),
		storeOpenMap: async () => openMapResult({ tagCounts: { 1: 5, 2: 5 } }),
		storeSyncSelections: async () => ({ counts: {}, bitmask: null, selectedCount: 0 }),
		storeResolve: async (selector: TestSelector) => poolOf(selector),
		storeSample: async (selector: TestSelector, n: number) => {
			h.sampledSelectors.push(selector);
			return poolOf(selector).slice(0, n);
		},
		storeSpaced: async (selector: TestSelector, targetCount: number | null) => {
			h.spacedSelectors.push(selector);
			const pool = poolOf(selector);
			return { ids: pool.slice(0, targetCount ?? pool.length), distanceM: 100 };
		},
	};
	return cmdProxy(handlers as Record<string, (...args: unknown[]) => unknown>);
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import {
	openMap,
	addSelections,
	resetSelections,
	selectRandomFromSelection,
	selectSpacedFromSelection,
	getMapState,
} from "@/store/useMapStore";

/** What `currentSelection()` builds: the active (non-ghosted) nodes under one Union. */
function unionOfActive() {
	const { selections, ghostedSelections } = getMapState();
	return { type: "Union", selections: selections.filter((s) => !ghostedSelections.has(s.key)) };
}

/** Tag membership as the command mock resolves it. */
function byTagIds(tagId: number): number[] {
	return { 1: [1, 2, 3, 4, 5], 2: [4, 5, 6, 7, 8], 3: [11, 12, 13, 14, 15] }[tagId] ?? [];
}

/** The ids of the Manual selection a pick leaves behind. */
function pickedIds(): number[] {
	const sel = getMapState().selections[0];
	return sel?.selector.type === "Manual" ? [...sel.selector.locations] : [];
}

beforeEach(async () => {
	await openMap("m1");
	await resetSelections();
	h.sampledSelectors = [];
	h.spacedSelectors = [];
});

describe("random pick, per selection", () => {
	it("caps each selection separately instead of the union", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 3 },
		]);

		const picked = await selectRandomFromSelection(2, true);

		expect(picked).toBe(4);
		const ids = pickedIds();
		expect(ids.filter((id) => id <= 5)).toHaveLength(2);
		expect(ids.filter((id) => id >= 11)).toHaveLength(2);
	});

	it("unions overlapping selections without double-picking", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);

		// 5 from each of two 5-id selections that share 2 ids.
		const picked = await selectRandomFromSelection(5, true);

		expect(picked).toBe(8);
		expect(new Set(pickedIds()).size).toBe(8);
	});

	it("falls back to the whole selection below two selections", async () => {
		await addSelections([{ type: "Tag", tagId: 1 }]);
		const sent = unionOfActive();

		const picked = await selectRandomFromSelection(2, true);

		expect(picked).toBe(2);
		// One bucket, and it is the selection tree itself -- no "selected" sentinel.
		expect(h.sampledSelectors).toEqual([sent]);
		expect(pickedIds().every((id) => byTagIds(1).includes(id))).toBe(true);
	});

	it("ignores ghosted selections", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);
		const { toggleGhostSelection } = await import("@/store/useMapStore");
		await toggleGhostSelection("tag:2");
		const sent = unionOfActive();

		await selectRandomFromSelection(2, true);

		// One live selection left, so the pick runs once over the whole selection --
		// and the ghosted one is absent from the union that gets sent.
		expect(h.sampledSelectors).toEqual([sent]);
	});
});

describe("spaced pick, per selection", () => {
	it("runs once per selection, scoped to that selection's props", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);

		const { picked, distanceM } = await selectSpacedFromSelection({ count: 2 }, true);

		expect(h.spacedSelectors).toEqual([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);
		expect(picked).toBe(4);
		// Spacing holds only within a bucket, so a multi-bucket pick claims none.
		expect(distanceM).toBe(0);
	});

	it("sends the whole selection tree for a whole-selection pick", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);

		const sent = unionOfActive();

		const { distanceM } = await selectSpacedFromSelection({ count: 3 }, false);

		expect(h.spacedSelectors).toEqual([sent]);
		expect(distanceM).toBe(100);
	});
});
