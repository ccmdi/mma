import type { Layer } from "@deck.gl/core";
import {
	ScatterplotLayer,
	SolidPolygonLayer,
	PathLayer,
	LineLayer,
	TextLayer,
} from "@deck.gl/layers";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import {
	baseMarkerLayers,
	selectedMarkerLayers,
	MARKER_STYLE,
	renderPos,
} from "@/lib/render/markerLayer";
import PanoCoverageLayer from "@/lib/render/PanoCoverageLayer";
import { packedPositions } from "@/lib/render/packedPositions";
import { Scene } from "@/lib/render/scene";
import type { CellManager } from "@/lib/render/CellManager";
import type { MarkerStyle } from "@/types";
import type { LatLng } from "@/types";
import type { Location, RGB, SeenEntry } from "@/bindings.gen";
import {
	isSeenOverlayActive,
	getSeenOverlayEntries,
	getSeenOnMapIds,
	seenEntryColor,
} from "@/lib/seen/seenOverlay";
import { polygonLayerData } from "@/lib/render/polygonMeshes";
import { CommitDiff } from "@/store/commitDiff";
import { Import } from "@/store/import";
import { Measure } from "@/lib/map/measure";
import { NODE_PX } from "@/lib/map/nodePath";
import type { RGBA } from "@/lib/util/color";
import { bearingDeg, unwrapRing } from "@/lib/geo/geo";
import { Editor } from "@/store/editor";

/** Lines drawn at a fixed on-screen width. */
const SCREEN_LINE = {
	widthUnits: "pixels",
	jointRounded: true,
	capRounded: true,
	pickable: false,
} as const;

/** Plain dots of a fixed on-screen size. */
const PIXEL_DOT = {
	getRadius: 6,
	radiusUnits: "pixels",
	radiusMinPixels: 3,
	stroked: false,
	pickable: false,
} as const;

/** Outlined dots of a fixed on-screen size. */
const OUTLINED_DOT = {
	radiusUnits: "pixels",
	stroked: true,
	lineWidthUnits: "pixels",
	pickable: false,
} as const;

function trailSegments(trail: [number, number][]) {
	const count = trail.length - 1;
	return trail.slice(0, -1).map((pt, i) => ({
		path: [pt, trail[i + 1]] as [number, number][],
		alpha: count === 1 ? 255 : Math.round(50 + (205 * i) / (count - 1)),
	}));
}

// The trail's tip in the marker style's shape. Arrows point along the last step.
function trailPositionLayers(trail: [number, number][], ctx: SceneContext): Layer[] {
	const [prev, tip] = trail.slice(-2);
	if (ctx.markerStyle === "circle") {
		return [
			new ScatterplotLayer({
				...OUTLINED_DOT,
				id: "sv-trail-position",
				data: [tip],
				getPosition: (d) => renderPos(d[0], d[1]),
				getRadius: 5,
				radiusMinPixels: 4,
				getFillColor: [255, 255, 255, 220],
				getLineWidth: 2,
				getLineColor: [...ctx.svTrailColor, 255],
			}),
		];
	}
	const s = MARKER_STYLE[ctx.markerStyle];
	return [
		new SDFMarkerLayer<[number, number]>({
			id: "sv-trail-position-sdf",
			data: [tip],
			getPosition: (d) => renderPos(d[0], d[1]),
			shape: s.shape,
			radiusPixels: s.radiusPixels * ctx.markerSize,
			getFillColor: [...ctx.svTrailColor, 255],
			getAngle: s.angle
				? -bearingDeg({ lng: prev[0], lat: prev[1] }, { lng: tip[0], lat: tip[1] })
				: 0,
		}),
	];
}

export const LOCATION_LAYER_ID = "locations";
export const PERFECT_SCORE_LAYER_ID = "perfect-score";
// Screen-pixel hit radius for "click the first vertex to close the loop" — also
// the node's drawn radius, so the visible circle matches what's actually clickable.
export const POLYGON_CLOSE_VERTEX_PX = 10;
export const DIFF_COLORS: Record<"added" | "removed" | "updated", RGB> = {
	added: [34, 197, 94],
	removed: [239, 68, 68],
	updated: [245, 158, 11],
};

interface SceneContext {
	markerStyle: MarkerStyle;
	markerOpacity: number;
	selectedOpacity: number;
	markerSize: number;
	showPerfectScoreCircle: boolean;
	scoreMaxError: number;
	svPanoramas: boolean;
	svTrail: boolean;
	svTrailColor: RGB;
	svTrailPosition: boolean;
	panoDotColor: RGB;
	panoDotScaled: boolean;
	openLocationColor: RGB;
	importPreviewColor: RGB;
	// In-progress freehand selection path; null for views without freehand drawing (the minimap).
	freehandPath: number[][] | null;
	// Placed vertices of an in-progress click-vertex polygon (excludes the live cursor point).
	polygonVertices: number[][] | null;
}

