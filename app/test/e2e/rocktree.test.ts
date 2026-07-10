/**
 * rocktree:// proxy + decode pipeline - fetches live Google Earth octree data
 * through the app's own Rust scheme handler (in the webview) and decodes it
 * with the app's own decoder (imported here), descending from the planetoid to
 * a real NodeData near a known target.
 *
 * Requires network (NOT --mock):
 *   npx wdio run wdio.conf.ts --spec test/e2e/rocktree.test.ts
 */
import { waitForReady } from "./helpers";
import {
	parsePlanetoid,
	parseBulkMetadata,
	parseNodeData,
	nodeDataEpoch,
	childBulkEpoch,
	imageryEpochFor,
	hasChildBulk,
	isRenderable,
	latLngToEcef,
	ecefToLatLng,
	PLANET_RADIUS,
	type Bulk,
	type BulkNode,
} from "@/lib/render/rocktree/decode";
import { obbDistance } from "@/lib/render/rocktree/lod";

const TARGET = { lat: 40.758, lng: -73.9855 }; // Times Square

type SchemeResponse = {
	status: number;
	contentType: string | null;
	cacheControl: string | null;
	bytes: number[];
};

async function fetchScheme(path: string): Promise<SchemeResponse> {
	const res = await browser.executeAsync(
		(p: string, done: (r: SchemeResponse | { error: string }) => void) => {
			const base = navigator.platform.startsWith("Win")
				? "http://rocktree.localhost/"
				: "rocktree://localhost/";
			fetch(base + p)
				.then(async (r) =>
					done({
						status: r.status,
						contentType: r.headers.get("content-type"),
						cacheControl: r.headers.get("cache-control"),
						bytes: Array.from(new Uint8Array(await r.arrayBuffer())),
					}),
				)
				.catch((e) => done({ error: String(e) }));
		},
		path,
	);
	if ("error" in res) throw new Error(`rocktree fetch failed for ${path}: ${res.error}`);
	return res;
}

