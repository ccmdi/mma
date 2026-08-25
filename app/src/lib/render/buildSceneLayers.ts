import type { Layer, Position } from "@deck.gl/core";
import { ScatterplotLayer, PolygonLayer, PathLayer, LineLayer, TextLayer } from "@deck.gl/layers";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import { baseMarkerLayers, buildMarkerLayer, MARKER_STYLE } from "@/lib/render/markerLayer";
import PanoCoverageLayer from "@/lib/render/PanoCoverageLayer";
import { getMarkerDefaultColor } from "@/lib/render/sceneStore";
import type { CellManager } from "@/lib/render/CellManager";
import type { MarkerStyle } from "@/types";
import type { LatLng } from "@/types";
import { isImportPreview } from "@/types";
import type { Location, SeenEntry } from "@/bindings.gen";
import {
	isSeenOverlayActive,
	getSeenOverlayEntries,
	getSeenOnMapIds,
	seenEntryColor,
} from "@/lib/seen/seenOverlay";
import { getMapState } from "@/store/useMapStore";
import { getCommitDiffPreview } from "@/store/commitDiff";
import { getImportPreviewPositions } from "@/store/importStaging";
import { getTrail } from "@/lib/sv/svTrail";
import {
	getLatLngAnchor,
	getMeasurePoints,
	getMeasureSegments,
	MEASURE_NODE_PX,
} from "@/lib/sv/measure";
import type { RGB, RGBA } from "@/lib/util/color";
import { unwrapRing } from "@/lib/geo/geo";

export const LOCATION_LAYER_ID = "locations";
export const PERFECT_SCORE_LAYER_ID = "perfect-score";
// Screen-pixel hit radius for "click the first vertex to close the loop" — also
// the node's drawn radius, so the visible circle matches what's actually clickable.
export const POLYGON_CLOSE_VERTEX_PX = 10;
export type PolyGeom = { poly: object; fill: Position[][][]; stroke: Position[][] };

interface SceneContext {
	markerStyle: MarkerStyle;
	markerOpacity: number;
	markerSize: number;
	showPerfectScoreCircle: boolean;
	scoreMaxError: number;
	svPanoramas: boolean;
	panoDotColor: RGB;
	panoDotScaled: boolean;
	activeLocationColor: RGB;
	importPreviewColor: RGB;
	// Per-view tessellation cache for selection polygons (keyed by selection key).
	polygonGeomCache: Map<string, PolyGeom>;
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
	if (!getMapState().map) return [];

	const layers: Layer[] = [];

	// Commit-diff overlay temporarily replaces the regular markers.
	if (getMapState().workArea === "diff") {
		const diff = getCommitDiffPreview();
		if (diff) {
			const diffLayer = (id: string, pos: Float32Array, color: RGBA) =>
				new ScatterplotLayer({
					id,
					data: { length: pos.length / 2, attributes: { getPosition: { value: pos, size: 2 } } },
					getRadius: 6,
					radiusUnits: "pixels" as const,
					radiusMinPixels: 3,
					getFillColor: color,
					stroked: false,
					pickable: false,
				});
			if (diff.removed.length)
				layers.push(diffLayer("diff-removed", diff.removed, [239, 68, 68, 210]));
			if (diff.added.length) layers.push(diffLayer("diff-added", diff.added, [34, 197, 94, 210]));
			if (diff.modified.length)
				layers.push(diffLayer("diff-modified", diff.modified, [245, 158, 11, 220]));
		}
		return layers;
	}

	const allSelections = getMapState().selections;
	const polygonSels = allSelections.flatMap((sel) =>
		sel.selector.type === "Intersection" ? sel.selector.selections : [sel],
	);
	const livePolygonKeys = new Set<string>();
	for (const sel of polygonSels) {
		if (sel.selector.type !== "Polygon") continue;
		const poly = sel.selector.polygon;
		livePolygonKeys.add(sel.key);
		let geom = ctx.polygonGeomCache.get(sel.key);
		if (!geom || geom.poly !== poly) {
			const fill = [poly.coordinates, ...(poly.extraPolygons ?? [])].map((rings) =>
				rings.map(unwrapRing),
			);
			geom = { poly, fill, stroke: fill.flatMap((p) => p) as Position[][] };
			ctx.polygonGeomCache.set(sel.key, geom);
		}
		const fillColor: RGBA = [...sel.color, 26];
		const strokeColor: RGBA = [...sel.color, 153];
		layers.push(
			new PolygonLayer<Position[][]>({
				id: `selectionPolygonFill:${sel.key}`,
				data: geom.fill,
				getPolygon: (d) => d,
				getFillColor: fillColor,
				stroked: false,
				pickable: false,
				opacity: 1,
			}),
			new PathLayer<Position[]>({
				id: `selectionPolygonStroke:${sel.key}`,
				data: geom.stroke,
				getPath: (d) => d,
				getColor: strokeColor,
				getWidth: 4,
				widthUnits: "pixels",
				jointRounded: true,
				pickable: false,
				opacity: 1,
			}),
		);
	}
	for (const k of ctx.polygonGeomCache.keys()) {
		if (!livePolygonKeys.has(k)) ctx.polygonGeomCache.delete(k);
	}

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
			getMarkerDefaultColor(),
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
					getPosition: (d) => [d.lng, d.lat],
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

