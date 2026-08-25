import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins per-selection picking (issue #139): a count is a per-bucket cap, buckets are the
// active selections, and their picks union (a location in two selections is picked once).

const h = vi.hoisted(() => ({
	sampledScopes: [] as unknown[],
	spacedScopes: [] as unknown[],
}));

vi.mock("@/lib/commands", () => {
	const map = {
		id: "m1",
		meta: {
			id: "m1",
			name: "test",
			description: "",
			folder: null,
			locationCount: 20,
			tags: {
				1: { id: 1, name: "a", color: "#ff0000", visible: true },
				2: { id: 2, name: "b", color: "#00ff00", visible: true },
			},
			settings: {},
			scoreBounds: null,
			createdAt: "",
			updatedAt: "",
			extra: null,
		},
	};
	// Tag 1 and tag 2 overlap on ids 4 and 5; tag 3 is disjoint from both.
	const byTag: Record<number, number[]> = {
		1: [1, 2, 3, 4, 5],
		2: [4, 5, 6, 7, 8],
		3: [11, 12, 13, 14, 15],
	};
	type TestScope =
		| { kind: "selected" }
		| { kind: "props"; props: { type: string; tagId?: number } };
	// Pool per scope: props resolve against byTag, "selected" against the live JS set.
	const poolOf = async (scope: TestScope): Promise<number[]> => {
		if (scope.kind === "props")
			return scope.props.type === "Tag" ? (byTag[scope.props.tagId ?? 0] ?? []) : [];
		const { getMapState } = await import("@/store/useMapStore");
		return [...getMapState().selectedLocationIds];
	};
	const handlers: Record<string, (...args: never[]) => unknown> = {
		storeGetMap: async () => map,
		storeOpenMap: async () => ({
			tagCounts: { 1: 5, 2: 5 },
			canUndo: false,
			canRedo: false,
			knownFieldKeys: [],
		}),
		storeSyncSelections: async () => ({ counts: {}, bitmask: null, selectedCount: 0 }),
		storeQuery: async (
			scope: TestScope,
			select: { kind: string; n?: number; targetCount?: number | null },
		) => {
			const pool = await poolOf(scope);
			if (select.kind === "sample") {
				h.sampledScopes.push(scope);
				return { kind: "ids", ids: pool.slice(0, select.n) };
			}
			if (select.kind === "spaced") {
				h.spacedScopes.push(scope);
				return {
					kind: "spaced",
					ids: pool.slice(0, select.targetCount ?? pool.length),
					distanceM: 100,
				};
			}
			return { kind: "ids", ids: pool };
		},
	};
	return {
		cmd: new Proxy({}, { get: (_t, name: string) => handlers[name] ?? (async () => null) }),
	};
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import {
	openMap,
	addSelections,
	resetSelections,
	setSelectedLocationIds,
	selectRandomFromSelection,
	selectSpacedFromSelection,
	getMapState,
} from "@/store/useMapStore";

/** The ids of the Manual selection a pick leaves behind. */
function pickedIds(): number[] {
	const sel = getMapState().selections[0];
	return sel?.props.type === "Manual" ? [...sel.props.locations] : [];
}

beforeEach(async () => {
	await openMap("m1");
	await resetSelections();
	h.sampledScopes = [];
	h.spacedScopes = [];
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
		setSelectedLocationIds(new Set([90, 91, 92]));

		const picked = await selectRandomFromSelection(2, true);

		expect(picked).toBe(2);
		expect(h.sampledScopes).toEqual([{ kind: "selected" }]);
		expect(pickedIds().every((id) => id >= 90)).toBe(true);
	});

	it("ignores ghosted selections", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);
		const { toggleGhostSelection } = await import("@/store/useMapStore");
		await toggleGhostSelection("tag:2");

		await selectRandomFromSelection(2, true);

		// One live selection left, so the pick runs once over the whole selection.
		expect(h.sampledScopes).toEqual([{ kind: "selected" }]);
	});
});

describe("spaced pick, per selection", () => {
	it("runs once per selection, scoped to that selection's props", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);

		const { picked, distanceM } = await selectSpacedFromSelection({ count: 2 }, true);

		expect(h.spacedScopes).toEqual([
			{ kind: "props", props: { type: "Tag", tagId: 1 } },
			{ kind: "props", props: { type: "Tag", tagId: 2 } },
		]);
		expect(picked).toBe(4);
		// Spacing holds only within a bucket, so a multi-bucket pick claims none.
		expect(distanceM).toBe(0);
	});

	it("passes the selected scope for a whole-selection pick", async () => {
		await addSelections([
			{ type: "Tag", tagId: 1 },
			{ type: "Tag", tagId: 2 },
		]);
		setSelectedLocationIds(new Set([1, 2, 3]));

		const { distanceM } = await selectSpacedFromSelection({ count: 3 }, false);

		expect(h.spacedScopes).toEqual([{ kind: "selected" }]);
		expect(distanceM).toBe(100);
	});
});
