/**
 * Local Look Around panorama viewer (Photo Sphere Viewer + lookaround-map adapter).
 * Ported from lookaround-map `js/viewer/viewer.js` (MIT) with MMA fixes:
 * - wait for movement plugin before updatePanoMarkers
 * - sanitize missing elevations
 * - request Orientation on warm nearby sweep
 * - nearbyPanosChangedCallback for LocationPreview proxy
 */
import { Viewer } from "@photo-sphere-viewer/core";
import { MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";

import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";

import type { LookaroundPano } from "../api";
import { LookaroundApi, META_NEARBY, NEARBY_LIMIT, NEARBY_RADIUS_M } from "../api";
import {
	AdditionalMetadata,
	ImageFormat,
	InitialOrientation,
	type ImageFormatValue,
	type InitialOrientationValue,
} from "./enums";
import { DEG2RAD, distanceBetween } from "./geo";
import { installCursorAnchoredZoom } from "./cursorAnchoredZoom";
import { LookAroundAdapter } from "./LookAroundAdapter";
import { MovementPlugin } from "./MovementPlugin";

export { AdditionalMetadata, ImageFormat, InitialOrientation };

export type CreatePanoViewerConfig = {
	container: HTMLElement;
	initialPano: LookaroundPano;
	apiBaseUrl: string;
	initialOrientation?: InitialOrientationValue;
	canMove?: boolean;
	canMoveWithKeyboard?: boolean;
	compassEnabled?: boolean;
	imageFormat?: ImageFormatValue;
	defaultZoomLevel?: number;
	minFov?: number;
	maxFov?: number;
	navigationCrossfadeDisablesPanning?: boolean;
	navigationCrossfadeDuration?: number;
	upgradeCrossfadeDuration?: number;
};

export type PanoViewerInstance = Viewer & {
	api: LookaroundApi;
	navigateTo: (
		pano: LookaroundPano,
		resetView?: boolean,
		showLoader?: boolean,
		position?: { yaw: number; pitch: number } | null,
	) => Promise<void>;
	moveInDirection: (
		direction: number,
		options?: {
			minDistance?: number;
			maxDistance?: number;
			tolerance?: number;
			resetView?: boolean;
			showLoader?: boolean;
			position?: { yaw: number; pitch: number };
		},
	) => LookaroundPano | null | Promise<LookaroundPano | null>;
	takeScreenshot: () => string;
	alternativeDatesChangedCallback: (dates: LookaroundPano[]) => void;
	nearbyPanosChangedCallback: (ref: LookaroundPano, nearby: LookaroundPano[]) => void;
	plugins: {
		movement?: MovementPlugin;
		markers?: unknown;
	};
};

function getHeading(initialOrientation: InitialOrientationValue, heading: number): number {
	switch (initialOrientation) {
		case InitialOrientation.Road:
			return -heading;
		case InitialOrientation.North:
		default:
			return 0;
	}
}

function getAlternativeDates(
	refPano: LookaroundPano,
	nearbyPanos: LookaroundPano[],
): LookaroundPano[] {
	const MAX_DISTANCE = 20 / 1000;
	const alternativeDates: Record<string, [LookaroundPano, number]> = {};
	const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
		dateStyle: "short",
		timeZone: refPano.timezone || "UTC",
	});
	const refTs = refPano.timestamp;
	if (refTs == null) return [];
	const refDate = dateTimeFormat.format(new Date(refTs));

	for (const pano of nearbyPanos) {
		if (pano.timestamp == null) continue;
		const date = dateTimeFormat.format(new Date(pano.timestamp));
		if (refDate === date) continue;
		const distance = distanceBetween(refPano.lat, refPano.lon, pano.lat, pano.lon);
		if (distance > MAX_DISTANCE) continue;
		const prev = alternativeDates[date];
		if (!prev || prev[1] > distance) {
			alternativeDates[date] = [pano, distance];
		}
	}

	return Object.keys(alternativeDates)
		.map((k) => alternativeDates[k]![0])
		.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

