import { fetchBounds, fetchColumns, sampleFrom } from "@/store/useMapStore";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type React from "react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { Icon } from "@/components/primitives/Icon";
import {
	mdiLayers,
	mdiPlus,
	mdiMinus,
	mdiMagnifyPlusOutline,
	mdiMagnifyMinusOutline,
	mdiScatterPlot,
} from "@mdi/js";
import { hostInstance } from "@/lib/map/host";
import { google } from "@/lib/sv/opensv";
import type * as maplibregl from "maplibre-gl";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useHoverExpand, panelSize } from "@/lib/hooks/useHoverExpand";
import { useSetting } from "@/store/settings";
import { usePluginState } from "@/plugins/pluginStorage";
import { clamp, range } from "@/types/util";
import { MAP_EMBED_PREFS, type MapEmbedPrefs } from "@/store/mapEmbedPrefs";

import { t } from "@/lib/i18n";
import type { Selector } from "@/bindings.gen";
import type { LatLng, MapTypeKey } from "@/types";
import { hexToRgb, resolveSvColorHex, type RGB } from "@/lib/util/color";
import { packedPositions } from "@/lib/render/packedPositions";
import {
	GUESS_COLOR,
	TRUTH_COLOR,
	pinLayers,
	resultLineLayer,
	useGameMap,
	useSettledZoom,
} from "./gameMap";

// Sizing mirrors the pano viewer minimap. Grows in layout, never by transform --
// a CSS-scaled map container misreports click coordinates.
const SCALE = range([0.5, 2]);
const SCALE_STEP = 0.25;
const BASE_W = 800;
const BASE_H = 600;
const BASEMAPS: MapTypeKey[] = ["map", "satellite", "osm", "vector"];
const POOL_POINTS = 10_000;
const POOL_RADIUS = 3;

export type ResultPin = "guess" | "truth";

const PIN_KIND: Record<string, ResultPin | undefined> = {
	"lg-guess": "guess",
	"lg-truth": "truth",
};

async function fetchPool(selector: Selector): Promise<Float32Array> {
	const ids = await sampleFrom(selector, POOL_POINTS);
	const [lng, lat] = await fetchColumns({ type: "Locations", locations: ids, name: null }, [
		"lng",
		"lat",
	]);
	const positions = new Float32Array(lat.length * 2);
	for (let i = 0; i < lat.length; i++) {
		positions[i * 2] = lng[i] as number;
		positions[i * 2 + 1] = lat[i] as number;
	}
	return positions;
}

function poolLayer(positions: Float32Array, color: RGB) {
	return new ScatterplotLayer({
		id: "lg-pool",
		data: packedPositions(positions),
		getFillColor: color,
		radiusUnits: "pixels",
		getRadius: POOL_RADIUS,
		stroked: false,
		filled: true,
		opacity: 0.55,
		pickable: false,
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
	onOpenPin,
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
	onOpenPin: (pin: ResultPin) => void;
	submitting: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = usePluginState<number>("localguessr", "mapScale", 1);
	const [showPool, setShowPool] = usePluginState<boolean>("localguessr", "showPool", false);
	const [pool, setPool] = useState<Float32Array | null>(null);
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
	const onOpenPinRef = useRef(onOpenPin);
	onOpenPinRef.current = onOpenPin;
	const lockedRef = useRef(showResult);
	lockedRef.current = showResult;
	/** Location bounds, resolved once with the host so per-round fits never await. */
	const boundsRef = useRef<[number, number, number, number] | null>(null);
	const selectorRef = useRef(selector);
	selectorRef.current = selector;

	const guessPrefs: MapEmbedPrefs = {
		...prefs,
		mapType: basemap,
		svPanoramas: false,
		svVisible: false,
	};

	const { hostRef, overlayRef, ready } = useGameMap(containerRef, guessPrefs, {
		// Bounds up front so per-round fits stay synchronous -- awaiting IPC inside
		// the fit paints a frame of the previous round's camera.
		prepare: async () => {
			boundsRef.current = await fetchBounds(selectorRef.current);
		},
		onReady: (host) => {
			host.setCursor("crosshair");
			fitToLocations();
		},
	});

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
	}, [hostRef, ready]);

	const [hoveredPin, setHoveredPin] = useState<ResultPin | null>(null);
	useEffect(() => {
		hostRef.current?.setCursor(showResult ? (hoveredPin ? "pointer" : null) : "crosshair");
	}, [hostRef, showResult, hoveredPin]);

	const settledZoom = useSettledZoom(hostRef, ready && showResult);

	useEffect(() => {
		if (!showPool || pool) return;
		let cancelled = false;
		void (async () => {
			try {
				const positions = await fetchPool(selectorRef.current);
				if (!cancelled) setPool(positions);
			} catch {
				if (!cancelled) setShowPool(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [showPool, pool, setShowPool]);

	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay || !ready) return;
		const layers = [];
		if (showPool && pool) layers.push(poolLayer(pool, hexToRgb(resolveSvColorHex(prefs.svColor))));
		if (showResult && truth && guess && settledZoom !== null) {
			layers.push(resultLineLayer("lg-line", [{ guess, truth }], settledZoom));
		}
		if (guess) layers.push(...pinLayers("lg-guess", [guess], GUESS_COLOR, showResult));
		if (showResult && truth) {
			layers.push(...pinLayers("lg-truth", [truth], TRUTH_COLOR, showResult));
		}
		overlay.setProps({
			layers,
			onClick: (info) => {
				const pin = PIN_KIND[info.layer?.id ?? ""];
				if (pin) onOpenPinRef.current(pin);
			},
			onHover: (info) => setHoveredPin(PIN_KIND[info.layer?.id ?? ""] ?? null),
		});
	}, [overlayRef, guess, truth, showResult, ready, settledZoom, showPool, pool, prefs.svColor]);

	const fitToLocations = useCallback(() => {
		const host = hostRef.current;
		if (!host) return;
		host.resize();
		const b = boundsRef.current;
		if (!b) return;
		host.fitBounds({ west: b[0], south: b[1], east: b[2], north: b[3] }, 0, { snap: true });
		host.setZoom((host.getZoom() ?? 1) + 1);
	}, [hostRef]);

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
	}, [hostRef, scale, showResult, expanded, ready]);

	const zoomBy = useCallback(
		(delta: number) => {
			const host = hostRef.current;
			if (!host) return;
			host.setZoom(Math.max(1, Math.round(host.getZoom()) + delta));
		},
		[hostRef],
	);

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
					<button
						type="button"
						className={`lg-guess-map__control${showPool ? " is-active" : ""}`}
						onClick={() => setShowPool((v) => !v)}
						aria-label={showPool ? t("Hide map locations") : t("Show map locations")}
					>
						<Icon path={mdiScatterPlot} size={16} />
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
