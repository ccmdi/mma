// Decoders for Google Earth rocktree payloads (BulkMetadata / NodeData /
// PlanetoidMetadata). Single source of truth for the octree wire format;
// fetch.ts does the IO, this file is pure bytes-in, structs-out.
//
// The globe frame is a geocentric SPHERE of radius 6371010 m, NOT the WGS84
// ellipsoid. Converting with an ellipsoid model puts geometry ~21 km off in
// latitude. All lat/lng<->ECEF conversions for rocktree data must go through
// the helpers below.

import { PbfReader } from "pbf";
import { readBulkMetadata, readNodeData, readPlanetoidMetadata } from "./rocktree.gen";

export const PLANET_RADIUS = 6371010;

export const NodeFlags = {
	RICH3D_LEAF: 1,
	RICH3D_NODATA: 2,
	LEAF: 4,
	NODATA: 8,
	USE_IMAGERY_EPOCH: 16,
} as const;

export const TEXTURE_FORMAT_JPG = 1;

export type Vec3 = [number, number, number];

export interface PlanetoidInfo {
	rootEpoch: number;
	radius: number;
}

export interface Obb {
	center: Vec3;
	extents: Vec3;
	/** 3x3 column-major rotation. */
	orientation: Float64Array;
}

export interface BulkNode {
	/** Octant path relative to the bulk head, 1-4 digits of 0-7. */
	path: string;
	flags: number;
	epoch: number | null;
	bulkMetadataEpoch: number | null;
	imageryEpoch: number | null;
	metersPerTexel: number;
	obb: Obb | null;
}

export interface Bulk {
	/** Epoch of this bulk (head_node_key.epoch, else the epoch it was fetched at). */
	headEpoch: number;
	headNodeCenter: Vec3;
	defaultImageryEpoch: number | null;
	nodes: Map<string, BulkNode>;
}

export interface DecodedTexture {
	data: Uint8Array;
	format: number;
	width: number;
	height: number;
}

export interface DecodedMesh {
	/** count*8 interleaved bytes: u8 x,y,z, u8 octant id, u16le u, u16le v. */
	vertexData: Uint8Array;
	vertexCount: number;
	/** Triangle strip; degenerate triangles are strip restarts. */
	strip: Uint16Array;
	/** Strip start position of each layer, 10 entries. Render [0, layerBounds[3]). */
	layerBounds: number[];
	/** uv_final = (uv + uvOffset) * uvScale */
	uvOffset: [number, number];
	uvScale: [number, number];
	texture: DecodedTexture;
}

export interface DecodedNode {
	/** Column-major 4x4, mesh space (0-255) -> globe ECEF. Keep f64. */
	matrix: Float64Array;
	meshes: DecodedMesh[];
}

export function parsePlanetoid(bytes: Uint8Array): PlanetoidInfo {
	const p = readPlanetoidMetadata(new PbfReader(bytes));
	if (!p.root_node_metadata?.epoch) throw new Error("rocktree: planetoid missing root epoch");
	return { rootEpoch: p.root_node_metadata.epoch, radius: p.radius };
}

export function unpackPathAndFlags(v: number): { path: string; flags: number } {
	const level = 1 + (v & 3);
	v >>>= 2;
	let path = "";
	for (let i = 0; i < level; i++) {
		path += v & 7;
		v >>>= 3;
	}
	return { path, flags: v };
}

export function unpackObb(packed: Uint8Array, headCenter: Vec3, metersPerTexel: number): Obb {
	if (packed.length !== 15) throw new Error(`rocktree: obb is ${packed.length} bytes, want 15`);
	const dv = new DataView(packed.buffer, packed.byteOffset, 15);
	const center: Vec3 = [
		dv.getInt16(0, true) * metersPerTexel + headCenter[0],
		dv.getInt16(2, true) * metersPerTexel + headCenter[1],
		dv.getInt16(4, true) * metersPerTexel + headCenter[2],
	];
	const extents: Vec3 = [
		packed[6] * metersPerTexel,
		packed[7] * metersPerTexel,
		packed[8] * metersPerTexel,
	];
	const e0 = (dv.getUint16(9, true) * Math.PI) / 32768;
	const e1 = (dv.getUint16(11, true) * Math.PI) / 65536;
	const e2 = (dv.getUint16(13, true) * Math.PI) / 32768;
	const c0 = Math.cos(e0),
		s0 = Math.sin(e0);
	const c1 = Math.cos(e1),
		s1 = Math.sin(e1);
	const c2 = Math.cos(e2),
		s2 = Math.sin(e2);
	const orientation = new Float64Array([
		c0 * c2 - c1 * s0 * s2,
		c1 * c0 * s2 + c2 * s0,
		s2 * s1,
		-c0 * s2 - c2 * c1 * s0,
		c0 * c1 * c2 - s0 * s2,
		c2 * s1,
		s1 * s0,
		-c0 * s1,
		c1,
	]);
	return { center, extents, orientation };
}

