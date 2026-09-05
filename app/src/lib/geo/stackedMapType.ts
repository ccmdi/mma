import { google } from "@/lib/sv/opensv";
import { TILE_SIZE } from "@/lib/geo/mercator";

/** One raster layer of the composite: where its tile lives, and how it blends. */
export interface TileLayer {
	url(x: number, y: number, zoom: number): string;
	/** Alpha this layer draws at, per zoom. Omitted means opaque. */
	opacity?(zoom: number): number;
	minZoom?: number;
	maxZoom?: number;
}

interface TileState {
	/** Loaded image per drawn-layer index; sparse until each one arrives. */
	images: (HTMLImageElement | null)[];
	/** In-flight loaders, so a released tile can stop fetching and let go of its bitmaps. */
	loading: HTMLImageElement[];
	/** Layers yet to settle, by load or by error. */
	pending: number;
	released: boolean;
}

const covers = (l: TileLayer, zoom: number) =>
	zoom >= (l.minZoom ?? -Infinity) && zoom <= (l.maxZoom ?? Infinity);

/**
 * Repaint the whole stack in layer order. Tiles arrive out of order, so each arrival
 * redraws from scratch rather than blending onto whatever landed first.
 */
function paint(
	canvas: HTMLCanvasElement,
	layers: TileLayer[],
	images: (HTMLImageElement | null)[],
	zoom: number,
) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	let size = TILE_SIZE;
	for (const img of images) {
		if (img && img.naturalWidth > size) size = img.naturalWidth;
	}
	// Assigning width clears the canvas; only clear explicitly when the size is unchanged.
	if (canvas.width !== size) canvas.width = canvas.height = size;
	else ctx.clearRect(0, 0, size, size);
	for (let i = 0; i < layers.length; i++) {
		const img = images[i];
		if (!img) continue;
		ctx.globalAlpha = layers[i].opacity?.(zoom) ?? 1;
		ctx.drawImage(img, 0, 0, size, size);
	}
	ctx.globalAlpha = 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-created class
let CompositeMapType: any = null;

// Defined lazily: the class extends google.maps.ImageMapType, which only exists
// after opensv has loaded.
function initCompositeMapType() {
	if (CompositeMapType) return;
	CompositeMapType = class extends google.maps.ImageMapType {
		layers: TileLayer[];
		private tiles = new WeakMap<HTMLCanvasElement, TileState>();

		constructor(layers: TileLayer[], opts: google.maps.ImageMapTypeOptions) {
			super({ ...opts, getTileUrl: () => null });
			this.layers = layers;
		}

		/** One canvas per tile position, whatever the stack depth. Google treats the returned
		 *  element as the tile, so N layers meant N images plus a wrapper for the browser to
		 *  lay out, paint and composite - the cost that made a fast zoom-out stall the app. */
		getTile(coord: TileCoord | null, zoom: number, doc: Document | null) {
			if (!coord || !doc) return null;
			const canvas = doc.createElement("canvas");
			canvas.width = canvas.height = TILE_SIZE;
			canvas.style.width = canvas.style.height = `${TILE_SIZE}px`;

			const drawn = this.layers.filter((l) => covers(l, zoom));
			const state: TileState = {
				images: new Array(drawn.length).fill(null),
				loading: [],
				pending: drawn.length,
				released: false,
			};
			this.tiles.set(canvas, state);

			if (drawn.length === 0) {
				// Nothing covers this zoom, but the map still waits on the tile's `load`.
				void Promise.resolve().then(() => {
					if (!state.released) google.maps.event.trigger(canvas, "load");
				});
				return canvas;
			}

			const settle = () => {
				if (state.released || --state.pending > 0) return;
				// The sources were only held so a late arrival could repaint the stack in
				// order. Nothing repaints once they have all settled, so let the decoded
				// bitmaps go and leave the tile costing one canvas.
				state.images.length = 0;
				state.loading.length = 0;
				google.maps.event.trigger(canvas, "load");
			};
			drawn.forEach((layer, i) => {
				const img = new Image();
				img.onload = () => {
					img.onload = img.onerror = null;
					if (!state.released) {
						state.images[i] = img;
						paint(canvas, drawn, state.images, zoom);
					}
					settle();
				};
				img.onerror = () => {
					img.onload = img.onerror = null;
					settle();
				};
				img.src = layer.url(coord.x, coord.y, zoom);
				state.loading.push(img);
			});
			return canvas;
		}

		/** Drops the fetches and the decoded bitmaps. A tile scrolled away mid-load used to
		 *  stay pinned by its pending load listener for the life of the page. */
		releaseTile(canvas: HTMLCanvasElement) {
			const state = this.tiles.get(canvas);
			if (!state) return;
			state.released = true;
			for (const img of state.loading) {
				img.onload = img.onerror = null;
				img.src = "";
			}
			state.loading.length = 0;
			state.images.length = 0;
			this.tiles.delete(canvas);
		}
	};
}

export function createCompositeMapType(layers: TileLayer[]): google.maps.ImageMapType {
	initCompositeMapType();
	return new CompositeMapType(layers, {
		tileSize: new google.maps.Size(TILE_SIZE, TILE_SIZE),
		minZoom: 0,
		maxZoom: 20,
	});
}