// Assembles the full deck.gl layer set from shared state + per-view context. Pure: it reads the
// CellManager and store getters but mutates nothing, so multiple views can
// call it to render identical visuals. The active-marker color patch lives in the scene store
// (single owner of the shared CellManager), applied before consumers rebuild their layers.
export function buildSceneLayers(cm: CellManager, ctx: SceneContext): Layer[] {
	if (!Store.get().map) return [];

	const layers: Layer[] = [];

	// Commit-diff overlay temporarily replaces the regular markers.
	if (Editor.get().workArea === "diff") {
		const diff = CommitDiff.preview();
		if (diff) {
			for (const [kind, alpha] of [
				["removed", 210],
				["added", 210],
				["updated", 220],
			] as const) {
				if (diff[kind].length === 0) continue;
				layers.push(
					new ScatterplotLayer({
						...PIXEL_DOT,
						id: `diff-${kind}`,
						data: packedPositions(diff[kind]),
						getFillColor: [...DIFF_COLORS[kind], alpha],
					}),
				);
			}
		}
		return layers;
	}

	const polygons = polygonLayerData(SelectionList.listed());
	if (polygons.fill.length > 0)
		layers.push(
			new SolidPolygonLayer({
				id: "selectionPolygonFill",
				data: polygons.fill,
				_normalize: false,
				positionFormat: "XY",
				getFillColor: (_: unknown, { index }: { index: number }): RGBA => [
					...polygons.fillColors[index],
					26,
				],
				pickable: false,
				opacity: 1,
			}),
		);
	if (polygons.rings.length > 0)
		layers.push(
			new PathLayer({
				...SCREEN_LINE,
				id: "selectionPolygonStroke",
				data: polygons.rings,
				_pathType: "open",
				positionFormat: "XY",
				capRounded: false,
				getColor: (_: unknown, { index }: { index: number }): RGBA => [
					...polygons.ringColors[index],
					153,
				],
				getWidth: 4,
				opacity: 1,
			}),
		);

	if (ctx.svPanoramas)
		layers.push(
			new PanoCoverageLayer({
				id: "pano-coverage",
				color: ctx.panoDotColor,
				scaled: ctx.panoDotScaled,
			}),
		);

	layers.push(
		...baseMarkerLayers(
			cm,
			ctx.markerStyle,
			Scene.defaultColor(),
			ctx.markerOpacity,
			ctx.markerSize,
		),
	);

	if (isSeenOverlayActive()) {
		const seen = getSeenOverlayEntries();
		if (seen.length > 0) {
			layers.push(
				new ScatterplotLayer<SeenEntry>({
					id: "seen-overlay",
					data: seen,
					getPosition: (d) => renderPos(d.lng, d.lat),
					getFillColor: seenEntryColor,
					getRadius: 5,
					radiusUnits: "pixels",
					radiusMinPixels: 3,
					stroked: false,
					pickable: true,
					updateTriggers: { getFillColor: [getSeenOnMapIds()] },
				}),
			);
		}
	}

	layers.push(...selectedMarkerLayers(cm, ctx.markerStyle, ctx.selectedOpacity, ctx.markerSize));

	// Staged import preview markers; clicking one opens a read-only preview. Drawn *under* the
	// open marker, which highlights whichever staged location is open - no per-index coloring.
	if (Editor.get().workArea === "import" || Editor.get().open?.origin === "import") {
		const previewPos = Import.previewPositions();
		if (previewPos.length > 0) {
			layers.push(
				new ScatterplotLayer({
					...PIXEL_DOT,
					id: "import-preview",
					data: packedPositions(previewPos),
					getFillColor: [...ctx.importPreviewColor, 200],
					pickable: true,
				}),
			);
		}
	}

	const svTrail = Editor.trail.get();
	if (ctx.svTrail && svTrail.length >= 2) {
		const segments = trailSegments(svTrail);
		layers.push(
			new PathLayer<(typeof segments)[number]>({
				...SCREEN_LINE,
				id: "sv-trail",
				data: segments,
				getPath: (d) => d.path,
				getColor: (d) => [...ctx.svTrailColor, d.alpha],
				getWidth: 2,
			}),
		);
		if (ctx.svTrailPosition) layers.push(...trailPositionLayers(svTrail, ctx));
	}

	// The open-location marker renders even with no committed locations so previews (staged/seen)
	// on an empty map still show — and it draws on top of the preview dots, which is the highlight.
	const openLoc = Editor.get().open?.spawn;
	if (openLoc) {
		const openColor: RGBA = [...ctx.openLocationColor, 255];
		const s = MARKER_STYLE[ctx.markerStyle];
		layers.push(
			new SDFMarkerLayer<Location>({
				id: `${LOCATION_LAYER_ID}-current-sdf`,
				data: [openLoc],
				getPosition: (d) => renderPos(d.lng, d.lat),
				shape: s.shape,
				radiusPixels: s.radiusPixels * ctx.markerSize,
				getFillColor: openColor,
				...(s.angle ? { getAngle: (d: Location) => -d.heading } : {}),
				pickable: true,
				updateTriggers: {
					getAngle: [ctx.markerStyle],
				},
			}),
		);
	}

	if (ctx.showPerfectScoreCircle && openLoc && cm.totalCount > 0) {
		const trail = Editor.trail.get();
		const last = trail.length ? trail[trail.length - 1] : null;
		const center = last ? { lng: last[0], lat: last[1] } : { lat: openLoc.lat, lng: openLoc.lng };
		layers.push(
			new ScatterplotLayer({
				id: PERFECT_SCORE_LAYER_ID,
				data: [center],
				getPosition: (d: LatLng) => renderPos(d.lng, d.lat),
				getFillColor: [200, 0, 0, 26],
				getLineColor: [200, 0, 0, 128],
				getRadius: Math.max(25, ctx.scoreMaxError),
				radiusUnits: "meters" as const,
				stroked: true,
				filled: true,
				lineWidthPixels: 1,
				pickable: false,
			}),
		);
	}

	const anchor = Measure.anchor();
	if (anchor) {
		layers.push(
			new LineLayer({
				id: "lat-lng-anchor",
				visible: true,
				data: [
					{ from: [anchor.lng, 90], to: [anchor.lng, -90] },
					{ from: [-180, anchor.lat], to: [180, anchor.lat] },
				],
				pickable: false,
				getWidth: 2,
				getSourcePosition: (d) => renderPos(d.from[0], d.from[1]),
				getTargetPosition: (d) => renderPos(d.to[0], d.to[1]),
				getColor: [0, 0, 0],
			}),
		);
	}

	const freehand = ctx.freehandPath;
	if (freehand && freehand.length >= 2) {
		layers.push(
			new PathLayer({
				...SCREEN_LINE,
				id: "freehand-drawing",
				data: [unwrapRing(freehand)],
				getPath: (d) => d,
				getColor: [255, 255, 255, 200],
				getWidth: 3,
			}),
		);
	}

	const polygonVertices = ctx.polygonVertices;
	if (polygonVertices && polygonVertices.length > 0) {
		const closable = polygonVertices.length >= 3;
		layers.push(
			new ScatterplotLayer({
				...OUTLINED_DOT,
				id: "polygon-vertices",
				data: polygonVertices,
				getPosition: (d) => renderPos(d[0], d[1]),
				getRadius: (_d, { index }) => (closable && index === 0 ? POLYGON_CLOSE_VERTEX_PX : NODE_PX),
				getFillColor: (_d, { index }) =>
					closable && index === 0 ? [255, 255, 255, 90] : [255, 255, 255, 220],
				getLineWidth: 1,
				getLineColor: [0, 0, 0, 180],
			}),
		);
	}

	const measurePoints = Measure.points();
	if (measurePoints.length >= 2) {
		layers.push(
			new PathLayer({
				...SCREEN_LINE,
				id: "measure-path",
				data: [unwrapRing(measurePoints)],
				getPath: (d) => d,
				getColor: [0, 0, 0, 255],
				getWidth: 2,
			}),
		);
	}
	if (measurePoints.length >= 2) {
		layers.push(
			new TextLayer({
				id: "measure-labels",
				data: Measure.segments(),
				getPosition: (d) => renderPos(d.at[0], d.at[1]),
				getText: (d) => d.label,
				getSize: 13,
				getColor: [0, 0, 0, 255],
				getPixelOffset: [0, -12],
				background: true,
				getBackgroundColor: [255, 255, 255, 235],
				backgroundPadding: [5, 3],
				fontFamily: '"Open Sans", sans-serif',
				fontWeight: 600,
				characterSet: "auto",
				pickable: false,
			}),
		);
	}
	if (measurePoints.length > 0) {
		layers.push(
			new ScatterplotLayer({
				...OUTLINED_DOT,
				id: "measure-nodes",
				data: measurePoints,
				getPosition: (d) => renderPos(d[0], d[1]),
				getRadius: NODE_PX,
				getFillColor: [255, 255, 255, 255],
				getLineWidth: 2,
				getLineColor: [0, 0, 0, 255],
			}),
		);
	}

	return layers;
}
