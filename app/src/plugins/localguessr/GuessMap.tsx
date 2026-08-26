import { fetchBounds } from "@/store/useMapStore";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import type React from "react";
import { ScatterplotLayer, PathLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { Icon } from "@/components/primitives/Icon";
import {
	mdiLayers,
	mdiPlus,
	mdiMinus,
	mdiMagnifyPlusOutline,
	mdiMagnifyMinusOutline,
} from "@mdi/js";
import {
	createMapHost,
	hostInstance,
	hostKindForMapType,
	type DeckOverlayHandle,
	type MapHost,
} from "@/lib/map/host";
import { CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { google } from "@/lib/sv/opensv";
import type * as maplibregl from "maplibre-gl";
import { useLocalStorage, getLocal } from "@/lib/hooks/useLocalStorage";
import { useHoverExpand, panelSize } from "@/lib/hooks/useHoverExpand";
import { useSetting } from "@/store/settings";
import { usePluginState } from "@/plugins/registry";
import { clamp, range } from "@/types/util";
import { MAP_EMBED_PREFS, type MapEmbedPrefs } from "@/store/mapEmbedPrefs";

import { t } from "@/lib/i18n";
import type { Selector } from "@/bindings.gen";
import type { LatLng, MapTypeKey } from "@/types";

// Sizing mirrors the pano viewer minimap. Grows in layout, never by transform --
// a CSS-scaled map container misreports click coordinates.
const SCALE = range([0.5, 2]);
const SCALE_STEP = 0.25;
const BASE_W = 800;
const BASE_H = 600;
const BASEMAPS: MapTypeKey[] = ["map", "satellite", "osm", "vector"];
const GUESS_COLOR: [number, number, number] = [64, 133, 244];
const TRUTH_COLOR: [number, number, number] = [76, 175, 80];

/** A pin and its shadow halo, so the circle separates from same-colored basemap. */
function pinLayers(id: string, at: LatLng, color: [number, number, number], pickable: boolean) {
	return [
		new ScatterplotLayer({
			id: `${id}-halo`,
			data: [at],
			getPosition: (d: LatLng) => [d.lng, d.lat],
			getFillColor: [0, 0, 0, 90],
			radiusUnits: "pixels",
			getRadius: 11,
			pickable: false,
		}),
		new ScatterplotLayer({
			id,
			data: [at],
			getPosition: (d: LatLng) => [d.lng, d.lat],
			getFillColor: color,
			getLineColor: [255, 255, 255],
			getLineWidth: 2,
			lineWidthUnits: "pixels",
			stroked: true,
			radiusUnits: "pixels",
			getRadius: 8,
			pickable,
		}),
	];
}

/** Dashed guess-to-answer line, GeoGuessr contract: everything is anchored to the
 *  map (common units + high-precision dash), so mid-animation the pattern scales
 *  with the world like a texture; it re-normalizes to standard pixel size exactly
 *  once per settled zoom, via `settledZoom`. */
function resultLineLayer(guess: LatLng, truth: LatLng, settledZoom: number) {
	// Under the maps overlay, deck's zoom sits one below the host's; one common
	// unit is 2^(zoom-1) screen px, so this width reads as 2.5px at the settled zoom.
	const width = 2.5 / 2 ** (settledZoom - 1);
	return new PathLayer({
		id: "lg-line",
		data: [
			{
				path: [
					[guess.lng, guess.lat],
					[truth.lng, truth.lat],
				],
			},
		],
		getPath: (d: { path: [number, number][] }) => d.path,
		getColor: [25, 25, 25, 240],
		getWidth: width,
		widthUnits: "common",
		capRounded: true,
		getDashArray: [4, 3],
		extensions: [new PathStyleExtension({ dash: true, highPrecisionDash: true })],
	});
}

/**
 * The guess map. One MapHost for the whole game: toggling play/result only swaps
 * CSS and layers, because recreating it burns a WebGL context every round.
 */
export function GuessMap({
	guess,
	truth,
	showResult,
	roundKey,
	selector,
	onGuess,
	onSubmit,
	submitting,
}: {
	guess: LatLng | null;
	truth: LatLng | null;
	showResult: boolean;
	/** Changes per round; refits the camera without reacting to guess placement. */
	roundKey: string;
	selector: Selector;
	onGuess: (p: LatLng) => void;
	onSubmit: () => void;
	submitting: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const hostRef = useRef<MapHost | null>(null);
	const overlayRef = useRef<DeckOverlayHandle | null>(null);
	const [ready, setReady] = useState(false);
	const [scale, setScale] = usePluginState<number>("localguessr", "mapScale", 1);
	const closeDelay = useSetting("fullscreenMinimapCloseDelay");
	const { expanded, hoverProps } = useHoverExpand(rootRef, closeDelay);
	// Per round: the hook carries `expanded` across the result, and resetting
	// in an effect leaves a window where a pointerenter re-opens it.
	const [hoveredRound, setHoveredRound] = useState<string | null>(null);
	const hovered = hoveredRound === roundKey;

	// Suppresses the transition for the commit that crosses the result boundary; must be
	// derived, or the class lands after the size change has begun animating.
	const [settled, setSettled] = useState(showResult);
	const instant = settled !== showResult;
	useEffect(() => {
		if (instant) setSettled(showResult);
	}, [instant, showResult]);
	const [prefs] = useLocalStorage(MAP_EMBED_PREFS);
	const [basemap, setBasemap] = useState<MapTypeKey>(() => prefs.mapType);

	// Read via refs so the click listener binds once.
	const onGuessRef = useRef(onGuess);
	onGuessRef.current = onGuess;
	const lockedRef = useRef(showResult);
	lockedRef.current = showResult;
	/** Location bounds, resolved once with the host so per-round fits never await. */
	const boundsRef = useRef<[number, number, number, number] | null>(null);

	const guessPrefs: MapEmbedPrefs = {
		...prefs,
		mapType: basemap,
		svPanoramas: false,
		svVisible: false,
	};
	const hostKind = hostKindForMapType(basemap);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let cancelled = false;
		const div = document.createElement("div");
		div.style.cssText = "position:absolute;inset:0";
		container.appendChild(div);

		void (async () => {
			try {
				// Bounds up front so per-round fits stay synchronous -- awaiting IPC inside
				// the fit paints a frame of the previous round's camera.
				const [host, bounds] = await Promise.all([
					createMapHost(hostKind, div, guessPrefs, {
						customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
						camera: { center: { lat: 20, lng: 0 }, zoom: 1.5 },
						scaleControl: false,
					}),
					fetchBounds(selector),
				]);
				if (cancelled) {
					host.destroy();
					return;
				}
				boundsRef.current = bounds;
				host.setCursor("crosshair");
				hostRef.current = host;
				overlayRef.current = host.createDeckOverlay();
				fitToLocations();
				setReady(true);
			} catch {
				if (!cancelled) setReady(false);
			}
		})();

		return () => {
			cancelled = true;
			overlayRef.current?.finalize();
			overlayRef.current = null;
			hostRef.current?.destroy();
			hostRef.current = null;
			div.remove();
			setReady(false);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- engine kind only; prefs apply in place
	}, [hostKind]);

	// Same engine (map/satellite/osm all share one Google instance): restyle in place.
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !ready || hostKindForMapType(basemap) !== host.kind) return;
		host.applyPrefs(guessPrefs, {
			customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- guessPrefs is derived from basemap
	}, [basemap, ready]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !ready) return;
		const place = (p: LatLng) => {
			if (!lockedRef.current) onGuessRef.current(p);
		};

		const gmap = hostInstance(host, "google");
		if (gmap) {
			const listener = gmap.addListener("click", (e: google.maps.MapMouseEvent) => {
				if (e.latLng) place({ lat: e.latLng.lat(), lng: e.latLng.lng() });
			});
			return () => google.maps.event.removeListener(listener);
		}
		const ml = hostInstance(host, "maplibre");
		if (ml) {
			const onClick = (e: maplibregl.MapMouseEvent) =>
				place({ lat: e.lngLat.lat, lng: e.lngLat.lng });
			ml.on("click", onClick);
			return () => void ml.off("click", onClick);
		}
	}, [ready]);

	useEffect(() => {
		hostRef.current?.setCursor(showResult ? null : "crosshair");
	}, [showResult]);

	// The line re-normalizes once per zoom level (the `zoom` event fires per step,
	// already carrying the target value) and simply scales with the map in between.
	const [settledZoom, setSettledZoom] = useState<number | null>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !ready || !showResult) {
			setSettledZoom(null);
			return;
		}
		setSettledZoom(host.getZoom());
		return host.on("zoom", () => setSettledZoom(hostRef.current?.getZoom() ?? null));
	}, [ready, showResult]);

	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay || !ready) return;
		const layers = [];
		if (showResult && truth && guess && settledZoom !== null) {
			layers.push(resultLineLayer(guess, truth, settledZoom));
		}
		if (guess) layers.push(...pinLayers("lg-guess", guess, GUESS_COLOR, false));
		if (showResult && truth) layers.push(...pinLayers("lg-truth", truth, TRUTH_COLOR, false));
		overlay.setProps({ layers });
	}, [guess, truth, showResult, ready, settledZoom]);

	const fitToLocations = useCallback(() => {
		const host = hostRef.current;
		if (!host) return;
		host.resize();
		const b = boundsRef.current;
		if (!b) return;
		host.fitBounds({ west: b[0], south: b[1], east: b[2], north: b[3] }, 0, { snap: true });
		host.setZoom((host.getZoom() ?? 1) + 1);
	}, []);

	// The only thing that moves the play camera.
	useEffect(() => {
		if (!ready || showResult) return;
		fitToLocations();
	}, [roundKey, showResult, ready, fitToLocations]);

	// Entering the result frames guess and truth together.
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !ready || !showResult || !truth) return;
		host.resize();
		if (!guess) {
			host.moveCamera({ center: truth, zoom: 10 });
			return;
		}
		host.fitBounds(
			{
				south: Math.min(guess.lat, truth.lat),
				west: Math.min(guess.lng, truth.lng),
				north: Math.max(guess.lat, truth.lat),
				east: Math.max(guess.lng, truth.lng),
			},
			60,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- frames once on entering the result
	}, [showResult, ready]);

	// Resize only; the camera is not ours to move here.
	useEffect(() => {
		if (ready) hostRef.current?.resize();
	}, [scale, showResult, expanded, ready]);

	const zoomBy = useCallback((delta: number) => {
		const host = hostRef.current;
		if (!host) return;
		host.setZoom(Math.max(1, Math.round(host.getZoom()) + delta));
	}, []);

	const cycleBasemap = useCallback(() => {
		setBasemap((cur) => BASEMAPS[(BASEMAPS.indexOf(cur) + 1) % BASEMAPS.length]);
	}, []);

	const bumpScale = (delta: number) =>
		setScale(Math.round(clamp(scale + delta, SCALE) * 100) / 100);

	return (
		<div
			ref={rootRef}
			className={`lg-guess-map${expanded && hovered && !showResult ? " is-expanded" : ""}${showResult ? " lg-guess-map--result" : ""}${instant ? " is-instant" : ""}`}
			style={
				{
					"--lg-map-w": panelSize(BASE_W, scale),
					"--lg-map-h": panelSize(BASE_H, scale),
				} as CSSProperties
			}
			{...(showResult
				? {}
				: {
						...hoverProps,
						onPointerEnter: (e: React.PointerEvent) => {
							setHoveredRound(roundKey);
							hoverProps.onPointerEnter(e);
						},
					})}
		>
			{!showResult && (
				<div className="lg-guess-map__controls">
					<button
						type="button"
						className="lg-guess-map__control"
						disabled={scale >= SCALE.max}
						onClick={() => bumpScale(SCALE_STEP)}
						aria-label={t("Larger map")}
					>
						<Icon path={mdiPlus} size={16} />
					</button>
					<button
						type="button"
						className="lg-guess-map__control"
						disabled={scale <= SCALE.min}
						onClick={() => bumpScale(-SCALE_STEP)}
						aria-label={t("Smaller map")}
					>
						<Icon path={mdiMinus} size={16} />
					</button>
					<button
						type="button"
						className="lg-guess-map__control"
						onClick={cycleBasemap}
						aria-label={t("Change basemap")}
					>
						<Icon path={mdiLayers} size={16} />
					</button>
				</div>
			)}

			<div className="lg-guess-map__canvas-wrap">
				<div ref={containerRef} className="lg-guess-map__canvas" data-qa="guess-map" />
				{!showResult && (
					<div className="lg-guess-map__zoom">
						<button type="button" onClick={() => zoomBy(1)} aria-label={t("Zoom in")}>
							<Icon path={mdiMagnifyPlusOutline} size={16} />
						</button>
						<button type="button" onClick={() => zoomBy(-1)} aria-label={t("Zoom out")}>
							<Icon path={mdiMagnifyMinusOutline} size={16} />
						</button>
					</div>
				)}
			</div>

			{!showResult && (
				<button
					type="button"
					className="lg-guess-map__submit"
					disabled={!guess || submitting}
					onClick={onSubmit}
					data-qa="perform-guess"
				>
					{guess ? t("Guess") : t("Place a pin on the map")}
				</button>
			)}
		</div>
	);
}
