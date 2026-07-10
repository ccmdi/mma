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
import { uvAltMatrix, type CoverageRect } from "./coverage";

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
 * commonFromMesh = T(originCommon) * S(unitsPerMeter) * enuModel, in f64.
 * METER_OFFSETS linearization, valid because nodes are small relative to the
 * planet.
 */
export function composeNodeModel(
	originCommon: [number, number, number],
	unitsPerMeter: number[],
	enuModel: Float64Array,
): Float64Array {
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
	return m;
}

/** a * b for column-major 4x4 in f64. */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
	const out = new Float64Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
			out[col * 4 + row] = s;
		}
	}
	return out;
}

/**
 * Compose the common-space MVP for one node in f64 and downcast to f32.
 * The huge translations cancel in f64 before f32 sees them.
 */
export function composeNodeMvp(
	viewProjection: ArrayLike<number>,
	originCommon: [number, number, number],
	unitsPerMeter: number[],
	enuModel: Float64Array,
): Float32Array {
	return new Float32Array(
		mul4(viewProjection, composeNodeModel(originCommon, unitsPerMeter, enuModel)),
	);
}

type RocktreeNodeUniforms = {
	mvp: NumberArray16;
	covUv: NumberArray16;
	covScale: [number, number];
	mask: number;
	covOpacity: number;
};

const uniformBlock = `\
layout(std140) uniform rocktreeNodeUniforms {
  mat4 mvp;
  mat4 covUv;
  vec2 covScale;
  highp int mask;
  float covOpacity;
} rocktreeNode;
`;

const rocktreeNodeUniforms = {
	name: "rocktreeNode",
	vs: uniformBlock,
	fs: uniformBlock,
	source: "",
	uniformTypes: {
		mvp: "mat4x4<f32>",
		covUv: "mat4x4<f32>",
		covScale: "vec2<f32>",
		mask: "i32",
		covOpacity: "f32",
	},
} as const satisfies ShaderModule<RocktreeNodeUniforms>;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME rocktree-vertex
in vec3 positions;
in vec2 uvs;
in float octants;
out vec2 vUv;
out vec3 vCov;

