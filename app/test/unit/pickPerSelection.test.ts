import { selectionFixture } from "./fixtures/selection";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins per-selection picking (issue #139): a count is a per-bucket cap, buckets are the
// active selections, and their picks union (a location in two selections is picked once).

const h = vi.hoisted(() => ({
	sampledSelectors: [] as unknown[],
	spacedSelectors: [] as unknown[],
	evenSelectors: [] as unknown[],
}));

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult, selectionsHeld } = await import("./fixtures/mocks");
	// Tag 1 and tag 2 overlap on ids 4 and 5; tag 3 is disjoint from both.
	const byTag: Record<number, number[]> = {
		1: [1, 2, 3, 4, 5],
		2: [4, 5, 6, 7, 8],
		3: [11, 12, 13, 14, 15],
	};
	type TestSelector = {
		type: string;
		field?: string;
		test?: { op: string; value?: unknown };
		selections?: { selector: TestSelector }[];
	};
	// A tag leaf is a `tags` membership filter; a Union is the set union of its children;
	// the Selected leaf answers from the live selection list, as the engine's synced
	// bitmap would.
	const poolOf = (selector: TestSelector): number[] => {
		if (selector.type === "Filter" && selector.field === "tags")
			return byTag[Number(selector.test?.value ?? 0)] ?? [];
		if (selector.selections)
			return [...new Set(selector.selections.flatMap((c) => poolOf(c.selector)))];
		return [];
	};
	const resolvePool = async (selector: TestSelector): Promise<number[]> => {
		if (selector.type !== "Selected") return poolOf(selector);
		const { SelectionList } = await import("@/store/selectionList");
		const active = SelectionList.active() as unknown as { selector: TestSelector }[];
		return [...new Set(active.flatMap((s) => poolOf(s.selector)))];
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
		storeEditSelections: async (rows: unknown[]) => selectionsHeld(rows),
		storeRead: async (
			_target: unknown,
			node: TestSelector & {
				selection?: { selector: TestSelector };
				n?: number;
				thin?: { by: string; n?: number };
			},
		) => {
			const selector = node.selection?.selector ?? node;
			const pool = await resolvePool(selector);
			const take = node.thin?.by === "count" ? node.thin.n : pool.length;
			if (node.type === "Sample") {
				h.sampledSelectors.push(selector);
				return { kind: "ids", ids: pool.slice(0, node.n) };
			}
			if (node.type === "Spaced") {
				h.spacedSelectors.push(selector);
				return { kind: "spacing", ids: pool.slice(0, take), spacingM: 100 };
			}
			if (node.type === "EvenlySpaced") {
				h.evenSelectors.push(selector);
				return { kind: "spacing", ids: pool.slice(0, take), spacingM: 250 };
			}
			return { kind: "ids", ids: pool };
		},
	};
	return cmdProxy(handlers as Record<string, (...args: unknown[]) => unknown>);
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { Query } from "@/store/query";
import { addSelection, tagSelector } from "@/store/selections";

async function sample(n: number, perSelection = false) {
	return (
		await SelectionList.select(
			(s) => Query.read({ type: "Sample", selection: selectionFixture(s), n }, { kind: "ids" }),
			perSelection,
		)
	).picked;
}
async function spaced(
	type: "Spaced" | "EvenlySpaced",
	thin: import("@/bindings.gen").Thinning,
	perSelection = false,
) {
	const { picked, results } = await SelectionList.select(
		(s) => Query.read({ type, selection: selectionFixture(s), thin }, { kind: "spacing" }),
		perSelection,
	);
	return { picked, distanceM: results.length === 1 ? results[0].spacingM : 0 };
}

/** The whole live selection, as every whole-selection pick now names it. */
const selectedLeaf = { type: "Selected" };

/** Tag membership as the command mock resolves it. */
function byTagIds(tagId: number): number[] {
	return { 1: [1, 2, 3, 4, 5], 2: [4, 5, 6, 7, 8], 3: [11, 12, 13, 14, 15] }[tagId] ?? [];
}

/** The ids of the Manual selection a pick leaves behind. */
function pickedIds(): number[] {
	const sel = SelectionList.active().find((s) => s.selector.type === "Manual");
	return sel?.selector.type === "Manual" ? [...sel.selector.locations] : [];
}

