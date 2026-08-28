import { describe, it, expect } from "vitest";
import { buildMarkerLayer, MARKER_STYLE, type MarkerBuf } from "@/lib/render/markerLayer";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import type { MarkerStyle } from "@/types";

const buf: MarkerBuf = {
	positions: new Float32Array([0, 0]),
	angles: new Float32Array([0]),
	color: { kind: "perMarker", colors: new Uint8Array([255, 0, 0, 255]) },
};

function build(style: MarkerStyle, opacity?: number) {
	return buildMarkerLayer(style, "t", 1, buf, 0, 0, opacity) as unknown as {
		constructor: unknown;
		selector: Record<string, unknown>;
		props: Record<string, unknown>;
	};
}

describe("marker layer flattening (layer-level opacity)", () => {
	it("translucent markers flatten: premultiply uniform + constant-alpha blend", () => {
		const layer = build("pin", 0.5);
		const expected = Math.pow(0.5, 1 / 2.2);
		expect(layer.props.flattenOpacity).toBeCloseTo(expected);
		expect(layer.props.opacity).toBe(1);
		const params = layer.props.parameters as Record<string, unknown>;
		expect(params.blendAlphaSrcFactor).toBe("constant");
		expect((params.blendColor as number[])[3]).toBeCloseTo(expected);
	});

	it("full opacity renders without flattening", () => {
		const layer = build("pin", 1);
		expect(layer.props.flattenOpacity).toBe(0);
		expect(layer.props.parameters).toEqual({});
	});

	it("layers without an opacity (selection overlay) never flatten", () => {
		const layer = build("pin", undefined);
		expect(layer.props.flattenOpacity).toBe(0);
		expect(layer.props.parameters).toEqual({});
	});

	it("every marker style uses the SDF layer with its style shape", () => {
		for (const style of Object.keys(MARKER_STYLE) as MarkerStyle[]) {
			for (const opacity of [0.5, 1]) {
				const layer = build(style, opacity);
				expect(layer).toBeInstanceOf(SDFMarkerLayer);
				expect(layer.props.shape).toBe(MARKER_STYLE[style].shape);
				expect(layer.props.radiusPixels).toBeCloseTo(MARKER_STYLE[style].radiusPixels);
			}
		}
	});
});
