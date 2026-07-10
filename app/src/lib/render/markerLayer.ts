import type { Layer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import type { MarkerStyle } from "@/types";
import type { CellManager } from "@/lib/render/CellManager";

export type MarkerBuf = { positions: Float32Array; colors: Uint8Array; angles: Float32Array };

// Per-style layer class + shape constants. `idSuffix` keeps deck.gl layer ids stable across styles.
export const MARKER_STYLE = {
	circle: {
		Layer: ScatterplotLayer,
		idSuffix: "s",
		angle: false,
		base: { getRadius: 6, radiusUnits: "pixels", radiusMinPixels: 3 },
	},
	arrow: {
		Layer: SDFMarkerLayer,
		idSuffix: "d",
		angle: true,
		base: { shape: "arrow", radiusPixels: 12 },
	},
	pin: {
		Layer: SDFMarkerLayer,
		idSuffix: "d",
		angle: false,
		base: { shape: "pin", radiusPixels: 16 },
	},
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
	const s = MARKER_STYLE[markerStyle];
	const attributes: Record<string, unknown> = {
		getPosition: { value: buf.positions, size: 2 },
		getFillColor: { value: buf.colors, size: 4 },
	};
	if (s.angle) attributes.getAngle = { value: buf.angles, size: 1 };
	const LayerClass = s.Layer as new (props: Record<string, unknown>) => Layer;
	const sizeProps: Record<string, unknown> = {};
	if ("radiusPixels" in s.base) sizeProps.radiusPixels = s.base.radiusPixels * sizeScale;
	if ("getRadius" in s.base) sizeProps.getRadius = s.base.getRadius * sizeScale;
	return new LayerClass({
		id: `${idBase}:${s.idSuffix}`,
		data: { length: count, attributes },
		...s.base,
		...sizeProps,
		pickable: true,
		...(opacity != null ? { opacity } : {}),
		updateTriggers: {
			...(opacity != null ? { opacity: [opacity] } : {}),
			getFillColor: [colorVer],
			getPosition: [posVer],
			...(s.angle ? { getAngle: [posVer] } : {}),
		},
	});
}

// One marker layer per non-empty cell.
export function baseMarkerLayers(
	cm: CellManager,
	markerStyle: MarkerStyle,
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
				cell,
				cell.colorVersion,
				cell.positionVersion,
				markerOpacity,
				markerSize,
			),
		);
	}
	return out;
}