	// Selection overlay rides on top as its own pickable layer — otherwise clicks fall through to
	// the cell layer where selected markers have no z-priority, and an overlapping neighbor gets
	// picked instead of the marker on top.
	if (cm.overlay.count > 0) {
		layers.push(
			buildMarkerLayer(
				ctx.markerStyle,
				"sel-overlay",
				cm.overlay.count,
				{
					positions: cm.overlay.positions,
					angles: cm.overlay.angles,
					color: { kind: "perMarker", colors: cm.overlay.colors },
				},
				cm.overlay.version,
				cm.overlay.version,
				undefined,
				ctx.markerSize,
			),
		);
	}

	// Staged import preview markers; clicking one opens a read-only preview. Drawn *under* the
	// active marker, which highlights whichever staged location is open — no per-index coloring.
	const stagedActive = getMapState().activeLocation;
	if (
		getMapState().workArea === "import" ||
		(stagedActive != null && isImportPreview(stagedActive))
	) {
		const previewPos = getImportPreviewPositions();
		const previewCount = previewPos.length / 2;
		if (previewCount > 0) {
			layers.push(
				new ScatterplotLayer({
					id: "import-preview",
					data: {
						length: previewCount,
						attributes: { getPosition: { value: previewPos, size: 2 } },
					},
					getRadius: 6,
					radiusUnits: "pixels",
					radiusMinPixels: 3,
					getFillColor: [...ctx.importPreviewColor, 200],
					stroked: false,
					pickable: true,
				}),
			);
		}
	}

	// Active marker renders even with no committed locations so virtual previews (staged/seen)
	// on an empty map still show — and it draws on top of the preview dots, which is the highlight.
	const activeLoc = getMapState().activeLocation;
	if (activeLoc) {
		const activeColor: RGBA = [...ctx.activeLocationColor, 255];
		const s = MARKER_STYLE[ctx.markerStyle];
		layers.push(
			new SDFMarkerLayer<Location>({
				id: `${LOCATION_LAYER_ID}-current-sdf`,
				data: [activeLoc],
				getPosition: (d) => [d.lng, d.lat],
				shape: s.shape,
				radiusPixels: s.radiusPixels * ctx.markerSize,
				getFillColor: activeColor,
				...(s.angle ? { getAngle: (d: Location) => -d.heading } : {}),
				pickable: true,
				updateTriggers: {
					getAngle: [ctx.markerStyle],
				},
			}),
		);
	}

	if (ctx.showPerfectScoreCircle && activeLoc && cm.totalCount > 0) {
		const trail = getTrail();
		const last = trail.length ? trail[trail.length - 1] : null;
		const center = last
			? { lng: last[0], lat: last[1] }
			: { lat: activeLoc.lat, lng: activeLoc.lng };
		layers.push(
			new ScatterplotLayer({
				id: PERFECT_SCORE_LAYER_ID,
				data: [center],
				getPosition: (d: LatLng) => [d.lng, d.lat],
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

	const anchor = getLatLngAnchor();
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
				getSourcePosition: (d) => d.from,
				getTargetPosition: (d) => d.to,
				getColor: [0, 0, 0],
			}),
		);
	}

	const freehand = ctx.freehandPath;
	if (freehand && freehand.length >= 2) {
		layers.push(
			new PathLayer({
				id: "freehand-drawing",
				data: [unwrapRing(freehand)],
				getPath: (d) => d,
				getColor: [255, 255, 255, 200],
				getWidth: 3,
				widthUnits: "pixels" as const,
				jointRounded: true,
				capRounded: true,
				pickable: false,
			}),
		);
	}

	const polygonVertices = ctx.polygonVertices;
	if (polygonVertices && polygonVertices.length > 0) {
		const closable = polygonVertices.length >= 3;
		layers.push(
			new ScatterplotLayer({
				id: "polygon-vertices",
				data: polygonVertices,
				getPosition: (d) => d,
				radiusUnits: "pixels",
				getRadius: (_d, { index }) => (closable && index === 0 ? POLYGON_CLOSE_VERTEX_PX : 4),
				getFillColor: (_d, { index }) =>
					closable && index === 0 ? [255, 255, 255, 90] : [255, 255, 255, 220],
				stroked: true,
				lineWidthUnits: "pixels",
				getLineWidth: 1,
				getLineColor: [0, 0, 0, 180],
				pickable: false,
			}),
		);
	}

	const measurePoints = getMeasurePoints();
	if (measurePoints.length >= 2) {
		layers.push(
			new PathLayer({
				id: "measure-path",
				data: [unwrapRing(measurePoints)],
				getPath: (d) => d,
				getColor: [0, 0, 0, 255],
				getWidth: 2,
				widthUnits: "pixels" as const,
				jointRounded: true,
				capRounded: true,
				pickable: false,
			}),
		);
	}
	if (measurePoints.length >= 2) {
		layers.push(
			new TextLayer({
				id: "measure-labels",
				data: getMeasureSegments(),
				getPosition: (d) => d.at,
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
				id: "measure-nodes",
				data: measurePoints,
				getPosition: (d) => d,
				radiusUnits: "pixels" as const,
				getRadius: MEASURE_NODE_PX,
				getFillColor: [255, 255, 255, 255],
				stroked: true,
				lineWidthUnits: "pixels" as const,
				getLineWidth: 2,
				getLineColor: [0, 0, 0, 255],
				pickable: false,
			}),
		);
	}

	const svTrail = getTrail();
	if (svTrail.length >= 2) {
		layers.push(
			new PathLayer({
				id: "sv-trail",
				data: [svTrail],
				getPath: (d) => d,
				getColor: [255, 0, 0],
				getWidth: 2,
				widthUnits: "pixels" as const,
				jointRounded: true,
				capRounded: true,
				pickable: false,
			}),
		);
	}

	return layers;
}