function sanitizeElevations(ref: LookaroundPano, nearby: LookaroundPano[]): void {
	const a = ref.elevation ?? 0;
	ref.elevation = a;
	for (const p of nearby) {
		p.elevation ??= a;
	}
}

async function waitForMovementPlugin(viewer: PanoViewerInstance): Promise<void> {
	if (viewer.plugins.movement) return;
	await new Promise<void>((resolve) => {
		if (viewer.plugins.movement) {
			resolve();
			return;
		}
		const onReady = () => {
			viewer.removeEventListener("ready", onReady);
			resolve();
		};
		viewer.addEventListener("ready", onReady);
		window.setTimeout(() => {
			viewer.removeEventListener("ready", onReady);
			resolve();
		}, 3000);
	});
}

async function updateMarkers(viewer: PanoViewerInstance, pano: LookaroundPano): Promise<void> {
	await waitForMovementPlugin(viewer);
	const nearbyPanos = await viewer.api.getClosestPanos(
		pano.lat,
		pano.lon,
		NEARBY_RADIUS_M,
		NEARBY_LIMIT,
		[...META_NEARBY, AdditionalMetadata.Orientation],
	);
	sanitizeElevations(pano, nearbyPanos);
	viewer.plugins.movement?.updatePanoMarkers(pano, nearbyPanos);
	try {
		viewer.nearbyPanosChangedCallback?.(pano, nearbyPanos);
	} catch {
		/* ignore consumer errors */
	}
	const alternativeDates = getAlternativeDates(pano, nearbyPanos);
	viewer.alternativeDatesChangedCallback(alternativeDates);
}

function configurePlugins(config: Required<
	Pick<
		CreatePanoViewerConfig,
		"canMove" | "canMoveWithKeyboard" | "compassEnabled"
	>
>): unknown[] {
	const plugins: unknown[] = [];
	if (config.canMove) {
		plugins.push([MarkersPlugin, {}]);
		plugins.push([
			MovementPlugin,
			{ canMoveWithKeyboard: config.canMoveWithKeyboard },
		]);
	}
	// Compass plugin intentionally omitted — LocationPreview never enables it.
	void config.compassEnabled;
	return plugins;
}

