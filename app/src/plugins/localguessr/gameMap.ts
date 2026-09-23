import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { IconLayer, PathLayer, TextLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import { mdiFlagVariant } from "@mdi/js";
import {
	createMapHost,
	hostKindForMapType,
	type DeckOverlayHandle,
	type MapHost,
} from "@/lib/map/host";
import { CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { getLocal } from "@/lib/hooks/useLocalStorage";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";
import { rgbCss, type RGB } from "@/lib/util/color";
import type { LatLng } from "@/types";
import type { RoundResult } from "./game";

const GUESS_COLOR: RGB = [64, 133, 244];
const TRUTH_COLOR: RGB = [76, 175, 80];
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

const PIN_SIZE = 36;
const PIN_RADIUS = 13.5;
const PIN_RING = 3;

interface PinIcon {
	id: string;
	url: string;
	width: number;
	height: number;
}

type PinFace = (ctx: CanvasRenderingContext2D, center: number, radius: number) => void;

/** A white-ringed badge with a soft drop shadow, so it lifts off any basemap. */
function drawPin(id: string, color: RGB, face?: PinFace): PinIcon {
	const scale = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = PIN_SIZE * scale;
	const ctx = canvas.getContext("2d")!;
	ctx.scale(scale, scale);
	const center = PIN_SIZE / 2;
	const inner = PIN_RADIUS - PIN_RING;

	ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
	ctx.shadowBlur = 4;
	ctx.shadowOffsetY = 1.5;
	ctx.beginPath();
	ctx.arc(center, center, PIN_RADIUS, 0, 2 * Math.PI);
	ctx.fillStyle = "#fff";
	ctx.fill();
	ctx.shadowColor = "transparent";

	const fill = ctx.createLinearGradient(0, center - inner, 0, center + inner);
	fill.addColorStop(0, rgbCss(color.map((v) => v + (255 - v) * 0.3) as RGB));
	fill.addColorStop(1, rgbCss(color));
	ctx.beginPath();
	ctx.arc(center, center, inner, 0, 2 * Math.PI);
	ctx.fillStyle = fill;
	ctx.fill();

	ctx.fillStyle = "#fff";
	face?.(ctx, center, inner);
	return { id, url: canvas.toDataURL(), width: canvas.width, height: canvas.height };
}

const dotFace: PinFace = (ctx, center) => {
	ctx.beginPath();
	ctx.arc(center, center, 3, 0, 2 * Math.PI);
	ctx.fill();
};

const flagFace: PinFace = (ctx, center) => {
	const size = 14;
	ctx.translate(center - size / 2, center - size / 2);
	ctx.scale(size / 24, size / 24);
	ctx.fill(new Path2D(mdiFlagVariant));
};

function lazy<T>(make: () => T): () => T {
	let value: T | undefined;
	return () => (value ??= make());
}

export const GUESS_PIN = lazy(() => drawPin("guess", GUESS_COLOR, dotFace));
export const TRUTH_PIN = lazy(() => drawPin("truth", TRUTH_COLOR, flagFace));
const NUMBERED_TRUTH_PIN = lazy(() => drawPin("truth-numbered", TRUTH_COLOR));

export function pinLayers<T extends LatLng>(
	id: string,
	pins: T[],
	icon: () => PinIcon,
	pickable: boolean,
	opacity = 1,
) {
	return new IconLayer<T>({
		id,
		data: pins,
		getPosition: (d) => [d.lng, d.lat],
		getIcon: icon,
		getSize: PIN_SIZE,
		sizeUnits: "pixels",
		opacity,
		pickable,
	});
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
			pinLayers(`${id}-guess`, guesses, GUESS_PIN, true, opacity),
			pinLayers(`${id}-truth`, truths, NUMBERED_TRUTH_PIN, true, opacity),
			new TextLayer<ReplayPin>({
				id: `${id}-n`,
				data: truths,
				getPosition: (d) => [d.lng, d.lat],
				getText: (d) => String(d.round + 1),
				getSize: 12,
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
