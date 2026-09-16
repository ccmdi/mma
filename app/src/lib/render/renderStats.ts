// Live render-pipeline stats: deck.gl metrics from registered overlays plus
// analytic fragment/overdraw estimates from the scene buffers. Hardware fragment
// counters aren't exposed to WebGL, but every marker is an instanced quad whose
// size we set, so the estimate is geometry math, not sampling. Feeds the Stats
// for Nerds "Rendering" section and the window.__mmaPerf perf-harness bridge.

import { getScene, whenSceneSettled } from "@/lib/render/sceneStore";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { MARKER_STYLE } from "@/lib/render/markerLayer";
import { getMapHost } from "@/lib/map/mapState";
import type { MapHost } from "@/lib/map/host";
import { MAP_EMBED_PREFS, type MapEmbedPrefs } from "@/store/mapEmbedPrefs";
import type { Bounds, MarkerStyle } from "@/types";
import {
	startFrameMeter,
	stopFrameMeter,
	resetFrameMeter,
	frameStats,
	setFrameProbe,
	type FrameStats,
} from "@/lib/render/frameMeter";

/** Structural mirror of deck.gl's internal DeckMetrics (not exported from the package root). */
export interface DeckMetrics {
	fps: number;
	layersCount: number;
	/** Draws in the latest screen pass; one logical layer can draw in multiple viewports. */
	drawLayersCount: number;
	framesRedrawn: number;
	gpuTime: number;
	gpuTimePerFrame: number;
	cpuTime: number;
	cpuTimePerFrame: number;
	bufferMemory: number;
	textureMemory: number;
	renderbufferMemory: number;
	gpuMemory: number;
}

export interface DeckStatsSource {
	getLayerCount(): number;
	getMetrics(): DeckMetrics | null;
	getGl?(): WebGLRenderingContext | WebGL2RenderingContext | null;
}

const sources = new Set<DeckStatsSource>();

export function registerDeckStats(s: DeckStatsSource): () => void {
	sources.add(s);
	return () => sources.delete(s);
}

/** Metrics of the first overlay that has them (the editor map registers first). */
export function getDeckMetrics(): DeckMetrics | null {
	for (const s of sources) {
		const m = s.getMetrics();
		if (m) return m;
	}
	return null;
}

/** Rasterized quad area of one marker instance in device pixels. The quad extends
 *  radius + 0.5px smooth edge per side (see sdf-marker-vertex.glsl edgePadding). */
export function markerQuadPx(radiusPixels: number, sizeScale: number, dpr: number): number {
	const half = (radiusPixels * sizeScale + 0.5) * dpr;
	return (2 * half) ** 2;
}

/** Count markers inside bounds; supports antimeridian-crossing bounds (west > east). */
export function countInBounds(
	cells: Iterable<{ count: number; positions: Float32Array }>,
	b: Bounds,
): number {
	const wraps = b.west > b.east;
	let n = 0;
	for (const cb of cells) {
		const pos = cb.positions;
		for (let i = 0; i < cb.count; i++) {
			const lat = pos[i * 2 + 1];
			if (lat < b.south || lat > b.north) continue;
			const lng = pos[i * 2];
			if (wraps ? lng >= b.west || lng <= b.east : lng >= b.west && lng <= b.east) n++;
		}
	}
	return n;
}

export interface RenderStats {
	totalMarkers: number;
	onScreenMarkers: number;
	selOverlay: number;
	layers: number;
	markerStyle: MarkerStyle;
	markerSize: number;
	/** Quad side length in CSS px (what one marker rasterizes as). */
	quadSidePx: number;
	estFragments: number;
	viewportPx: number;
	/** estFragments / viewport device pixels - the "waste" number. */
	overdraw: number;
	dpr: number;
}

function currentPrefs(): MapEmbedPrefs {
	return getLocal(MAP_EMBED_PREFS);
}

export function computeRenderStats(): RenderStats | null {
	const host = getMapHost();
	const bounds = host?.getBounds();
	if (!host || !bounds) return null;
	const scene = getScene();
	const prefs = currentPrefs();
	const dpr = window.devicePixelRatio || 1;
	const s = MARKER_STYLE[prefs.markerStyle];
	const quad = markerQuadPx(s.radiusPixels, prefs.markerSize, dpr);
	const onScreen = countInBounds(scene.cells.values(), bounds);
	const el = host.container;
	const viewportPx = el.clientWidth * el.clientHeight * dpr * dpr;
	const estFragments = onScreen * quad;
	let layers = 0;
	for (const src of sources) layers = Math.max(layers, src.getLayerCount());
	return {
		totalMarkers: scene.totalCount,
		onScreenMarkers: onScreen,
		selOverlay: scene.overlay.count,
		layers,
		markerStyle: prefs.markerStyle,
		markerSize: prefs.markerSize,
		quadSidePx: Math.sqrt(quad) / dpr,
		estFragments,
		viewportPx,
		overdraw: viewportPx > 0 ? estFragments / viewportPx : 0,
		dpr,
	};
}

export interface PerfBridge {
	start(): void;
	stop(): void;
	reset(): void;
	frames(): FrameStats;
	render(): RenderStats | null;
	deck(): DeckMetrics | null;
	host(): MapHost | null;
	/** Reactive pref write - flows through useLocalStorage, triggers a full scene reload. */
	setMarkerStyle(style: MarkerStyle): void;
	/** Reactive pref write - layer prop only, no scene reload. */
	setMarkerSize(size: number): void;
	/** Per-frame gl.finish() so frame deltas include real GPU cost. Harness-only. */
	probe(on: boolean): void;
	/** Resolves when the most recent full scene load has finished. */
	settled(): Promise<void>;
}

declare global {
	interface Window {
		__mmaPerf?: PerfBridge;
	}
}

// Harness bridge: the wdio perf specs drive the camera and read stats through this.
if (typeof window !== "undefined") {
	window.__mmaPerf = {
		start: startFrameMeter,
		stop: stopFrameMeter,
		reset: resetFrameMeter,
		frames: frameStats,
		render: computeRenderStats,
		deck: getDeckMetrics,
		host: getMapHost,
		setMarkerStyle: (style) =>
			setLocal(MAP_EMBED_PREFS, {
				...getLocal(MAP_EMBED_PREFS),
				markerStyle: style,
			}),
		setMarkerSize: (size) =>
			setLocal(MAP_EMBED_PREFS, {
				...getLocal(MAP_EMBED_PREFS),
				markerSize: size,
			}),
		probe: (on) => {
			if (!on) {
				setFrameProbe(null);
				return;
			}
			setFrameProbe(() => {
				for (const s of sources) {
					const gl = s.getGl?.();
					if (gl) {
						gl.finish();
						return;
					}
				}
			});
		},
		settled: whenSceneSettled,
	};
}