export async function createPanoViewer(
	raw: CreatePanoViewerConfig,
): Promise<PanoViewerInstance> {
	const config = {
		...raw,
		canMove: raw.canMove ?? true,
		canMoveWithKeyboard: raw.canMoveWithKeyboard ?? false,
		compassEnabled: raw.compassEnabled ?? true,
		navigationCrossfadeDisablesPanning: raw.navigationCrossfadeDisablesPanning ?? true,
		navigationCrossfadeDuration: raw.navigationCrossfadeDuration ?? 150,
		upgradeCrossfadeDuration: raw.upgradeCrossfadeDuration ?? 150,
		initialOrientation: raw.initialOrientation ?? InitialOrientation.North,
		defaultZoomLevel: raw.defaultZoomLevel ?? 20,
		minFov: raw.minFov ?? 10,
		maxFov: raw.maxFov ?? 100,
		imageFormat: raw.imageFormat ?? ImageFormat.HEIC,
	};

	const apiBaseUrl = config.apiBaseUrl ?? "";
	const plugins = configurePlugins(config);
	const defaultYaw = getHeading(
		config.initialOrientation,
		config.initialPano.heading ?? 0,
	);

	if (config.canMoveWithKeyboard) {
		config.container.tabIndex = -1;
		config.container.focus();
	}

	const viewer = new Viewer({
		container: config.container,
		adapter: LookAroundAdapter as never,
		panorama: {
			panorama: config.initialPano,
			url: `/pano/${config.initialPano.panoid}/${config.initialPano.buildId}/`,
		},
		panoData: {
			apiBaseUrl,
			navigationCrossfadeDisablesPanning: config.navigationCrossfadeDisablesPanning,
			navigationCrossfadeDuration: config.navigationCrossfadeDuration,
			upgradeCrossfadeDuration: config.upgradeCrossfadeDuration,
			imageFormat: config.imageFormat,
		} as never,
		minFov: config.minFov,
		maxFov: config.maxFov,
		defaultPitch: 0,
		defaultYaw,
		defaultZoomLvl: config.defaultZoomLevel,
		navbar: false,
		// Custom cursor-anchored wheel handler (see installCursorAnchoredZoom).
		mousewheel: false,
		sphereCorrection: {
			pan: config.initialPano.heading,
			tilt: config.initialPano.pitch,
			roll: config.initialPano.roll,
		},
		plugins: plugins as never,
		rendererParameters: {
			alpha: true,
			antialias: true,
			preserveDrawingBuffer: true,
		},
	}) as PanoViewerInstance;

	installCursorAnchoredZoom(viewer);

	viewer.api = new LookaroundApi(apiBaseUrl, apiBaseUrl, apiBaseUrl);
	viewer.alternativeDatesChangedCallback = () => {};
	viewer.nearbyPanosChangedCallback = () => {};

	viewer.navigateTo = async (
		pano,
		resetView = false,
		showLoader = false,
		position = null,
	) => {
		if (pano.heading == null) {
			const enriched = await viewer.api.getClosestPanos(pano.lat, pano.lon, 5, 1, [
				AdditionalMetadata.CameraMetadata,
				AdditionalMetadata.Elevation,
				AdditionalMetadata.Orientation,
				AdditionalMetadata.TimeZone,
			]);
			pano = enriched[0] ?? pano;
		}

		const setPanoramaOptions: Record<string, unknown> = {
			showLoader,
			sphereCorrection: {
				pan: pano.heading,
				tilt: pano.pitch,
				roll: pano.roll,
			},
		};
		if (position) {
			setPanoramaOptions.position = position;
		} else if (resetView) {
			setPanoramaOptions.position = {
				yaw: getHeading(config.initialOrientation, pano.heading ?? 0),
				pitch: 0,
			};
			setPanoramaOptions.zoom = config.defaultZoomLevel;
		}

		await Promise.all([
			viewer.setPanorama(
				{
					panorama: pano,
					url: `/pano/${pano.panoid}/${pano.buildId}/`,
				},
				setPanoramaOptions as never,
			),
			updateMarkers(viewer, pano),
		]);
	};

	viewer.moveInDirection = (direction, options) => {
		direction = (-direction + Math.PI / 2) % (Math.PI * 2);
		const opts = {
			minDistance: options?.minDistance ?? 0,
			maxDistance: options?.maxDistance ?? 25,
			tolerance: options?.tolerance ?? 30 * DEG2RAD,
			resetView: options?.resetView ?? false,
			showLoader: options?.showLoader ?? false,
			position: options?.position,
		};
		const pano = viewer.plugins.movement?.getClosestPanoInDirection(
			direction,
			opts.minDistance,
			opts.maxDistance,
			opts.tolerance,
		);
		if (pano) {
			void viewer.navigateTo(pano, opts.resetView, opts.showLoader, opts.position);
		}
		return pano ?? null;
	};

	void updateMarkers(viewer, config.initialPano);

	const crossfadeCanvas = document.createElement("canvas");
	crossfadeCanvas.id = "crossfade-canvas";
	const psvContainer = config.container.querySelector(".psv-container") ?? config.container;
	psvContainer.appendChild(crossfadeCanvas);

	if (!document.getElementById("lookaround-crossfade-style")) {
		const style = document.createElement("style");
		style.id = "lookaround-crossfade-style";
		style.textContent = `
			#crossfade-canvas {
				z-index: 9;
				display: none;
				opacity: 1;
				position: absolute;
			}
		`;
		document.head.appendChild(style);
	}

	viewer.takeScreenshot = () => {
		const canvas = config.container.querySelector(".psv-canvas") as HTMLCanvasElement | null;
		return canvas?.toDataURL("image/jpeg", 1.0) ?? "";
	};

	return viewer;
}
