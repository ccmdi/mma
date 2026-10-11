import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ListedSelection, PolygonGeometry, Selection } from "@/bindings.gen";

const h = vi.hoisted(() => ({ asked: [] as string[], resolveSlow: null as (() => void) | null }));

vi.mock("@/lib/commands", () => ({
	cmd: {
		polygonFill: (polygon: PolygonGeometry) => {
			const name = String(polygon.properties?.name);
			h.asked.push(name);
			const fill = [polygon.coordinates];
			if (name === "slow")
				return new Promise((resolve) => {
					h.resolveSlow = () => resolve(fill);
				});
			return Promise.resolve(fill);
		},
	},
}));

import { drawnPolygons, getPolygonFill, refreshPolygonFills } from "@/lib/render/polygonFills";

const polygon = (name: string): Selection => ({
	key: `poly:${name}`,
	color: [0, 0, 0],
	selector: {
		type: "Polygon",
		polygon: {
			coordinates: [
				[
					[0, 0],
					[1, 1],
					[1, 0],
					[0, 1],
					[0, 0],
				],
			],
			extraPolygons: null,
			properties: { name },
		},
	},
});
const listed = (...selections: Selection[]): ListedSelection[] =>
	selections.map((selection) => ({ selection, ghosted: false }));
const intersection = (...selections: Selection[]): Selection => ({
	key: selections.map((s) => s.key).join("&"),
	color: [0, 0, 0],
	selector: { type: "Intersection", selections },
});

beforeEach(async () => {
	await refreshPolygonFills([]);
	h.asked = [];
	h.resolveSlow = null;
});

describe("polygon fills", () => {
	it("draws listed polygons and the polygon parts of listed intersections", () => {
		const rows = listed(
			polygon("a"),
			intersection(polygon("b"), { ...polygon("x"), selector: { type: "Everything" } }),
		);
		expect(drawnPolygons(rows).map((s) => s.key)).toEqual(["poly:a", "poly:b"]);
	});

	it("holds the store's fill for every drawn polygon, however it was added", async () => {
		await refreshPolygonFills(listed(polygon("a"), intersection(polygon("b"))));
		expect(getPolygonFill("poly:a")).toBeDefined();
		expect(getPolygonFill("poly:b")).toBeDefined();
	});

	it("asks only for polygons it does not hold, and drops ones no longer drawn", async () => {
		await refreshPolygonFills(listed(polygon("a")));
		await refreshPolygonFills(listed(polygon("a"), polygon("b")));
		expect(h.asked).toEqual(["a", "b"]);
		await refreshPolygonFills(listed(polygon("b")));
		expect(getPolygonFill("poly:a")).toBeUndefined();
		expect(getPolygonFill("poly:b")).toBeDefined();
	});

	it("keeps the latest refresh when an earlier one resolves after it", async () => {
		const stale = refreshPolygonFills(listed(polygon("slow")));
		await refreshPolygonFills(listed(polygon("b")));
		h.resolveSlow!();
		await stale;
		expect(getPolygonFill("poly:slow")).toBeUndefined();
		expect(getPolygonFill("poly:b")).toBeDefined();
	});
});
