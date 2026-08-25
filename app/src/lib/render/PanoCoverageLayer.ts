import { CompositeLayer } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import {
	boundsToTiles,
	fetchPanoDots,
	peekPanoDots,
	tileKey,
	type PanoDot,
	type Tile,
} from "@/lib/geo/photometa";
import type {
	CompositeLayerProps,
	Color,
	DefaultProps,
	LayerContext,
	UpdateParameters,
} from "@deck.gl/core";

type _PanoCoverageLayerProps = {
	color?: Color;
	// radius in meters (grows when zoomed in) vs. a constant on-screen pixel size
	scaled?: boolean;
	minZoom?: number;
};

export type PanoCoverageLayerProps = _PanoCoverageLayerProps & CompositeLayerProps;

const defaultProps: DefaultProps<PanoCoverageLayerProps> = {
	color: [255, 0, 0],
	scaled: false,
	minZoom: 14.9,
};

// Batch fetch arrivals: resolved tiles sit in the photometa cache until one
// timer pokes deck, so a burst of ~150 tile responses costs a handful of
// update passes instead of one per arrival. Module-level because deck.gl
// re-creates layer instances on scene rebuilds.
const FLUSH_MS = 150;
let activeLayer: PanoCoverageLayer | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush(): void {
	if (flushTimer !== undefined) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		activeLayer?.setState({ rev: (activeLayer.state.rev ?? 0) + 1 });
	}, FLUSH_MS);
}

// One sublayer per zoom-17 tile, with the cached resolved dots as `data`.
// deck.gl never sees promises: unresolved and empty tiles produce no sublayer,
// and a tile's data identity is stable once resolved, so existing tiles are
// skipped entirely on rebuilds.
export default class PanoCoverageLayer extends CompositeLayer<Required<_PanoCoverageLayerProps>> {
	static layerName = "PanoCoverageLayer";
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
		if (context.viewport.zoom < this.props.minZoom) {
			if (this.state.tiles.length) this.setState({ tiles: [] });
			return;
		}
		const [west, south, east, north] = context.viewport.getBounds();
		const inView = boundsToTiles(west, south, east, north);
		const known = new Set(this.state.tiles.map(tileKey));
		const fresh = inView.filter((t) => !known.has(tileKey(t)));
		// Rebuild whenever the visible tile set changes, not only when tiles enter:
		// zooming in produces no fresh tiles but must still prune the ones that left.
		if (fresh.length === 0 && inView.length === this.state.tiles.length) return;
		for (const t of inView) {
			const r = fetchPanoDots(t);
			if (r instanceof Promise) void r.then((d) => d.length && scheduleFlush());
		}
		this.setState({ tiles: inView });
	}

	// All in-view dots flattened into ONE layer with a binary position buffer:
	// per-tile sublayers caused constant deck layer creation (model/buffer setup)
	// as fetches trickled in, which is far costlier than rebuilding this small
	// buffer (in-view dots only, once per flush).
	renderLayers() {
		const { color, scaled } = this.props;
		const resolved: PanoDot[][] = [];
		let n = 0;
		for (const t of this.state.tiles) {
			const dots = peekPanoDots(t);
			if (!dots?.length) continue;
			resolved.push(dots);
			n += dots.length;
		}
		if (!n) return [];
		const positions = new Float32Array(n * 2);
		let i = 0;
		for (const dots of resolved) {
			for (const d of dots) {
				positions[i++] = d.lng;
				positions[i++] = d.lat;
			}
		}
		return new ScatterplotLayer({
			id: `${this.props.id}-dots`,
			data: { length: n, attributes: { getPosition: { value: positions, size: 2 } } },
			getFillColor: color,
			radiusUnits: scaled ? "meters" : "pixels",
			getRadius: scaled ? 2 : 4,
			radiusMaxPixels: scaled ? 24 : 4,
			stroked: false,
			filled: true,
			opacity: 0.7,
			pickable: false,
		});
	}
}
