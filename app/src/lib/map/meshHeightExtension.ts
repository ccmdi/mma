// deck LayerExtension that lifts point markers onto the 3D mesh surface: the
// vertex shader samples a world-anchored heightmap (rasterized from the drawn
// rocktree nodes) at the marker's lng/lat and re-projects with that altitude.
// Applied only by earthHost to its cloned marker layers; the 2D hosts never
// see it. Note the lng/lat -> uv map is linear in degrees, not mercator: over
// a few-km rect the difference is centimeters.

import { LayerExtension, project } from "@deck.gl/core";
import type { Layer } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

export interface MeshHeights {
	texture: Texture;
	/** [west deg, north deg, 1/lngSpan, 1/latSpan] */
	bounds: [number, number, number, number];
}

type MeshHeightsProps = { meshHeights?: MeshHeights | null };

const uniformBlock = /* glsl */ `\
layout(std140) uniform meshHeightsUniforms {
  float west;
  float north;
  float invSpanX;
  float invSpanY;
  highp int enabled;
} meshHeights;
`;

const vs = `\
${uniformBlock}
uniform sampler2D meshHeights_tex;
`;

const inject = {
	"vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
    if (meshHeights.enabled == 1) {
      vec2 huv = vec2(
        (geometry.worldPosition.x - meshHeights.west) * meshHeights.invSpanX,
        (meshHeights.north - geometry.worldPosition.y) * meshHeights.invSpanY);
      if (all(greaterThanEqual(huv, vec2(0.0))) && all(lessThanEqual(huv, vec2(1.0)))) {
        float h = textureLod(meshHeights_tex, huv, 0.0).r;
        if (h > -1.0e29) {
          vec4 pos = geometry.position;
          pos.z += project_size(h);
          position = project_common_position_to_clipspace(pos);
        }
      }
    }
  `,
};

type ModuleProps = {
	heights?: MeshHeights | null;
	emptyTexture?: Texture;
};

type ModuleUniforms = {
	west: number;
	north: number;
	invSpanX: number;
	invSpanY: number;
	enabled: number;
};

type ModuleBindings = {
	meshHeights_tex: Texture;
};

function getUniforms(opts?: Partial<ModuleProps>): Partial<ModuleUniforms & ModuleBindings> {
	if (!opts) return {};
	const { heights, emptyTexture } = opts;
	return {
		meshHeights_tex: heights?.texture ?? emptyTexture,
		west: heights?.bounds[0] ?? 0,
		north: heights?.bounds[1] ?? 0,
		invSpanX: heights?.bounds[2] ?? 1,
		invSpanY: heights?.bounds[3] ?? 1,
		enabled: heights ? 1 : 0,
	};
}

const meshHeightsModule: ShaderModule<ModuleProps, ModuleUniforms, ModuleBindings> = {
	name: "meshHeights",
	vs,
	inject,
	dependencies: [project],
	getUniforms,
	uniformTypes: {
		west: "f32",
		north: "f32",
		invSpanX: "f32",
		invSpanY: "f32",
		enabled: "i32",
	},
};

export { meshHeightsModule };

export class MeshHeightExtension extends LayerExtension {
	static extensionName = "MeshHeightExtension";

	getShaders() {
		return { modules: [meshHeightsModule] };
	}

	initializeState(this: Layer<MeshHeightsProps>) {
		this.setState({
			meshHeightsEmpty: this.context.device.createTexture({
				data: new Uint8Array(4),
				width: 1,
				height: 1,
			}),
		});
	}

	draw(this: Layer<MeshHeightsProps>) {
		this.setShaderModuleProps({
			meshHeights: {
				heights: this.props.meshHeights ?? null,
				emptyTexture: this.state.meshHeightsEmpty as Texture,
			},
		});
	}

	finalizeState(this: Layer<MeshHeightsProps>) {
		(this.state.meshHeightsEmpty as Texture | undefined)?.destroy();
	}
}
