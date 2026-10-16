import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ListedSelection, Selection } from "@/bindings.gen";
import { CellManager } from "@/lib/render/CellManager";
import { drawnPolygons, getPolygonMesh } from "@/lib/render/polygonMeshes";
import { frame } from "./fixtures/renderFixtures";

const fixture = (name: string) =>
	readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
// The bowtie-and-square that `emit_polygon_mesh_fixture` meshes: three rings of five.
const mesh = new Uint8Array(fixture("polygon-mesh.bin"));

const polygon = (key: string): Selection => ({
	key,
	color: [0, 0, 0],
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
		expect(getPolygonMesh("polygon:gone")).toBeUndefined();
		const { fill, rings } = getPolygonMesh("polygon:a")!;
		const vertices = fill.attributes.getPolygon.value.length / 2;
		const triangles = fill.attributes.indices;
		expect(fill.length).toBe(1);
		expect([...fill.startIndices]).toEqual([0, vertices]);
		expect(triangles.length % 3).toBe(0);
		expect(triangles.length).toBeGreaterThan(0);
		expect(Math.max(...triangles)).toBeLessThan(vertices);
		expect([...rings.startIndices]).toEqual([0, 5, 10, 15]);
		expect([...rings.attributes.getPath.value.slice(0, 4)]).toEqual([0, 0, 2, 2]);
		expect([...rings.attributes.getPath.value.slice(20, 22)]).toEqual([44, 4]);
		expect(getPolygonMesh("polygon:flat")!.fill.length).toBe(0);
	});

	it("start over on a replace frame", () => {
		scene.apply(frame({ polygons: { added: [["a", mesh]] } }));
		scene.apply(frame({ replace: true }));
		expect(getPolygonMesh("a")).toBeUndefined();
	});
});
