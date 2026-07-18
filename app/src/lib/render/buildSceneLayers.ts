import type { Layer, Position } from "@deck.gl/core";
import { ScatterplotLayer, PolygonLayer, PathLayer, LineLayer } from "@deck.gl/layers";
import SDFMarkerLayer from "@/lib/render/sdf-marker-layer/SDFMarkerLayer";
import {
	baseMarkerLayers,
	baseMarkerCount,
	buildMarkerLayer,
	MARKER_STYLE,
	type DrawOrder,
} from "@/lib/render/markerLayer";
import PanoCoverageLayer from "@/lib/render/PanoCoverageLayer";
import LookAroundPanoCoverageLayer from "@/lib/sv/lookaround/LookAroundPanoCoverageLayer";
import { isProviderEnabled, getProviderSettings } from "@/lib/sv/providers/settings";
import type { CellManager } from "@/lib/render/CellManager";
import type { Bounds, LatLng, MarkerStyle } from "@/types";
import { isImportPreview } from "@/types";
import type { Location, SeenEntry } from "@/bindings.gen";
import {
	isSeenOverlayActive,
	getSeenOverlayEntries,
	getSeenOnMapIds,
	seenEntryColor,
} from "@/lib/seen/seenOverlay";
import {
	getCurrentMap,
	getWorkArea,
	getCommitDiffPreview,
	getActiveLocation,
	getAllSelections,
	getImportPreviewPositions,
} from "@/store/useMapStore";
import { getTrail } from "@/lib/sv/svTrail";
import { getLatLngAnchor } from "@/lib/sv/measure";
import type { RGB } from "@/lib/util/color";

export const LOCATION_LAYER_ID = "locations";
export const PERFECT_SCORE_LAYER_ID = "perfect-score";
// Screen-pixel hit radius for "click the first vertex to close the loop" — also
// the node's drawn radius, so the visible circle matches what's actually clickable.
export const POLYGON_CLOSE_VERTEX_PX = 10;
export type PolyGeom = { poly: object; fill: Position[][][]; stroke: Position[][] };

// Markers carry draw-order depth in the far half of NDC; any layer drawn *before*
// them must not write depth at z=0 or it would occlude every marker.
const NO_DEPTH_WRITE = { depthWriteEnabled: false } as const;

export function normalizeRing<T extends number[]>(ring: T[]): T[] {
	const crosses =
		ring.some((p) => p[0] > 180 || p[0] < -180) ||
		ring.some((_, i, a) => i > 0 && Math.abs(a[i][0] - a[i - 1][0]) > 180);
	if (!crosses) return ring;
	return ring.map((p) => {
		const out = [...p] as unknown as T;
		if (out[0] < 0) out[0] += 360;
		return out;
	});
}

function normalizePolygonCoords<T extends number[]>(coords: T[][]): T[][] {
	return coords.map(normalizeRing);
}

