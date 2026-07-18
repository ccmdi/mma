/**
 * Apple Look Around panorama dots — same construction and layer band as
 * Google's PanoCoverageLayer (deck.gl CompositeLayer → ScatterplotLayer).
 */
import { CompositeLayer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { boundsToTiles, tileKey, type Tile } from "@/lib/geo/photometa";
import { getCoverageInMapTile, peekCoverageInMapTile } from "@/lib/sv/lookaround/tile";
import {
	getProviderSettings,
	isProviderEnabled,
} from "@/lib/sv/providers/settings";
import type {
	CompositeLayerProps,
	Color,
	DefaultProps,
	LayerContext,
	UpdateParameters,
} from "@deck.gl/core";

type _LookAroundPanoCoverageLayerProps = {
	minZoom?: number;
};

export type LookAroundPanoCoverageLayerProps = _LookAroundPanoCoverageLayerProps &
	CompositeLayerProps;

const defaultProps: DefaultProps<LookAroundPanoCoverageLayerProps> = {
	minZoom: 14.9,
};

const FLUSH_MS = 150;
let activeLayer: LookAroundPanoCoverageLayer | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush(): void {
	if (flushTimer !== undefined) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		activeLayer?.setState({ rev: (activeLayer.state.rev ?? 0) + 1 });
	}, FLUSH_MS);
}

function parseRgba(css: string, fallback: Color): Color {
	const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (!m) return fallback;
	return [Number(m[1]), Number(m[2]), Number(m[3]), 180];
}

export default class LookAroundPanoCoverageLayer extends CompositeLayer<
	Required<_LookAroundPanoCoverageLayerProps>
> {
	static layerName = "LookAroundPanoCoverageLayer";
	static defaultProps = defaultProps;

	declare state: { tiles: Tile[]; rev: number };

	initializeState(): void {
		this.setState({ tiles: [], rev: 0 });
	}

	finalizeState(context: LayerContext): void {
		super.finalizeState(context);
		if (activeLayer === this) activeLayer = null;
	}

	shouldUpdateState({ changeFlags }: UpdateParameters<this>): boolean {
		return changeFlags.somethingChanged;
	}

	updateState({ context }: UpdateParameters<this>): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- flush must target the live matched instance
		activeLayer = this;
		if (!isProviderEnabled("apple") || !getProviderSettings("apple").showPoints) {
			if (this.state.tiles.length) this.setState({ tiles: [] });
			return;
		}
		if (context.viewport.zoom < this.props.minZoom) {
			if (this.state.tiles.length) this.setState({ tiles: [] });
			return;
		}
		const [west, south, east, north] = context.viewport.getBounds();
		const inView = boundsToTiles(west, south, east, north);
		const known = new Set(this.state.tiles.map(tileKey));
		const fresh = inView.filter((t) => !known.has(tileKey(t)));
		if (fresh.length === 0 && inView.length === this.state.tiles.length) return;
		for (const t of inView) {
			void getCoverageInMapTile(t.x, t.y).then((d) => d.length && scheduleFlush());
		}
		this.setState({ tiles: inView });
	}

	renderLayers() {
		if (!isProviderEnabled("apple") || !getProviderSettings("apple").showPoints) return [];
		const s = getProviderSettings("apple");
		const carColor = parseRgba(s.pointStroke, [26, 159, 176, 180]);
		const trekkerColor = parseRgba(s.trekkerPointStroke, [173, 140, 191, 180]);
		const scale = Math.max(0.25, s.pointSizeScale);

		const car: number[] = [];
		const trekker: number[] = [];
		for (const t of this.state.tiles) {
			const panos = peekCoverageInMapTile(t.x, t.y);
			if (!panos?.length) continue;
			for (const p of panos) {
				const isCar = (p.coverageType ?? 2) === 2;
				const buf = isCar ? car : trekker;
				buf.push(p.lon, p.lat);
			}
		}

		const layers: ScatterplotLayer[] = [];
		const mk = (id: string, positions: number[], color: Color) => {
			if (!positions.length) return;
			const n = positions.length / 2;
			layers.push(
				new ScatterplotLayer({
					id: `${this.props.id}-${id}`,
					data: {
						length: n,
						attributes: {
							getPosition: { value: new Float32Array(positions), size: 2 },
						},
					},
					getFillColor: color,
					radiusUnits: "pixels",
					getRadius: 4 * scale,
					radiusMaxPixels: 8 * scale,
					stroked: false,
					filled: true,
					opacity: s.pointsOpacity,
					pickable: false,
				}),
			);
		};
		mk("car", car, carColor);
		mk("trekker", trekker, trekkerColor);
		return layers;
	}
}
