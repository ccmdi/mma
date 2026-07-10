/**
 * Rocktree decode invariants, verified against live-captured fixtures
 * (kh.google.com/rt/earth, captured 2026-07). Expected literals were computed
 * with an independent raw-protobuf walk decoder, not the code under test.
 *
 * Fixtures:
 *   planetoid.bin  PlanetoidMetadata
 *   bulk_root.bin  BulkMetadata for the root (path "", epoch 1012)
 *   bulk_user.bin  BulkMetadata for path 205352734340 (epoch 1012)
 *   node_user.bin  NodeData for a Dallas-area node (JPG texture)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PbfWriter } from "pbf";
import {
	parsePlanetoid,
	parseBulkMetadata,
	parseNodeData,
	unpackPathAndFlags,
	unpackObb,
	nodeDataEpoch,
	childBulkEpoch,
	imageryEpochFor,
	hasChildBulk,
	isRenderable,
	ecefToLatLng,
	latLngToEcef,
	NodeFlags,
	PLANET_RADIUS,
	type Vec3,
} from "@/lib/render/rocktree/decode";
import { writeNodeData } from "@/lib/render/rocktree/rocktree.gen";
import { planetoidUrl, bulkUrl, nodeUrl } from "@/lib/render/rocktree/fetch";

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./fixtures/rocktree/${name}`, import.meta.url)));

const planetoid = () => parsePlanetoid(fixture("planetoid.bin"));
const bulkRoot = () => parseBulkMetadata(fixture("bulk_root.bin"), 1012);
const bulkUser = () => parseBulkMetadata(fixture("bulk_user.bin"), 1012);
const nodeUser = () => parseNodeData(fixture("node_user.bin"));

describe("planetoid", () => {
	it("parses root epoch and radius", () => {
		expect(planetoid()).toEqual({ rootEpoch: 1012, radius: 6371010 });
	});

	it("radius matches the sphere-frame constant", () => {
		expect(planetoid().radius).toBe(PLANET_RADIUS);
	});
});

describe("path_and_flags", () => {
	it("unpacks a hand-packed value exactly", () => {
		// level 4, digits 2,0,5,1, flags 18 (USE_IMAGERY_EPOCH | RICH3D_NODATA)
		const v = 3 | (2 << 2) | (0 << 5) | (5 << 8) | (1 << 11) | (18 << 14);
		expect(unpackPathAndFlags(v)).toEqual({ path: "2051", flags: 18 });
	});

	it("unpacks level 1 with zero flags", () => {
		expect(unpackPathAndFlags(0 | (7 << 2))).toEqual({ path: "7", flags: 0 });
	});
});

describe("bulk metadata", () => {
	it("parses the root bulk node set", () => {
		const b = bulkRoot();
		expect(b.nodes.size).toBe(124);
		expect(b.headEpoch).toBe(1012);
		expect(b.headNodeCenter).toEqual([19113030, 0, 0]);
		expect(b.defaultImageryEpoch).toBe(1030);
	});

	it("parses the deep bulk node set", () => {
		const b = bulkUser();
		expect(b.nodes.size).toBe(409);
		expect(b.headEpoch).toBe(1012);
		expect(b.headNodeCenter[0]).toBeCloseTo(-619107.8411555233, 6);
		expect(b.headNodeCenter[1]).toBeCloseTo(-5321714.437041201, 6);
		expect(b.headNodeCenter[2]).toBeCloseTo(3444707.904624766, 6);
		expect(b.defaultImageryEpoch).toBeNull();
	});

	it("relative paths are 1-4 digits of 0-7", () => {
		for (const b of [bulkRoot(), bulkUser()]) {
			for (const [path, node] of b.nodes) {
				expect(path).toBe(node.path);
				expect(path).toMatch(/^[0-7]{1,4}$/);
			}
		}
	});

	it("meters_per_texel: node override wins, else per-level array", () => {
		const b = bulkRoot();
		// "1342" carries an explicit meters_per_texel
		expect(b.nodes.get("1342")!.metersPerTexel).toBeCloseTo(15704.0419921875, 6);
		// "137" (level 3) falls back to the bulk array
		expect(b.nodes.get("137")!.metersPerTexel).toBeCloseTo(30408.7578125, 6);
		// "2051" (level 4) falls back to the bulk array
		expect(b.nodes.get("2051")!.metersPerTexel).toBeCloseTo(11541.01953125, 6);
	});
});

describe("epoch chain", () => {
	it("node data epoch: explicit epoch wins", () => {
		const b = bulkRoot();
		expect(nodeDataEpoch(b, b.nodes.get("2051")!)).toBe(1005);
	});

	it("node data epoch: falls back to the bulk head epoch", () => {
		const b = bulkRoot();
		const n = b.nodes.get("137")!;
		expect(n.epoch).toBeNull();
		expect(nodeDataEpoch(b, n)).toBe(1012);
	});

	it("child bulk epoch: inherits when bulk_metadata_epoch is absent", () => {
		const b = bulkRoot();
		const n = b.nodes.get("2051")!;
		expect(n.bulkMetadataEpoch).toBeNull();
		expect(childBulkEpoch(b, n)).toBe(1012);
	});

	it("imagery epoch: only with USE_IMAGERY_EPOCH, node field else bulk default", () => {
		const b = bulkRoot();
		// "2051" flags 18 = USE_IMAGERY_EPOCH | RICH3D_NODATA, no node imagery epoch
		expect(imageryEpochFor(b, b.nodes.get("2051")!)).toBe(1030);
		const noFlag = [...b.nodes.values()].find((n) => !(n.flags & NodeFlags.USE_IMAGERY_EPOCH));
		if (noFlag) expect(imageryEpochFor(b, noFlag)).toBeUndefined();
	});

	it("child bulks exist iff relative level is 4 and not LEAF", () => {
		const b = bulkUser();
		for (const n of b.nodes.values()) {
			expect(hasChildBulk(n)).toBe(n.path.length === 4 && !(n.flags & NodeFlags.LEAF));
		}
	});

	it("renderable = has OBB and not NODATA", () => {
		const b = bulkUser();
		const renderable = [...b.nodes.values()].filter(isRenderable);
		expect(renderable.length).toBe(345);
		for (const n of renderable) {
			expect(n.obb).not.toBeNull();
			expect(n.flags & NodeFlags.NODATA).toBe(0);
		}
	});
});

describe("obb", () => {
	it("unpacks center/extents/orientation exactly", () => {
		const b = bulkRoot();
		const obb = b.nodes.get("2051")!.obb!;
		// raw: 20f9 f6fd 6b00 | 10 6e 6f | 0078 0010 0040, mpt 11541.01953125
		expect(obb.center[0]).toBeCloseTo(-1760 * 11541.01953125 + 19113030, 3);
		expect(obb.center[1]).toBeCloseTo(-522 * 11541.01953125, 3);
		expect(obb.center[2]).toBeCloseTo(107 * 11541.01953125, 3);
		expect(obb.extents[0]).toBeCloseTo(16 * 11541.01953125, 3);
		expect(obb.extents[1]).toBeCloseTo(110 * 11541.01953125, 3);
		expect(obb.extents[2]).toBeCloseTo(111 * 11541.01953125, 3);
		// euler = (30720*PI/32768, 4096*PI/65536, 16384*PI/32768); orientation[8] = cos(e1)
		expect(obb.orientation[8]).toBeCloseTo(Math.cos((4096 * Math.PI) / 65536), 12);
	});

	it("orientation is a rotation (det = 1)", () => {
		const o = bulkRoot().nodes.get("2051")!.obb!.orientation;
		const det =
			o[0] * (o[4] * o[8] - o[5] * o[7]) -
			o[1] * (o[3] * o[8] - o[5] * o[6]) +
			o[2] * (o[3] * o[7] - o[4] * o[6]);
		expect(det).toBeCloseTo(1, 9);
	});

	it("OBB centers sit near the planet surface for deep nodes", () => {
		const b = bulkUser();
		for (const n of b.nodes.values()) {
			if (!n.obb) continue;
			const r = Math.hypot(...n.obb.center);
			expect(Math.abs(r - PLANET_RADIUS)).toBeLessThan(20000);
		}
	});
});

describe("node data mesh decode", () => {
	it("decodes vertices with u8 delta wraparound", () => {
		const m = nodeUser().meshes[0];
		expect(nodeUser().meshes.length).toBe(1);
		expect(m.vertexCount).toBe(67);
		const v = (i: number) => [
			m.vertexData[i * 8],
			m.vertexData[i * 8 + 1],
			m.vertexData[i * 8 + 2],
		];
		expect(v(0)).toEqual([90, 23, 3]);
		expect(v(1)).toEqual([90, 88, 81]);
		expect(v(66)).toEqual([87, 231, 251]);
	});

	it("decodes field-7 texcoords and rejects legacy field 2", () => {
		const m = nodeUser().meshes[0];
		const dv = new DataView(m.vertexData.buffer);
		const uv = (i: number) => [dv.getUint16(i * 8 + 4, true), dv.getUint16(i * 8 + 6, true)];
		expect(uv(0)).toEqual([16267, 49262]);
		expect(uv(1)).toEqual([26578, 38882]);
		expect(uv(66)).toEqual([49309, 16276]);
	});

	it("passes through uv_offset_and_scale when present", () => {
		const m = nodeUser().meshes[0];
		expect(m.uvOffset).toEqual([-16384, -16384]);
		expect(m.uvScale).toEqual([1 / 32768, 1 / 32768]);
	});

	it("decodes the index strip with all indices in range", () => {
		const m = nodeUser().meshes[0];
		expect(m.strip.length).toBe(565);
		expect(Array.from(m.strip.slice(0, 10))).toEqual([0, 1, 2, 2, 3, 3, 0, 1, 1, 2]);
		for (const i of m.strip) expect(i).toBeLessThan(m.vertexCount);
	});

	it("decodes layer bounds and octant ids", () => {
		const m = nodeUser().meshes[0];
		expect(m.layerBounds).toEqual([0, 0, 0, 390, 390, 390, 390, 390, 454, 565]);
		// bounds are monotonic and end at the strip length
		for (let i = 1; i < 10; i++)
			expect(m.layerBounds[i]).toBeGreaterThanOrEqual(m.layerBounds[i - 1]);
		expect(m.layerBounds[9]).toBe(m.strip.length);
		// octant ids stamped into w are 3-bit
		const octants = new Set<number>();
		for (let i = 0; i < m.vertexCount; i++) octants.add(m.vertexData[i * 8 + 3]);
		expect([...octants].sort()).toEqual([0, 1, 2, 3]);
	});

	it("extracts the JPG texture", () => {
		const t = nodeUser().meshes[0].texture;
		expect(t.format).toBe(1);
		expect(t.width).toBe(256);
		expect(t.height).toBe(256);
		expect(t.data.length).toBe(27288);
		expect([t.data[0], t.data[1]]).toEqual([0xff, 0xd8]);
	});
});

describe("sphere frame transform", () => {
	it("matrix_globe_from_mesh places the mesh at its real-world location", () => {
		const node = nodeUser();
		const M = node.matrix;
		const m = node.meshes[0];
		// centroid of transformed vertices, then geocentric-sphere lat/lng
		let cx = 0,
			cy = 0,
			cz = 0;
		for (let i = 0; i < m.vertexCount; i++) {
			const x = m.vertexData[i * 8],
				y = m.vertexData[i * 8 + 1],
				z = m.vertexData[i * 8 + 2];
			cx += M[0] * x + M[4] * y + M[8] * z + M[12];
			cy += M[1] * x + M[5] * y + M[9] * z + M[13];
			cz += M[2] * x + M[6] * y + M[10] * z + M[14];
		}
		const { lat, lng, alt } = ecefToLatLng(
			cx / m.vertexCount,
			cy / m.vertexCount,
			cz / m.vertexCount,
		);
		// Ground truth from the independent decoder: 32.95650, -96.77203 (Dallas).
		// A WGS84 (ellipsoid) conversion would be ~0.18 deg off in latitude here.
		expect(lat).toBeCloseTo(32.9565, 4);
		expect(lng).toBeCloseTo(-96.77203, 4);
		expect(alt).toBeGreaterThan(-500);
		expect(alt).toBeLessThan(1000);
	});

	it("matrix translation is the node's ECEF origin", () => {
		const M = nodeUser().matrix;
		expect(M[12]).toBeCloseTo(-639923.566, 2);
		expect(M[13]).toBeCloseTo(-5306840.311, 2);
		expect(M[14]).toBeCloseTo(3453818.256, 2);
	});

	it("latLngToEcef and ecefToLatLng round-trip", () => {
		const [x, y, z] = latLngToEcef(40.758, -73.9855, 25);
		const back = ecefToLatLng(x, y, z);
		expect(back.lat).toBeCloseTo(40.758, 10);
		expect(back.lng).toBeCloseTo(-73.9855, 10);
		expect(back.alt).toBeCloseTo(25, 6);
	});
});

describe("synthetic mesh (derived uv + guards)", () => {
	function syntheticNodeData(mesh: Record<string, unknown>) {
		const pbf = new PbfWriter();
		writeNodeData(
			{
				matrix_globe_from_mesh: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
				meshes: [
					{
						// 3 vertices: planes X=[1,1,1] Y=[2,0,0] Z=[3,0,0]
						vertices: new Uint8Array([1, 1, 1, 2, 0, 0, 3, 0, 0]),
						// uMod=5, vMod=10; u deltas [1,1,1], v deltas [2,2,2], no high bytes
						texture_coordinates: new Uint8Array([4, 0, 9, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0, 0, 0, 0]),
						// strip [0,1,2]: len=3 then three zero varints
						indices: new Uint8Array([3, 0, 0, 0]),
						// 8 groups (layer 0 only): count 3 in octant 0
						layer_and_octant_counts: new Uint8Array([8, 3, 0, 0, 0, 0, 0, 0, 0]),
						texture: [{ data: [new Uint8Array([0xff, 0xd8, 0xff])], format: 1 }],
						uv_offset_and_scale: [],
						...mesh,
					},
				],
			},
			pbf,
		);
		return parseNodeData(pbf.finish());
	}

	it("derives uv offset/scale with V-flip when field 10 is absent", () => {
		const m = syntheticNodeData({}).meshes[0];
		expect(m.vertexCount).toBe(3);
		expect(m.uvOffset).toEqual([0.5, 0.5 - 10]);
		expect(m.uvScale).toEqual([1 / 5, -1 / 10]);
		const dv = new DataView(m.vertexData.buffer);
		expect([dv.getUint16(4, true), dv.getUint16(6, true)]).toEqual([1, 2]);
		expect([dv.getUint16(12, true), dv.getUint16(14, true)]).toEqual([2, 4]);
		expect([dv.getUint16(20, true), dv.getUint16(22, true)]).toEqual([3, 6]);
		expect(m.layerBounds).toEqual([0, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
	});

	it("throws on legacy texture_coords (field 2)", () => {
		expect(() => syntheticNodeData({ texture_coords: new Uint8Array([1, 2, 3]) })).toThrow(
			/legacy texture_coords/,
		);
	});
});

describe("resource urls", () => {
	it("builds the documented pb= shapes", () => {
		expect(planetoidUrl()).toMatch(/PlanetoidMetadata$/);
		expect(bulkUrl("", 1012)).toMatch(/BulkMetadata\/pb=!1m2!1s!2u1012$/);
		expect(bulkUrl("205352734340", 1009)).toMatch(/BulkMetadata\/pb=!1m2!1s205352734340!2u1009$/);
		expect(nodeUrl("20535273434062", 1009)).toMatch(
			/NodeData\/pb=!1m2!1s20535273434062!2u1009!2e1!4b0$/,
		);
		expect(nodeUrl("2", 1012, 1030)).toMatch(/NodeData\/pb=!1m2!1s2!2u1012!2e1!3u1030!4b0$/);
	});
});

describe("planetoid is not bulk-parseable", () => {
	it("planetoid bytes do not decode as a valid bulk", () => {
		// The plan warns against running PlanetoidMetadata through the bulk parser:
		// it must fail loudly, not silently misread.
		expect(() => parseBulkMetadata(fixture("planetoid.bin"), 1)).toThrow();
	});
});

describe("obb unpack rejects bad input", () => {
	it("throws on wrong length", () => {
		expect(() => unpackObb(new Uint8Array(14), [0, 0, 0] as Vec3, 1)).toThrow(/15/);
	});
});