void main(void) {
  // collapse octants covered by a drawn descendant
  if (((rocktreeNode.mask >> int(octants + 0.5)) & 1) == 1) {
    gl_Position = vec4(0.0);
    return;
  }
  vUv = uvs;
  // xy = coverage texture uv, z = ENU altitude meters (for the slope mask)
  vCov = (rocktreeNode.covUv * vec4(positions, 1.0)).xyz;
  gl_Position = rocktreeNode.mvp * vec4(positions, 1.0);
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME rocktree-fragment
precision highp float;
in vec2 vUv;
in vec3 vCov;
uniform sampler2D rocktreeTexture;
uniform sampler2D rocktreeCoverage;
out vec4 fragColor;

void main(void) {
  vec3 base = texture(rocktreeTexture, vUv).rgb;
  vec4 cov = texture(rocktreeCoverage, vCov.xy);
  float inRect = step(abs(vCov.x - 0.5), 0.5) * step(abs(vCov.y - 0.5), 0.5);
  // slope mask: coverage is a top-down decal, so keep it off walls. Surface
  // normal from screen-space derivatives of the position in meters.
  vec3 sp = vec3(vCov.xy * rocktreeNode.covScale, vCov.z);
  vec3 nrm = cross(dFdx(sp), dFdy(sp));
  float upness = abs(nrm.z) / max(length(nrm), 1e-9);
  float ground = smoothstep(0.55, 0.8, upness);
  // canvas bitmaps upload premultiplied
  vec3 covColor = cov.rgb / max(cov.a, 1e-4);
  fragColor = vec4(mix(base, covColor, cov.a * inRect * ground * rocktreeNode.covOpacity), 1.0);
}
`;

// Retention: GPU resources for nodes that leave the drawn set are kept for a
// grace period so zoom oscillation does not destroy/recreate models+textures.
const RETAIN_MS = 3000;
const MAX_RETAINED = 128;

/**
 * Which retained entries to destroy now: any past the grace period, plus the
 * oldest beyond the retained cap. `entries` maps path -> unusedSince (null =
 * currently drawn, never evicted).
 */
export function selectEvictions(
	entries: Iterable<[string, number | null]>,
	now: number,
	graceMs = RETAIN_MS,
	maxRetained = MAX_RETAINED,
): string[] {
	const retained: [string, number][] = [];
	for (const [path, since] of entries) if (since != null) retained.push([path, since]);
	retained.sort((a, b) => a[1] - b[1]);
	const excess = retained.length - maxRetained;
	const out: string[] = [];
	for (let i = 0; i < retained.length; i++)
		if (i < excess || now - retained[i][1] > graceMs) out.push(retained[i][0]);
	return out;
}

export interface CoverageTexture {
	bitmap: ImageBitmap;
	rect: CoverageRect;
	/** Monotonic; drives texture re-upload and per-node covUv recompute. */
	version: number;
}

type _RocktreeMeshLayerProps = {
	nodes?: RocktreeNodeData[];
	masks?: ReadonlyMap<string, number>;
	coverage?: CoverageTexture | null;
	svOpacity?: number;
};

export type RocktreeMeshLayerProps = _RocktreeMeshLayerProps & LayerProps;

const defaultProps: DefaultProps<RocktreeMeshLayerProps> = {
	// plain values: reference change per compose is the update signal
	nodes: [],
	masks: new Map(),
	coverage: null,
	svOpacity: 0,
};

interface GpuNode {
	node: RocktreeNodeData;
	models: Model[];
	textures: Texture[];
	/** Timestamp the node left the drawn set; null while drawn. */
	unusedSince: number | null;
	covUv: Float32Array;
	covScale: [number, number];
	covVersion: number;
}

const IDENTITY_F32 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export default class RocktreeMeshLayer extends Layer<Required<_RocktreeMeshLayerProps>> {
	static layerName = "RocktreeMeshLayer";
	static defaultProps = defaultProps;

	declare state: {
		gpuNodes?: Map<string, GpuNode>;
		drawOrder?: GpuNode[];
		covTexture?: Texture | null;
		covVersion?: number;
		blankCov?: Texture;
	};

	initializeState() {
		this.state.gpuNodes = new Map();
		this.state.drawOrder = [];
		this.state.covTexture = null;
		this.state.covVersion = 0;
		this.state.blankCov = this.context.device.createTexture({
			data: new Uint8Array([0, 0, 0, 0]),
			width: 1,
			height: 1,
		});
	}

	updateState(params: UpdateParameters<this>) {
		super.updateState(params);
		this.updateCoverageTexture();
		const gpuNodes = this.state.gpuNodes!;
		const now = Date.now();
		const next = new Set<string>();
		for (const node of this.props.nodes) {
			next.add(node.path);
			let gpu = gpuNodes.get(node.path);
			if (!gpu) {
				gpu = this.createGpuNode(node);
				gpuNodes.set(node.path, gpu);
			}
			gpu.unusedSince = null;
		}
		for (const [path, gpu] of gpuNodes)
			if (!next.has(path) && gpu.unusedSince == null) gpu.unusedSince = now;
		const stale = selectEvictions(
			[...gpuNodes].map(([path, gpu]) => [path, gpu.unusedSince] as [string, number | null]),
			now,
		);
		for (const path of stale) {
			this.destroyGpuNode(gpuNodes.get(path)!);
			gpuNodes.delete(path);
		}
		// deepest first so refinement wins depth ties
		this.state.drawOrder = [...next]
			.map((path) => gpuNodes.get(path)!)
			.sort((a, b) => b.node.path.length - a.node.path.length);
	}

	private updateCoverageTexture() {
		const cov = this.props.coverage;
		if ((cov?.version ?? 0) === this.state.covVersion) return;
		this.state.covTexture?.destroy();
		this.state.covTexture = cov
			? this.context.device.createTexture({
					data: cov.bitmap,
					width: cov.bitmap.width,
					height: cov.bitmap.height,
					sampler: {
						minFilter: "linear",
						magFilter: "linear",
						addressModeU: "clamp-to-edge",
						addressModeV: "clamp-to-edge",
					},
				})
			: null;
		this.state.covVersion = cov?.version ?? 0;
		const bound = this.state.covTexture ?? this.state.blankCov!;
		for (const gpu of this.state.gpuNodes!.values())
			for (const model of gpu.models) model.setBindings({ rocktreeCoverage: bound });
	}

	/** commonFromMesh is camera-independent, so this only recomputes per rect. */
	private nodeCovUv(gpu: GpuNode): GpuNode {
		const cov = this.props.coverage;
		if (cov && gpu.covVersion !== cov.version) {
			const { viewport } = this.context;
			const scales = viewport.getDistanceScales(gpu.node.origin);
			const model = composeNodeModel(
				viewport.projectPosition(gpu.node.origin),
				scales.unitsPerMeter,
				gpu.node.enuModel,
			);
			gpu.covUv = new Float32Array(uvAltMatrix(cov.rect, model, gpu.node.enuModel));
			// meters per uv unit, so the fragment shader can build a metric normal
			gpu.covScale = [cov.rect[2] * scales.metersPerUnit[0], cov.rect[3] * scales.metersPerUnit[1]];
			gpu.covVersion = cov.version;
		}
		return gpu;
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
			model.setBindings({
				rocktreeTexture: texture,
				rocktreeCoverage: this.state.covTexture ?? this.state.blankCov!,
			});
			models.push(model);
			textures.push(texture);
		}
		return {
			node,
			models,
			textures,
			unusedSince: null,
			covUv: IDENTITY_F32,
			covScale: [1, 1] as [number, number],
			covVersion: 0,
		};
	}

	private destroyGpuNode(gpu: GpuNode) {
		for (const m of gpu.models) m.destroy();
		for (const t of gpu.textures) t.destroy();
	}

	draw() {
		const { viewport } = this.context;
		const vp = viewport.viewProjectionMatrix;
		const masks = this.props.masks;
		const covOpacity = this.props.coverage ? (this.props.svOpacity ?? 0) : 0;
		for (const gpu of this.state.drawOrder!) {
			const mask = masks.get(gpu.node.path);
			// undefined = retained but not in the drawn set
			if (mask === undefined || mask === 0xff) continue;
			const originCommon = viewport.projectPosition(gpu.node.origin);
			const { unitsPerMeter } = viewport.getDistanceScales(gpu.node.origin);
			const mvp = composeNodeMvp(vp, originCommon, unitsPerMeter, gpu.node.enuModel);
			this.nodeCovUv(gpu);
			for (const model of gpu.models) {
				model.shaderInputs.setProps({
					rocktreeNode: {
						mvp: mvp as unknown as NumberArray16,
						covUv: gpu.covUv as unknown as NumberArray16,
						covScale: gpu.covScale,
						mask,
						covOpacity,
					},
				});
				model.draw(this.context.renderPass);
			}
		}
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		for (const gpu of this.state.gpuNodes?.values() ?? []) this.destroyGpuNode(gpu);
		this.state.gpuNodes?.clear();
		this.state.covTexture?.destroy();
		this.state.blankCov?.destroy();
	}
}
