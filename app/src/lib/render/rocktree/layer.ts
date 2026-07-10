// Single deck.gl layer for all rocktree nodes: one luma Model per node mesh,
// per-node f64 MVP composed on the CPU each frame (the huge ECEF translations
// cancel before f32 sees them), octant-mask discard in the vertex shader.
// Keeps deck's layer count constant while the octree streams in and out.

import { Layer } from "@deck.gl/core";
import type { DefaultProps, LayerProps, UpdateParameters } from "@deck.gl/core";
import { Model, Geometry } from "@luma.gl/engine";
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { NumberArray16 } from "@math.gl/types";

export interface RocktreeNodeData {
	path: string;
	/** [lng, lat, alt] ENU anchor (from enuAnchor). */
	origin: [number, number, number];
	/** Column-major 4x4, mesh-local -> ENU meters (from enuAnchor). */
	enuModel: Float64Array;
	meshes: {
		positions: Float32Array;
		uvs: Float32Array;
		octants: Float32Array;
		indices: Uint16Array;
		texture: ImageBitmap;
	}[];
}

/**
 * Compose the common-space MVP for one node in f64 and downcast to f32.
 * commonFromMesh = T(originCommon) * S(unitsPerMeter) * enuModel; METER_OFFSETS
 * linearization, valid because nodes are small relative to the planet.
 */
export function composeNodeMvp(
	viewProjection: ArrayLike<number>,
	originCommon: [number, number, number],
	unitsPerMeter: number[],
	enuModel: Float64Array,
): Float32Array {
	const m = new Float64Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 3; row++) {
			m[col * 4 + row] = enuModel[col * 4 + row] * unitsPerMeter[row];
		}
		m[col * 4 + 3] = enuModel[col * 4 + 3];
	}
	m[12] += originCommon[0];
	m[13] += originCommon[1];
	m[14] += originCommon[2];

	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += viewProjection[k * 4 + row] * m[col * 4 + k];
			out[col * 4 + row] = s;
		}
	}
	return out;
}

type RocktreeNodeUniforms = { mvp: NumberArray16; mask: number };

const uniformBlock = `\
layout(std140) uniform rocktreeNodeUniforms {
  mat4 mvp;
  highp int mask;
} rocktreeNode;
`;

const rocktreeNodeUniforms = {
	name: "rocktreeNode",
	vs: uniformBlock,
	source: "",
	uniformTypes: {
		mvp: "mat4x4<f32>",
		mask: "i32",
	},
} as const satisfies ShaderModule<RocktreeNodeUniforms>;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME rocktree-vertex
in vec3 positions;
in vec2 uvs;
in float octants;
out vec2 vUv;

void main(void) {
  // collapse octants covered by a drawn descendant
  if (((rocktreeNode.mask >> int(octants + 0.5)) & 1) == 1) {
    gl_Position = vec4(0.0);
    return;
  }
  vUv = uvs;
  gl_Position = rocktreeNode.mvp * vec4(positions, 1.0);
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME rocktree-fragment
precision highp float;
in vec2 vUv;
uniform sampler2D rocktreeTexture;
out vec4 fragColor;

void main(void) {
  fragColor = vec4(texture(rocktreeTexture, vUv).rgb, 1.0);
}
`;

type _RocktreeMeshLayerProps = {
	nodes?: RocktreeNodeData[];
	masks?: ReadonlyMap<string, number>;
};

export type RocktreeMeshLayerProps = _RocktreeMeshLayerProps & LayerProps;

const defaultProps: DefaultProps<RocktreeMeshLayerProps> = {
	// plain values: reference change per compose is the update signal
	nodes: [],
	masks: new Map(),
};

interface GpuNode {
	node: RocktreeNodeData;
	models: Model[];
	textures: Texture[];
}

export default class RocktreeMeshLayer extends Layer<Required<_RocktreeMeshLayerProps>> {
	static layerName = "RocktreeMeshLayer";
	static defaultProps = defaultProps;

	declare state: { gpuNodes?: Map<string, GpuNode> };

	initializeState() {
		this.state.gpuNodes = new Map();
	}

	updateState(params: UpdateParameters<this>) {
		super.updateState(params);
		const gpuNodes = this.state.gpuNodes!;
		const next = new Set<string>();
		for (const node of this.props.nodes) {
			next.add(node.path);
			if (!gpuNodes.has(node.path)) gpuNodes.set(node.path, this.createGpuNode(node));
		}
		for (const [path, gpu] of gpuNodes) {
			if (next.has(path)) continue;
			this.destroyGpuNode(gpu);
			gpuNodes.delete(path);
		}
	}

	private createGpuNode(node: RocktreeNodeData): GpuNode {
		const { device } = this.context;
		const models: Model[] = [];
		const textures: Texture[] = [];
		for (const [i, mesh] of node.meshes.entries()) {
			const texture = device.createTexture({
				data: mesh.texture,
				width: mesh.texture.width,
				height: mesh.texture.height,
				mipLevels: device.getMipLevelCount(mesh.texture.width, mesh.texture.height),
				sampler: {
					minFilter: "linear",
					magFilter: "linear",
					mipmapFilter: "linear",
					addressModeU: "clamp-to-edge",
					addressModeV: "clamp-to-edge",
				},
			});
			try {
				texture.generateMipmapsWebGL();
			} catch {
				// non-WebGL backend: sampled without mips
			}
			const model = new Model(device, {
				id: `${this.props.id}-${node.path}-${i}`,
				vs,
				fs,
				modules: [rocktreeNodeUniforms],
				parameters: {
					depthWriteEnabled: true,
					depthCompare: "less-equal",
					cullMode: "none",
				},
				geometry: new Geometry({
					topology: "triangle-list",
					attributes: {
						positions: { size: 3, value: mesh.positions },
						uvs: { size: 2, value: mesh.uvs },
						octants: { size: 1, value: mesh.octants },
					},
					indices: mesh.indices,
				}),
			});
			model.setBindings({ rocktreeTexture: texture });
			models.push(model);
			textures.push(texture);
		}
		return { node, models, textures };
	}

	private destroyGpuNode(gpu: GpuNode) {
		for (const m of gpu.models) m.destroy();
		for (const t of gpu.textures) t.destroy();
	}

	draw() {
		const gpuNodes = this.state.gpuNodes!;
		const { viewport } = this.context;
		const vp = viewport.viewProjectionMatrix;
		const masks = this.props.masks;
		// deepest first so refinement wins depth ties
		const order = [...gpuNodes.values()].sort((a, b) => b.node.path.length - a.node.path.length);
		for (const gpu of order) {
			const mask = masks.get(gpu.node.path) ?? 0;
			if (mask === 0xff) continue;
			const originCommon = viewport.projectPosition(gpu.node.origin);
			const { unitsPerMeter } = viewport.getDistanceScales(gpu.node.origin);
			const mvp = composeNodeMvp(vp, originCommon, unitsPerMeter, gpu.node.enuModel);
			for (const model of gpu.models) {
				model.shaderInputs.setProps({
					rocktreeNode: { mvp: mvp as unknown as NumberArray16, mask },
				});
				model.draw(this.context.renderPass);
			}
		}
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		for (const gpu of this.state.gpuNodes?.values() ?? []) this.destroyGpuNode(gpu);
		this.state.gpuNodes?.clear();
	}
}
