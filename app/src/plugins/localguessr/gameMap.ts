import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ScatterplotLayer, PathLayer, TextLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import {
	createMapHost,
	hostKindForMapType,
	type DeckOverlayHandle,
	type MapHost,
} from "@/lib/map/host";
import { CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { getLocal } from "@/lib/hooks/useLocalStorage";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";
import type { RGB } from "@/lib/util/color";
import type { LatLng } from "@/types";
import type { RoundResult } from "./game";

export const GUESS_COLOR: RGB = [64, 133, 244];
export const TRUTH_COLOR: RGB = [76, 175, 80];
const DIMMED = 0.3;

/**
 * A map host and its deck overlay for one game surface. Recreated only when the basemap
 * engine changes, because each host burns a WebGL context; a basemap on the same engine
 * restyles in place. `prepare` runs alongside host creation and `onReady` runs before the
 * first ready render, so a surface can frame its camera without painting the default one.
 */
export function useGameMap(
	containerRef: RefObject<HTMLDivElement | null>,
	prefs: MapEmbedPrefs,
	{ prepare, onReady }: { prepare?: () => Promise<void>; onReady?: (host: MapHost) => void } = {},
) {
	const hostRef = useRef<MapHost | null>(null);
	const overlayRef = useRef<DeckOverlayHandle | null>(null);
	const [ready, setReady] = useState(false);
	const latest = useRef({ prefs, prepare, onReady });
	latest.current = { prefs, prepare, onReady };
	const kind = hostKindForMapType(prefs.mapType);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let cancelled = false;
		const div = document.createElement("div");
		div.style.cssText = "position:absolute;inset:0";
		container.appendChild(div);

		void (async () => {
			try {
				const [host] = await Promise.all([
					createMapHost(kind, div, latest.current.prefs, {
						customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
						camera: { center: { lat: 20, lng: 0 }, zoom: 1.5 },
						scaleControl: false,
					}),
					latest.current.prepare?.(),
				]);
				if (cancelled) {
					host.destroy();
					return;
				}
				hostRef.current = host;
				overlayRef.current = host.createDeckOverlay();
				latest.current.onReady?.(host);
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
	}, [containerRef, kind]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host || !ready || hostKindForMapType(prefs.mapType) !== host.kind) return;
		host.applyPrefs(latest.current.prefs, {
			customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
		});
	}, [prefs.mapType, ready]);

	return { hostRef, overlayRef, ready };
}

/** The host zoom while `active`, else null. The `zoom` event fires once per step already
 *  carrying the target value, so this changes once per zoom level, never mid-animation. */
export function useSettledZoom(hostRef: RefObject<MapHost | null>, active: boolean): number | null {
	const [zoom, setZoom] = useState<number | null>(null);
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !active) {
			setZoom(null);
			return;
		}
		setZoom(host.getZoom());
		return host.on("zoom", () => setZoom(hostRef.current?.getZoom() ?? null));
	}, [hostRef, active]);
	return zoom;
}

/** Pins and their shadow halos, so each circle separates from same-colored basemap. */
export function pinLayers<T extends LatLng>(
	id: string,
	pins: T[],
	color: RGB,
	pickable: boolean,
	opacity = 1,
) {
	return [
		new ScatterplotLayer<T>({
			id: `${id}-halo`,
			data: pins,
			getPosition: (d) => [d.lng, d.lat],
			getFillColor: [0, 0, 0, 90],
			radiusUnits: "pixels",
			getRadius: 11,
			opacity,
			pickable: false,
		}),
		new ScatterplotLayer<T>({
			id,
			data: pins,
			getPosition: (d) => [d.lng, d.lat],
			getFillColor: color,
			getLineColor: [255, 255, 255],
			getLineWidth: 2,
			lineWidthUnits: "pixels",
			stroked: true,
			radiusUnits: "pixels",
			getRadius: 8,
			opacity,
			pickable,
		}),
	];
}

export interface RoundPair {
	guess: LatLng;
	truth: LatLng;
}

/** Dashed guess-to-answer lines, GeoGuessr contract: everything is anchored to the
 *  map (common units + high-precision dash), so mid-animation the pattern scales
 *  with the world like a texture; it re-normalizes to standard pixel size exactly
 *  once per settled zoom, via `useSettledZoom`. */
export function resultLineLayer(id: string, pairs: RoundPair[], settledZoom: number, opacity = 1) {
	// Under the maps overlay, deck's zoom sits one below the host's; one common
	// unit is 2^(zoom-1) screen px, so this width reads as 2.5px at the settled zoom.
	const width = 2.5 / 2 ** (settledZoom - 1);
	return new PathLayer({
		id,
		data: pairs,
		getPath: ({ guess, truth }: RoundPair) => [
			[guess.lng, guess.lat],
			[truth.lng, truth.lat],
		],
		getColor: [25, 25, 25, 240],
		getWidth: width,
		widthUnits: "common",
		capRounded: true,
		getDashArray: [4, 3],
		opacity,
		extensions: [new PathStyleExtension({ dash: true, highPrecisionDash: true })],
	});
}

export interface ReplayPin extends LatLng {
	round: number;
}

/** Every round's guess, answer and line on one map, answers numbered by round. While a
 *  round is highlighted the others dim beneath it. */
export function replayLayers(
	results: Pick<RoundResult, "location" | "guess">[],
	highlighted: number | null,
	settledZoom: number | null,
) {
	const group = (rounds: number[], id: string, opacity: number) => {
		const truths: ReplayPin[] = rounds.map((round) => {
			const { lat, lng } = results[round].location;
			return { lat, lng, round };
		});
		const guesses: ReplayPin[] = rounds.flatMap((round) => {
			const guess = results[round].guess;
			return guess ? [{ ...guess, round }] : [];
		});
		const pairs = guesses.map(({ round, ...guess }) => ({
			guess,
			truth: results[round].location,
		}));
		return [
			...(settledZoom !== null && pairs.length > 0
				? [resultLineLayer(`${id}-line`, pairs, settledZoom, opacity)]
				: []),
			...pinLayers(`${id}-guess`, guesses, GUESS_COLOR, true, opacity),
			...pinLayers(`${id}-truth`, truths, TRUTH_COLOR, true, opacity),
			new TextLayer<ReplayPin>({
				id: `${id}-n`,
				data: truths,
				getPosition: (d) => [d.lng, d.lat],
				getText: (d) => String(d.round + 1),
				getSize: 10,
				getColor: [255, 255, 255],
				fontFamily: '"Open Sans", sans-serif',
				fontWeight: 700,
				characterSet: "auto",
				opacity,
				pickable: false,
			}),
		];
	};
	const all = results.map((_, round) => round);
	if (highlighted === null || !results[highlighted]) return group(all, "lg-replay", 1);
	return [
		...group(
			all.filter((round) => round !== highlighted),
			"lg-replay",
			DIMMED,
		),
		...group([highlighted], "lg-replay-active", 1),
	];
}