/** @param fetchedEpoch the epoch this bulk was requested at (epoch-chain fallback). */
export function parseBulkMetadata(bytes: Uint8Array, fetchedEpoch: number): Bulk {
	const b = readBulkMetadata(new PbfReader(bytes));
	if (b.head_node_center.length !== 3) throw new Error("rocktree: bulk missing head_node_center");
	const headNodeCenter = b.head_node_center as Vec3;
	const nodes = new Map<string, BulkNode>();
	for (const nm of b.node_metadata) {
		const { path, flags } = unpackPathAndFlags(nm.path_and_flags);
		// pbf reads absent proto2 scalars as 0; real epochs/mpt are never 0.
		// meters_per_texel falls back to the bulk's per-level array, indexed by
		// level relative to THIS bulk (path is already bulk-relative).
		const metersPerTexel = nm.meters_per_texel || b.meters_per_texel[path.length - 1];
		nodes.set(path, {
			path,
			flags,
			epoch: nm.epoch || null,
			bulkMetadataEpoch: nm.bulk_metadata_epoch || null,
			imageryEpoch: nm.imagery_epoch || null,
			metersPerTexel,
			obb:
				nm.oriented_bounding_box && nm.oriented_bounding_box.length === 15
					? unpackObb(nm.oriented_bounding_box, headNodeCenter, metersPerTexel)
					: null,
		});
	}
	return {
		headEpoch: b.head_node_key?.epoch || fetchedEpoch,
		headNodeCenter,
		defaultImageryEpoch: b.default_imagery_epoch || null,
		nodes,
	};
}

export function nodeDataEpoch(bulk: Bulk, node: BulkNode): number {
	return node.epoch ?? bulk.headEpoch;
}

export function childBulkEpoch(bulk: Bulk, node: BulkNode): number {
	return node.bulkMetadataEpoch ?? bulk.headEpoch;
}

/** Imagery epoch for the NodeData URL (!3u), only when USE_IMAGERY_EPOCH is set. */
export function imageryEpochFor(bulk: Bulk, node: BulkNode): number | undefined {
	if (!(node.flags & NodeFlags.USE_IMAGERY_EPOCH)) return undefined;
	return node.imageryEpoch ?? bulk.defaultImageryEpoch ?? undefined;
}

export function hasChildBulk(node: BulkNode): boolean {
	return node.path.length === 4 && !(node.flags & NodeFlags.LEAF);
}

export function isRenderable(node: BulkNode): boolean {
	return node.obb !== null && !(node.flags & NodeFlags.NODATA);
}

export function parseNodeData(bytes: Uint8Array): DecodedNode {
	const nd = readNodeData(new PbfReader(bytes));
	if (nd.matrix_globe_from_mesh.length !== 16)
		throw new Error(
			`rocktree: matrix_globe_from_mesh has ${nd.matrix_globe_from_mesh.length} elements, want 16`,
		);
	return {
		matrix: Float64Array.from(nd.matrix_globe_from_mesh),
		meshes: nd.meshes.map(decodeMesh),
	};
}

function readVarint(data: Uint8Array, pos: { i: number }): number {
	let v = 0;
	let shift = 0;
	for (;;) {
		const b = data[pos.i++];
		v += (b & 0x7f) * 2 ** shift;
		shift += 7;
		if (!(b & 0x80)) return v;
	}
}