async function fetchBytes(path: string): Promise<Uint8Array> {
	const res = await fetchScheme(path);
	if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${path}`);
	return Uint8Array.from(res.bytes);
}

const bulkPath = (path: string, epoch: number) => `BulkMetadata/pb=!1m2!1s${path}!2u${epoch}`;
const nodePath = (path: string, epoch: number, img?: number) =>
	`NodeData/pb=!1m2!1s${path}!2u${epoch}!2e1${img != null ? `!3u${img}` : ""}!4b0`;

describe("rocktree proxy + decode", function () {
	if (process.env.MMA_TEST_MOCK_SV) {
		it("skipped (requires network, not --mock)", () => {});
		return;
	}

	let rootEpoch: number;

	before(async () => {
		await waitForReady();
	});

	it("fetches and decodes PlanetoidMetadata through the scheme", async () => {
		const res = await fetchScheme("PlanetoidMetadata");
		expect(res.status).toBe(200);
		expect(res.contentType).toContain("protobuffer");
		expect(res.cacheControl).toContain("max-age=14400");
		const planet = parsePlanetoid(Uint8Array.from(res.bytes));
		expect(planet.radius).toBe(PLANET_RADIUS);
		expect(planet.rootEpoch).toBeGreaterThanOrEqual(1012);
		rootEpoch = planet.rootEpoch;
	});

	it("fetches and decodes the root BulkMetadata", async () => {
		const bulk = parseBulkMetadata(await fetchBytes(bulkPath("", rootEpoch)), rootEpoch);
		expect(bulk.nodes.size).toBeGreaterThan(0);
		const levels = new Set([...bulk.nodes.keys()].map((p) => p.length));
		expect([...levels].sort()).toEqual([1, 2, 3, 4]);
	});

	it("descends the octree to a NodeData near the target", async () => {
		const target = latLngToEcef(TARGET.lat, TARGET.lng);
		const distToTarget = (n: BulkNode) =>
			n.obb ? Math.hypot(...(n.obb.center.map((c, i) => c - target[i]) as number[])) : Infinity;

		// 4 bulk pages = 16 octree levels (~250 m nodes at the bottom)
		let bulkPathStr = "";
		let bulkEpoch = rootEpoch;
		let best: { node: BulkNode; fullPath: string; bulk: Bulk } | null = null;
		for (let round = 0; round < 4; round++) {
			const bulk = parseBulkMetadata(await fetchBytes(bulkPath(bulkPathStr, bulkEpoch)), bulkEpoch);
			// walk down one level at a time, following the nearest child of the prefix
			let rel = "";
			let cur: BulkNode | null = null;
			for (let lvl = 1; lvl <= 4; lvl++) {
				const kids = [...bulk.nodes.values()]
					.filter((n) => n.path.length === lvl && n.path.startsWith(rel) && n.obb)
					.sort((a, b) => distToTarget(a) - distToTarget(b));
				if (!kids.length) break;
				cur = kids[0];
				rel = cur.path;
			}
			expect(cur).not.toBeNull();
			best = { node: cur!, fullPath: bulkPathStr + cur!.path, bulk };
			if (!hasChildBulk(cur!)) break;
			bulkPathStr = best.fullPath;
			bulkEpoch = childBulkEpoch(bulk, cur!);
		}

		expect(best).not.toBeNull();
		expect(isRenderable(best!.node)).toBe(true);
		expect(best!.fullPath.length).toBeGreaterThanOrEqual(13);

		const epoch = nodeDataEpoch(best!.bulk, best!.node);
		const img = imageryEpochFor(best!.bulk, best!.node);
		const node = parseNodeData(await fetchBytes(nodePath(best!.fullPath, epoch, img)));

		expect(node.matrix.length).toBe(16);
		expect(node.meshes.length).toBeGreaterThan(0);
		const M = node.matrix;
		for (const mesh of node.meshes) {
			expect(mesh.vertexCount).toBeGreaterThan(0);
			expect(mesh.strip.length).toBeGreaterThan(0);
			for (const i of mesh.strip) expect(i).toBeLessThan(mesh.vertexCount);
			expect(mesh.layerBounds[9]).toBe(mesh.strip.length);
			expect([mesh.texture.data[0], mesh.texture.data[1]]).toEqual([0xff, 0xd8]);
		}

		// OBB convention check on live geometry: every vertex must sit inside the
		// node's own OBB when its axes are read as the COLUMNS of orientation
		// (frustum culling and LOD depend on this reading).
		const obb = best!.node.obb!;
		let worst = 0;
		for (const m of node.meshes) {
			for (let i = 0; i < m.vertexCount; i++) {
				const x = m.vertexData[i * 8],
					y = m.vertexData[i * 8 + 1],
					z = m.vertexData[i * 8 + 2];
				const p: [number, number, number] = [
					M[0] * x + M[4] * y + M[8] * z + M[12],
					M[1] * x + M[5] * y + M[9] * z + M[13],
					M[2] * x + M[6] * y + M[10] * z + M[14],
				];
				worst = Math.max(worst, obbDistance(obb, p));
			}
		}
		expect(worst).toBeLessThan(0.05 * Math.max(...obb.extents));

		// Sphere-frame check end to end: the mesh centroid must land near the target.
		const mesh = node.meshes[0];
		let cx = 0,
			cy = 0,
			cz = 0;
		for (let i = 0; i < mesh.vertexCount; i++) {
			const x = mesh.vertexData[i * 8],
				y = mesh.vertexData[i * 8 + 1],
				z = mesh.vertexData[i * 8 + 2];
			cx += M[0] * x + M[4] * y + M[8] * z + M[12];
			cy += M[1] * x + M[5] * y + M[9] * z + M[13];
			cz += M[2] * x + M[6] * y + M[10] * z + M[14];
		}
		const centroid = ecefToLatLng(
			cx / mesh.vertexCount,
			cy / mesh.vertexCount,
			cz / mesh.vertexCount,
		);
		const km =
			Math.hypot(
				...(latLngToEcef(centroid.lat, centroid.lng).map((c, i) => c - target[i]) as number[]),
			) / 1000;
		expect(km).toBeLessThan(5);
	});

	it("returns upstream errors for a bogus epoch", async () => {
		const res = await fetchScheme(bulkPath("", 1));
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
