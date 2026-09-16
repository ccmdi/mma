import { describe, it, expect, vi } from "vitest";
import type { PolygonGeometry, Selector } from "@/bindings.gen";

const h = vi.hoisted(() => ({
	selections: [] as { key: string; selector: Selector }[],
}));

vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({ selections: h.selections }),
	applySelectionUpdate: () => Promise.resolve(),
}));

// Rectangle containment stands in for the store's ray-casting answer.
vi.mock("@/lib/commands", () => ({
	cmd: {
		polygonContainsPoints: (polygon: PolygonGeometry, lats: number[], lngs: number[]) => {
			const polys = [polygon.coordinates, ...(polygon.extraPolygons ?? [])];
			return Promise.resolve(
				lats.map((lat, i) =>
					polys.some((rings) => {
						const xs = rings[0].map((p) => p[0]);
						const ys = rings[0].map((p) => p[1]);
						return (
							lngs[i] >= Math.min(...xs) &&
							lngs[i] <= Math.max(...xs) &&
							lat >= Math.min(...ys) &&
							lat <= Math.max(...ys)
						);
					}),
				),
			);
		},
	},
}));

import { polygonsAt } from "@/lib/map/useDeletePolygon";

const square = (
	key: string,
	ox: number,
	oy: number,
	extras?: PolygonGeometry["extraPolygons"],
) => ({
	key,
	selector: {
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
			extraPolygons: extras ?? null,
		},
	} as Selector,
});

describe("polygonsAt", () => {
	it("answers the keys of every polygon selection covering the point, in order", async () => {
		h.selections = [square("a", 0, 0), square("b", 1, 1), square("c", 10, 10)];
		expect(await polygonsAt(1.5, 1.5)).toEqual(["a", "b"]);
	});

	it("ignores non-polygon selections and misses", async () => {
		h.selections = [square("a", 0, 0), { key: "t", selector: { type: "Tag", tagId: 1 } }];
		expect(await polygonsAt(50, 50)).toEqual([]);
		expect(await polygonsAt(1, 1)).toEqual(["a"]);
	});

	it("covers the extra polygons of a multipolygon selection", async () => {
		h.selections = [
			square("multi", 0, 0, [
				[
					[
						[10, 10],
						[12, 10],
						[12, 12],
						[10, 12],
						[10, 10],
					],
				],
			]),
		];
		expect(await polygonsAt(11, 11)).toEqual(["multi"]);
	});
});