function decodeMesh(mesh: import("./rocktree.gen").Mesh): DecodedMesh {
	if (mesh.texture_coords?.length)
		throw new Error("rocktree: legacy texture_coords (field 2) present; no decoder");
	if (!mesh.vertices || !mesh.indices || !mesh.texture_coordinates)
		throw new Error("rocktree: mesh missing vertices/indices/texture_coordinates");
	const tex = mesh.texture[0];
	if (!tex?.data[0]) throw new Error("rocktree: mesh missing texture");

	// Vertices: 3 planes of count bytes (all X, all Y, all Z), delta-coded with
	// u8 wraparound. Interleave into the 8-byte GPU vertex layout.
	const packed = mesh.vertices;
	const count = packed.length / 3;
	const vertexData = new Uint8Array(count * 8);
	let x = 0,
		y = 0,
		z = 0;
	for (let i = 0; i < count; i++) {
		x = (x + packed[i]) & 0xff;
		y = (y + packed[count + i]) & 0xff;
		z = (z + packed[2 * count + i]) & 0xff;
		vertexData[i * 8] = x;
		vertexData[i * 8 + 1] = y;
		vertexData[i * 8 + 2] = z;
	}

	// Texcoords: 4-byte header (u_mod-1, v_mod-1 as u16le), then 4 planes of
	// count bytes (uLo, vLo, uHi, vHi), delta-coded mod u_mod/v_mod.
	const tc = mesh.texture_coordinates;
	if (tc.length - 4 !== count * 4)
		throw new Error(`rocktree: texcoord count ${(tc.length - 4) / 4} != vertex count ${count}`);
	const tcv = new DataView(tc.buffer, tc.byteOffset, tc.byteLength);
	const uMod = 1 + tcv.getUint16(0, true);
	const vMod = 1 + tcv.getUint16(2, true);
	const d = tc.subarray(4);
	const uv16 = new DataView(vertexData.buffer);
	let u = 0,
		v = 0;
	for (let i = 0; i < count; i++) {
		u = (u + d[i] + (d[2 * count + i] << 8)) % uMod;
		v = (v + d[count + i] + (d[3 * count + i] << 8)) % vMod;
		uv16.setUint16(i * 8 + 4, u, true);
		uv16.setUint16(i * 8 + 6, v, true);
	}

	let uvOffset: [number, number];
	let uvScale: [number, number];
	if (mesh.uv_offset_and_scale.length === 4) {
		uvOffset = [mesh.uv_offset_and_scale[0], mesh.uv_offset_and_scale[1]];
		uvScale = [mesh.uv_offset_and_scale[2], mesh.uv_offset_and_scale[3]];
	} else {
		// No V-flip: browser image upload samples v=0 at the TOP row. The flip in
		// GL-convention reference clients (bottom-up upload) scrambles the atlas
		// here (verified visually on a live node).
		uvOffset = [0.5, 0.5];
		uvScale = [1 / uMod, 1 / vMod];
	}

	// Indices: first varint is strip length, then delta-from-high-water coding:
	// index = zeros - value, where zeros counts prior zero values.
	const idx = mesh.indices;
	const pos = { i: 0 };
	const stripLen = readVarint(idx, pos);
	const strip = new Uint16Array(stripLen);
	let zeros = 0;
	for (let i = 0; i < stripLen; i++) {
		const val = readVarint(idx, pos);
		strip[i] = zeros - val;
		if (val === 0) zeros++;
	}

	// Octant mask + layer bounds: varint groups ordered layer-major, 8 octants
	// per layer; each group's count walks the strip stamping vertex w = octant.
	const layerBounds = new Array<number>(10).fill(stripLen);
	if (mesh.layer_and_octant_counts?.length) {
		const lo = mesh.layer_and_octant_counts;
		const lpos = { i: 0 };
		const groups = readVarint(lo, lpos);
		let stripPos = 0;
		let layer = 0;
		for (let g = 0; g < groups; g++) {
			if (g % 8 === 0) layerBounds[layer++] = stripPos;
			const n = readVarint(lo, lpos);
			for (let j = 0; j < n; j++) vertexData[strip[stripPos++] * 8 + 3] = g & 7;
		}
		for (; layer < 10; layer++) layerBounds[layer] = stripPos;
	} else {
		layerBounds[0] = 0;
	}

	return {
		vertexData,
		vertexCount: count,
		strip,
		layerBounds,
		uvOffset,
		uvScale,
		texture: {
			data: tex.data[0],
			format: tex.format || TEXTURE_FORMAT_JPG,
			width: tex.width,
			height: tex.height,
		},
	};
}

// Sphere frame, not WGS84 (see file header).
export function ecefToLatLng(
	x: number,
	y: number,
	z: number,
): { lat: number; lng: number; alt: number } {
	const r = Math.hypot(x, y, z);
	return {
		lat: (Math.asin(z / r) * 180) / Math.PI,
		lng: (Math.atan2(y, x) * 180) / Math.PI,
		alt: r - PLANET_RADIUS,
	};
}

export function latLngToEcef(lat: number, lng: number, alt = 0): Vec3 {
	const p = (lat * Math.PI) / 180;
	const l = (lng * Math.PI) / 180;
	const r = PLANET_RADIUS + alt;
	return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
}
