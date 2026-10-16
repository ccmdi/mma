import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ListedSelection, Selection } from "@/bindings.gen";
import { CellManager } from "@/lib/render/CellManager";
import { drawnPolygons, polygonLayerData } from "@/lib/render/polygonMeshes";
import { frame } from "./fixtures/renderFixtures";

const fixture = (name: string) =>
	readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
// The bowtie-and-square that `emit_polygon_mesh_fixture` meshes: three rings of five.
const mesh = new Uint8Array(fixture("polygon-mesh.bin"));

const polygon = (key: string, color: [number, number, number] = [0, 0, 0]): Selection => ({
	key,
	color,
	selector: {
		type: "Polygon",
		polygon: { coordinates: [], extraPolygons: null },
	},
});
const listed = (...selections: Selection[]): ListedSelection[] =>
	selections.map((selection) => ({ selection, ghosted: false }));
const intersection = (...selections: Selection[]): Selection => ({
	key: selections.map((s) => s.key).join("&"),
	color: [0, 0, 0],
	selector: { type: "Intersection", selections },
});

let scene: CellManager;
beforeEach(() => {
	scene = new CellManager();
	scene.apply(frame({ replace: true }));
});

describe("polygon meshes", () => {
	it("draws listed polygons and the polygon parts of listed intersections", () => {
		const rows = listed(
			polygon("a"),
			intersection(polygon("b"), { ...polygon("x"), selector: { type: "Everything" } }),
		);
		expect(drawnPolygons(rows).map((s) => s.key)).toEqual(["a", "b"]);
	});

	it("take the meshes Rust sends in a frame, and drop the ones it names gone", () => {
		scene.apply(frame({ polygons: { added: [["polygon:gone", mesh]] } }));
		const buf = fixture("polygon-frame.bin");
		const version = scene.version;
		scene.apply(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
		expect(scene.version).toBe(version + 1);
		const rows = listed(polygon("polygon:a"), polygon("polygon:flat"), polygon("polygon:gone"));
		const { fill, rings } = polygonLayerData(rows);
		const vertices = fill.attributes.getPolygon.value.length / 2;
		const triangles = fill.attributes.indices;
		expect(fill.length).toBe(1);
		expect([...fill.startIndices]).toEqual([0, vertices]);
		expect(triangles.length % 3).toBe(0);
		expect(triangles.length).toBeGreaterThan(0);
		expect(Math.max(...triangles)).toBeLessThan(vertices);
		expect([...rings.startIndices]).toEqual([0, 5, 10, 15, 19]);
		expect([...rings.attributes.getPath.value.slice(0, 4)]).toEqual([0, 0, 2, 2]);
		expect([...rings.attributes.getPath.value.slice(20, 22)]).toEqual([44, 4]);
	});

	it("draws every polygon in one layer each, offsetting the later ones past the earlier", () => {
		scene.apply(
			frame({
				polygons: {
					added: [
						["a", mesh],
						["b", mesh],
					],
				},
			}),
		);
		const rows = listed(polygon("a", [255, 0, 0]), intersection(polygon("b", [0, 0, 255])));
		const { fill, fillColors, rings, ringColors } = polygonLayerData(rows);
		const vertices = fill.attributes.getPolygon.value.length / 4;
		const triangles = fill.attributes.indices;
		const half = triangles.length / 2;
		expect(fill.length).toBe(2);
		expect([...fill.startIndices]).toEqual([0, vertices, 2 * vertices]);
		expect([...triangles.slice(half)]).toEqual(
			[...triangles.slice(0, half)].map((i) => i + vertices),
		);
		expect(fillColors).toEqual([
			[255, 0, 0],
			[0, 0, 255],
		]);
		expect([...rings.startIndices]).toEqual([0, 5, 10, 15, 20, 25, 30]);
		expect(ringColors.map((c) => c[0])).toEqual([255, 255, 255, 0, 0, 0]);
	});

	it("keep the same layer data until a mesh or a color changes", () => {
		scene.apply(frame({ polygons: { added: [["a", mesh]] } }));
		const first = polygonLayerData(listed(polygon("a")));
		expect(polygonLayerData(listed(polygon("a")))).toBe(first);
		expect(polygonLayerData(listed(polygon("a", [1, 2, 3])))).not.toBe(first);
	});

	it("start over on a replace frame", () => {
		scene.apply(frame({ polygons: { added: [["a", mesh]] } }));
		scene.apply(frame({ replace: true }));
		expect(polygonLayerData(listed(polygon("a"))).rings.length).toBe(0);
	});
});
