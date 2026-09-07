import type { Layer } from "@deck.gl/core";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import type { MarkerStyle } from "@/types";
import type { CellManager } from "@/lib/render/CellManager";
import type { RGBA } from "@/lib/util/color";

/** Colour source for a marker layer. The base cells are all one colour and vary only in
 *  whether each marker is hidden, so they pass a constant plus a visibility byte; the
 *  selection overlay genuinely varies per marker and passes RGBA. */
export type MarkerColors =
	| { kind: "constant"; color: RGBA; visible: Uint8Array }
	| { kind: "perMarker"; colors: Uint8Array };

export type MarkerBuf = {
	positions: Float32Array;
	angles: Float32Array;
	color: MarkerColors;
};

// Layer-level translucency: markers composite against each other at full alpha
// (the SDF shader outputs premultiplied color pre-scaled by the target opacity),
// while the constant alpha blend factor caps the canvas alpha at that opacity.
// Overlap then reads uniformly instead of stacking back to opaque. blendColor is
// the legacy-style key luma needs to supply the 'constant' factor's value.
function flattenParameters(op: number) {
	return {
		blend: true,
		blendColorOperation: "add",
		blendColorSrcFactor: "one",
		blendColorDstFactor: "one-minus-src-alpha",
		blendAlphaOperation: "add",
		blendAlphaSrcFactor: "constant",
		blendAlphaDstFactor: "one-minus-src-alpha",
		blendColor: [0, 0, 0, op],
	} as Record<string, unknown>;
}

/** Round each lat/lng to the same float precision. */
export function renderPos(lng: number, lat: number): [number, number] {
	return [Math.fround(lng), Math.fround(lat)];
}

export const MARKER_STYLE = {
	circle: { shape: "circle", radiusPixels: 6, angle: false },
	arrow: { shape: "arrow", radiusPixels: 12, angle: true },
	pin: { shape: "pin", radiusPixels: 16, angle: false },
} as const;

export function buildMarkerLayer(
	markerStyle: MarkerStyle,
	idBase: string,
	count: number,
	buf: MarkerBuf,
	colorVer: number,
	posVer: number,
	opacity?: number,
	sizeScale = 1,
): Layer {
	const flatten = opacity != null && opacity > 0 && opacity < 1;
	const s = MARKER_STYLE[markerStyle];
	const attributes: Record<string, unknown> = {
		getPosition: { value: buf.positions, size: 2 },
	};
	const props: Record<string, unknown> = {};
	if (buf.color.kind === "constant") {
		props.getFillColor = buf.color.color;
		attributes.getVisible = { value: buf.color.visible, size: 1 };
	} else {
		attributes.getFillColor = { value: buf.color.colors, size: 4 };
	}
	if (s.angle) attributes.getAngle = { value: buf.angles, size: 1 };
	const LayerClass = SDFMarkerLayer as unknown as new (props: Record<string, unknown>) => Layer;
	// Same gamma deck applies to its own opacity prop, so the slider feels identical.
	const flatOpacity = flatten ? Math.pow(opacity, 1 / 2.2) : 0;
	return new LayerClass({
		id: idBase,
		data: { length: count, attributes },
		shape: s.shape,
		radiusPixels: s.radiusPixels * sizeScale,
		pickable: true,
		...props,
		...(flatten
			? { flattenOpacity: flatOpacity, parameters: flattenParameters(flatOpacity) }
			: opacity != null
				? { opacity }
				: {}),
		updateTriggers: {
			getFillColor: [colorVer],
			getVisible: [colorVer],
			getPosition: [posVer],
			...(s.angle ? { getAngle: [posVer] } : {}),
		},
	});
}

// One marker layer per non-empty cell.
export function baseMarkerLayers(
	cm: CellManager,
	markerStyle: MarkerStyle,
	markerColor: RGBA,
	markerOpacity: number,
	markerSize = 1,
): Layer[] {
	if (markerOpacity <= 0 || cm.totalCount === 0) return [];
	const out: Layer[] = [];
	for (const [cellKey, cell] of cm.cells) {
		if (cell.count === 0) continue;
		out.push(
			buildMarkerLayer(
				markerStyle,
				`cell:${cellKey}`,
				cell.count,
				{
					positions: cell.positions,
					angles: cell.angles,
					color: { kind: "constant", color: markerColor, visible: cell.visible },
				},
				cell.colorVersion,
				cell.positionVersion,
				markerOpacity,
				markerSize,
			),
		);
	}
	return out;
}