beforeEach(async () => {
	await Maps.open("m1");
	await SelectionList.update({ kind: "set", selections: [] });
	h.sampledSelectors = [];
	h.spacedSelectors = [];
	h.evenSelectors = [];
});

describe("random pick, per selection", () => {
	it("caps each selection separately instead of the union", async () => {
		await SelectionList.update(addSelection(tagSelector(1), tagSelector(3)));

		const picked = await sample(2, true);

		expect(picked).toBe(4);
		const ids = pickedIds();
		expect(ids.filter((id) => id <= 5)).toHaveLength(2);
		expect(ids.filter((id) => id >= 11)).toHaveLength(2);
	});

	it("unions overlapping selections without double-picking", async () => {
		await SelectionList.update(addSelection(tagSelector(1), tagSelector(2)));

		// 5 from each of two 5-id selections that share 2 ids.
		const picked = await sample(5, true);

		expect(picked).toBe(8);
		expect(new Set(pickedIds()).size).toBe(8);
	});

	it("falls back to the whole selection below two selections", async () => {
		await SelectionList.update(addSelection(tagSelector(1)));

		const picked = await sample(2, true);

		expect(picked).toBe(2);
		expect(h.sampledSelectors).toEqual([selectedLeaf]);
		expect(pickedIds().every((id) => byTagIds(1).includes(id))).toBe(true);
	});

	it("ignores ghosted selections", async () => {
		await SelectionList.update(addSelection(tagSelector(1), tagSelector(2)));
		const { toggleGhost } = await import("@/store/selections");
		const ghostKey = selectionFixture(tagSelector(2)).key;
		await SelectionList.update(toggleGhost(1));

		await sample(2, true);

		// One live selection left, so the pick runs once over the whole selection,
		// which the ghosted selection is not part of.
		expect(h.sampledSelectors).toEqual([selectedLeaf]);
		expect(pickedIds().every((id) => byTagIds(1).includes(id))).toBe(true);
		// The pick replaces only what it picked from: the ghosted selection stays, still ghosted.
		expect(Store.get().selectionList.map((r) => [r.selection.key, r.ghosted])).toEqual([
			[selectionFixture({ type: "Manual", locations: pickedIds() }).key, false],
			[ghostKey, true],
		]);
	});
});

describe("spaced pick, per selection", () => {
	it("runs once per selection, scoped to that selection's props", async () => {
		await SelectionList.update(addSelection(tagSelector(1), tagSelector(2)));

		const { picked, distanceM } = await spaced("Spaced", { by: "count", n: 2 }, true);

		expect(h.spacedSelectors).toEqual([tagSelector(1), tagSelector(2)]);
		expect(picked).toBe(4);
		// Spacing holds only within a bucket, so a multi-bucket pick claims none.
		expect(distanceM).toBe(0);
	});

	it("sends the Selected leaf for a whole-selection pick", async () => {
		await SelectionList.update(addSelection(tagSelector(1), tagSelector(2)));

		const { distanceM } = await spaced("Spaced", { by: "count", n: 3 }, false);

		expect(h.spacedSelectors).toEqual([selectedLeaf]);
		expect(distanceM).toBe(100);
	});
});

describe("evenly spaced pick, per selection", () => {
	it("runs once per selection on its own command and claims no spacing across them", async () => {
		await SelectionList.update(addSelection(tagSelector(1), tagSelector(3)));

		const { picked, distanceM } = await spaced("EvenlySpaced", { by: "count", n: 2 }, true);

		expect(h.evenSelectors).toEqual([tagSelector(1), tagSelector(3)]);
		expect(h.spacedSelectors).toEqual([]);
		expect(picked).toBe(4);
		expect(distanceM).toBe(0);
	});

	it("reports the spacing of a whole-selection pick", async () => {
		await SelectionList.update(addSelection(tagSelector(1)));

		const { distanceM } = await spaced("EvenlySpaced", { by: "metres", m: 250 }, false);

		expect(h.evenSelectors).toEqual([selectedLeaf]);
		expect(distanceM).toBe(250);
	});
});