interface SceneContext {
	markerStyle: MarkerStyle;
	markerOpacity: number;
	markerSize: number;
	/** Aggregation-LOD band to render, or null for full detail. Owned by the
	 *  surface (useMapSurface), which swaps at live band-boundary crossings —
	 *  never derive it from live zoom here. */
	lodBand: number | null;
	/** Padded viewport for whole-cell culling, or null to draw every cell.
	 *  Owned by the surface, which rebuilds when the visible cell set changes. */
	viewBounds: Bounds | null;
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

/** Marker dot layer for the auxiliary marker sets (diff / import preview / seen). */
function dotLayer(
	id: string,
	count: number,
	order: DrawOrder,
	props: Record<string, unknown>,
	radiusPx = 6,
): SDFMarkerLayer<unknown> {
	const layer = new SDFMarkerLayer({
		id,
		shape: "circle",
		radiusPixels: radiusPx,
		orderBase: order.base,
		orderTotal: order.total,
		opaque: false,
		pickable: false,
		...props,
	});
	order.base += count;
	return layer;
}

// Assembles the full deck.gl layer set from shared state + per-view context. Pure: it reads the
// CellManager and store getters but mutates nothing, so multiple views can
// call it to render identical visuals. The active-marker color patch lives in the scene store
// (single owner of the shared CellManager), applied before consumers rebuild their layers.
export function buildSceneLayers(cm: CellManager, ctx: SceneContext): Layer[] {
	if (!getCurrentMap()) return [];

	const layers: Layer[] = [];

	// Commit-diff overlay temporarily replaces the regular markers.
	if (getWorkArea() === "diff") {
		const diff = getCommitDiffPreview();
		if (diff) {
			const counts = [diff.removed, diff.added, diff.modified].map((p) => p.length / 2);
			const order: DrawOrder = { base: 0, total: counts.reduce((a, b) => a + b, 0) };
			const diffLayer = (id: string, pos: Float32Array, color: [number, number, number, number]) =>
				dotLayer(id, pos.length / 2, order, {
					data: { length: pos.length / 2, attributes: { getPosition: { value: pos, size: 2 } } },
					getFillColor: color,
				});
			if (diff.removed.length)
				layers.push(diffLayer("diff-removed", diff.removed, [239, 68, 68, 210]));
			if (diff.added.length) layers.push(diffLayer("diff-added", diff.added, [34, 197, 94, 210]));
			if (diff.modified.length)
				layers.push(diffLayer("diff-modified", diff.modified, [245, 158, 11, 220]));
		}
		return layers;
	}

	const allSelections = getAllSelections();
	const polygonSels = allSelections.flatMap((sel) =>
		sel.props.type === "Intersection" ? sel.props.selections : [sel],
	);
	const livePolygonKeys = new Set<string>();
	for (const sel of polygonSels) {
		if (sel.props.type !== "Polygon") continue;
		const poly = sel.props.polygon;
		livePolygonKeys.add(sel.key);
		let geom = ctx.polygonGeomCache.get(sel.key);
		if (!geom || geom.poly !== poly) {
			const fill = [poly.coordinates, ...(poly.extraPolygons ?? [])].map(normalizePolygonCoords);
			geom = { poly, fill, stroke: fill.flatMap((p) => p) as Position[][] };
			ctx.polygonGeomCache.set(sel.key, geom);
		}
		const fillColor: [number, number, number, number] = [...sel.color, 26];
		const strokeColor: [number, number, number, number] = [...sel.color, 153];
		layers.push(
			new PolygonLayer<Position[][]>({
				id: `selectionPolygonFill:${sel.key}`,
				data: geom.fill,
				getPolygon: (d) => d,
				getFillColor: fillColor,
				stroked: false,
				pickable: false,
				opacity: 1,
				parameters: NO_DEPTH_WRITE,
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
				parameters: NO_DEPTH_WRITE,
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
				color: [ctx.panoDotColor.r, ctx.panoDotColor.g, ctx.panoDotColor.b],
				scaled: ctx.panoDotScaled,
				parameters: NO_DEPTH_WRITE,
			}),
		);

	// Apple panoramas: same deck.gl band as Google PanoCoverageLayer.
	if (isProviderEnabled("apple") && getProviderSettings("apple").showPoints) {
		layers.push(
			new LookAroundPanoCoverageLayer({
				id: "lookaround-pano-coverage",
			}),
		);
	}

	// Draw-order allocation: every marker instance this frame gets a global slot;
	// higher slot = drawn later = on top (the depth pass mirrors painter's order).
	const lodBand = ctx.lodBand;
	const baseCount = baseMarkerCount(cm, ctx.markerOpacity, lodBand, ctx.viewBounds);
	const seen = isSeenOverlayActive() ? getSeenOverlayEntries() : [];
	const stagedActive = getActiveLocation();
	const showPreview =
		getWorkArea() === "import" || (stagedActive != null && isImportPreview(stagedActive));
	const previewPos = showPreview ? getImportPreviewPositions() : new Float32Array(0);
	const previewCount = previewPos.length / 2;
	const activeLoc = getActiveLocation();
	const selBuf = lodBand != null && cm.selOverlayCount > 0 ? cm.getSelOverlayLod(lodBand) : null;
	const selCount = selBuf ? selBuf.count : cm.selOverlayCount;
	const order: DrawOrder = {
		base: 0,
		total: baseCount + seen.length + selCount + previewCount + (activeLoc ? 1 : 0),
	};

	layers.push(
		...baseMarkerLayers(
			cm,
			ctx.markerStyle,
			ctx.markerOpacity,
			order,
			ctx.markerSize,
			lodBand,
			ctx.viewBounds,
		),
	);

	if (seen.length > 0) {
		layers.push(
			dotLayer(
				"seen-overlay",
				seen.length,
				order,
				{
					data: seen,
					getPosition: (d: SeenEntry) => [d.lng, d.lat],
					getFillColor: seenEntryColor,
					updateTriggers: { getFillColor: [getSeenOnMapIds()] },
				},
				5,
			),
		);
	}

	// Selection overlay rides on top of the base cells; the CPU hit-test gives it the
	// same priority (selected markers resolve above unselected overlaps). In LOD mode
	// it decimates like the base cells (selBuf), each rep keeping its selection color.
	if (selCount > 0) {
		layers.push(
			buildMarkerLayer(
				ctx.markerStyle,
				"sel-overlay",
				selCount,
				selBuf ?? {
					positions: cm.selOverlayPositions,
					colors: cm.selOverlayColors,
					angles: cm.selOverlayAngles,
				},
				selBuf ? `lod:${selBuf.version}` : `full:${cm.selOverlayVersion}`,
				selBuf ? `lod:${selBuf.version}` : `full:${cm.selOverlayVersion}`,
				order,
				undefined,
				ctx.markerSize,
			),
		);
		order.base += selCount;
	}

	// Staged import preview markers; clicking one opens a read-only preview. Drawn *under* the
	// active marker, which highlights whichever staged location is open — no per-index coloring.
	if (previewCount > 0) {
		layers.push(
			dotLayer("import-preview", previewCount, order, {
				data: {
					length: previewCount,
					attributes: { getPosition: { value: previewPos, size: 2 } },
				},
				getFillColor: [
					ctx.importPreviewColor.r,
					ctx.importPreviewColor.g,
					ctx.importPreviewColor.b,
					200,
				],
			}),
		);
	}

	// Active marker renders even with no committed locations so virtual previews (staged/seen)
	// on an empty map still show — and it draws on top of the preview dots, which is the highlight.
	if (activeLoc) {
		const s = MARKER_STYLE[ctx.markerStyle];
		layers.push(
			new SDFMarkerLayer<Location>({
				id: `${LOCATION_LAYER_ID}-current`,
				data: [activeLoc],
				getPosition: (d) => [d.lng, d.lat],
				shape: s.shape,
				radiusPixels: s.radiusPixels * ctx.markerSize,
				getFillColor: [
					ctx.activeLocationColor.r,
					ctx.activeLocationColor.g,
					ctx.activeLocationColor.b,
					255,
				],
				...(s.angle ? { getAngle: (d: Location) => -d.heading } : {}),
				orderBase: order.base,
				orderTotal: order.total,
				pickable: false,
				updateTriggers: { getAngle: [ctx.markerStyle] },
			}),
		);
		order.base += 1;
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
				parameters: NO_DEPTH_WRITE,
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
				parameters: NO_DEPTH_WRITE,
			}),
		);
	}

	const freehand = ctx.freehandPath;
	if (freehand && freehand.length >= 2) {
		layers.push(
			new PathLayer({
				id: "freehand-drawing",
				data: [normalizeRing(freehand)],
				getPath: (d) => d,
				getColor: [255, 255, 255, 200],
				getWidth: 3,
				widthUnits: "pixels" as const,
				jointRounded: true,
				capRounded: true,
				pickable: false,
				parameters: NO_DEPTH_WRITE,
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
				parameters: NO_DEPTH_WRITE,
			}),
		);
	}

	return layers;
}
