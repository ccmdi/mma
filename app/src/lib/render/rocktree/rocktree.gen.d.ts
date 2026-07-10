/* Types for the pbf-generated reader (rocktree.gen.js).
 * Regenerate the .js with `npm run proto:gen` after editing rocktree.proto,
 * then keep these declarations in sync.
 * proto2 presence collapses in pbf output: absent scalars read as 0. */
import type { PbfReader } from "pbf";

export interface NodeKey {
	path: string;
	epoch: number;
}
export interface BulkMetadata {
	node_metadata: NodeMetadata[];
	head_node_key?: NodeKey;
	head_node_center: number[];
	meters_per_texel: number[];
	default_imagery_epoch: number;
}
export interface NodeMetadata {
	path_and_flags: number;
	epoch: number;
	oriented_bounding_box?: Uint8Array;
	meters_per_texel: number;
	bulk_metadata_epoch: number;
	imagery_epoch: number;
}
export interface NodeData {
	matrix_globe_from_mesh: number[];
	meshes: Mesh[];
	for_normals?: Uint8Array;
}
export interface Mesh {
	vertices?: Uint8Array;
	texture_coords?: Uint8Array;
	indices?: Uint8Array;
	texture: Texture[];
	texture_coordinates?: Uint8Array;
	layer_and_octant_counts?: Uint8Array;
	uv_offset_and_scale: number[];
	normals?: Uint8Array;
	mesh_id: number;
}
export interface Texture {
	data: Uint8Array[];
	format: number;
	width: number;
	height: number;
}
export interface PlanetoidMetadata {
	root_node_metadata?: NodeMetadata;
	radius: number;
}

export declare const NodeMetadataFlags: {
	RICH3D_LEAF: 1;
	RICH3D_NODATA: 2;
	LEAF: 4;
	NODATA: 8;
	USE_IMAGERY_EPOCH: 16;
};
export declare const TextureFormat: {
	JPG: 1;
	DXT1: 2;
	ETC1: 3;
	PVRTC2: 4;
	PVRTC4: 5;
	CRN_DXT1: 6;
};

export declare function readBulkMetadata(pbf: PbfReader, end?: number): BulkMetadata;
export declare function readNodeData(pbf: PbfReader, end?: number): NodeData;
export declare function readPlanetoidMetadata(pbf: PbfReader, end?: number): PlanetoidMetadata;
