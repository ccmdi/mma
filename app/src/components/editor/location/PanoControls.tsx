/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, useCallback } from "react";
import { hasLoadAsPanoId, LocationFlag } from "@/types";
import type { Location } from "@/types";
import { google } from "@/lib/sv/opensv";
import { lookupStreetView } from "@/lib/sv/lookup.add";
import { shortenMapsUrl } from "@/lib/sv/shortUrl";
import { useSettings } from "@/store/settings.add";
import { useBinding } from "@/lib/util/hotkeys.add";
import { useHotkeyRef } from "@/lib/hooks/useHotkey";
import { open } from "@tauri-apps/plugin-shell";
import { tweenPov } from "@/lib/sv/tweenPov";

// --- Compass ---

function Compass({ heading }: { heading: number }) {
	return (
		<div
			className="compass"
			style={{ "--heading": `${(-heading).toFixed(2)}deg` } as React.CSSProperties}
		>
			<svg className="compass__arrow" viewBox="0 0 40 100">
				<path fill="#C1272D" d="M10 50l10-32 10 32z" />
				<path fill="#D1D1D1" d="M30 50L20 82 10 50z" />
			</svg>
		</div>
	);
}

const TAPE_DIRECTIONS: [number, string][] = [
	[0, "N"], [45, "NE"], [90, "E"], [135, "SE"],
	[180, "S"], [225, "SW"], [270, "W"], [315, "NW"],
];

const TAPE_DEG_WIDTH = 180;
const TAPE_PX_PER_DEG = 1.5;
const TAPE_WIDTH_PX = TAPE_DEG_WIDTH * TAPE_PX_PER_DEG;

function CompassTape({ heading }: { heading: number }) {
	const ticks: { deg: number; label?: string }[] = [];
	for (let d = 0; d < 360; d += 5) {
		const dir = TAPE_DIRECTIONS.find(([a]) => a === d);
		ticks.push({ deg: d, label: dir?.[1] });
	}

	return (
		<div className="compass-tape">
			<div className="compass-tape__center-mark" />
			<div className="compass-tape__strip" style={{ width: TAPE_WIDTH_PX }}>
				<div
					className="compass-tape__inner"
					style={{ transform: `translateX(${(-heading * TAPE_PX_PER_DEG).toFixed(1)}px)` }}
				>
					{[-360, 0, 360].map((offset) =>
						ticks.map((t) => {
							const deg = t.deg + offset;
							const isCardinal = t.label && t.label.length === 1;
							return (
								<div
									key={deg}
									className="compass-tape__tick"
									style={{ left: deg * TAPE_PX_PER_DEG }}
								>
									<div className={`compass-tape__mark${isCardinal ? " compass-tape__mark--cardinal" : t.label ? " compass-tape__mark--inter" : ""}`} />
									{t.label && <span className={`compass-tape__label${isCardinal ? " compass-tape__label--cardinal" : ""}`}>{t.label}</span>}
								</div>
							);
						}),
					)}
				</div>
			</div>
		</div>
	);
}

// --- Crosshair overlay ---

export class CrosshairOverlay {
	#pano: google.maps.StreetViewPanorama;
	#canvas: HTMLCanvasElement;
	#listener: google.maps.MapsEventListener;
	#resizeObserver: ResizeObserver;
	#regionSelector = '.gm-style > div[role="region"]';

	constructor(pano: google.maps.StreetViewPanorama) {
		this.#pano = pano;
		this.#canvas = document.createElement("canvas");
		Object.assign(this.#canvas.style, {
			position: "absolute",
			top: "0",
			left: "0",
			pointerEvents: "none",
		});
		this.#resizeObserver = new ResizeObserver(() => this.#draw());
		this.#listener = pano.addListener("status_changed", () => {
			const el = this.#root()?.querySelector(".gm-style");
			if (el) this.#resizeObserver.observe(el);
			this.#mount();
		});
		this.#mount();
	}

	#root(): HTMLElement | null {
		return Object.values(this.#pano).find((e) => e instanceof HTMLElement) as HTMLElement | null;
	}

	#mount() {
		const root = this.#root();
		if (!root) return;
		const region = root.querySelector(this.#regionSelector);
		if (region && !root.contains(this.#canvas)) {
			region.insertAdjacentElement("afterend", this.#canvas);
		}
		this.#draw();
	}

	#draw() {
		const root = this.#root();
		const region = root?.querySelector(this.#regionSelector);
		if (!region) return;
		const { width, height } = region.getBoundingClientRect();
		this.#canvas.width = width;
		this.#canvas.height = height;
		const cx = Math.floor(width / 2);
		const cy = Math.floor(height / 2);
		const aspect = width / height;
		const ctx = this.#canvas.getContext("2d")!;

		ctx.strokeStyle = "#000";
		ctx.lineWidth = 1;
		ctx.setLineDash([5, 5]);
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(width, height);
		ctx.moveTo(width, 0);
		ctx.lineTo(0, height);
		ctx.stroke();

		ctx.strokeStyle = "#f33";
		ctx.lineWidth = 3;
		ctx.setLineDash([]);
		ctx.beginPath();
		ctx.moveTo(cx - 5 * aspect, cy - 5);
		ctx.lineTo(cx + 5 * aspect, cy + 5);
		ctx.moveTo(cx + 5 * aspect, cy - 5);
		ctx.lineTo(cx - 5 * aspect, cy + 5);
		ctx.stroke();
	}

	dispose() {
		this.#resizeObserver.disconnect();
		this.#listener.remove();
		this.#canvas.remove();
	}
}

// --- Shader car toggle ---

export function sendHideCar(hide: boolean) {
	window.postMessage({
		type: "update-material",
		shaderMessage: { defines: hide ? ["NO_CAR"] : [], uniforms: [] },
	});
}

// --- PanoControls ---

export function PanoControls({
	panorama,
	location,
	altitude,
	isFullscreen,
	onFullscreen,
	onReturnToSpawn,
}: {
	panorama: google.maps.StreetViewPanorama;
	location: Location;
	altitude: number;
	isFullscreen: boolean;
	onFullscreen: () => void;
	onReturnToSpawn: () => void;
}) {
	const vis = useSettings();
	const fullscreenKey = useBinding("toggleFullscreen");
	const jumpForwardKey = useBinding("jumpForward");
	const jumpBackwardKey = useBinding("jumpBackward");
	const [heading, setHeading] = useState(0);
	const [zoom, setZoom] = useState(0);
	const [links, setLinks] = useState<google.maps.StreetViewLink[]>([]);
	const [copyState, setCopyState] = useState<"idle" | "loading" | "done">("idle");
	const animRef = useRef<{ stop: () => void; target: { heading: number; pitch: number } } | null>(
		null,
	);

	const animatePov = useCallback(
		(target: { heading: number; pitch: number }) => {
			animRef.current?.stop();
			const stop = tweenPov(panorama, target, () => {
				animRef.current = null;
			});
			animRef.current = { stop, target };
		},
		[panorama],
	);

	useEffect(() => {
		const povListener = panorama.addListener("pov_changed", () => {
			setHeading(panorama.getPov().heading);
		});
		const zoomListener = panorama.addListener("zoom_changed", () => {
			setZoom(panorama.getZoom());
		});
		const linksListener = panorama.addListener("links_changed", () => {
			setLinks(
				(panorama.getLinks() ?? []).filter((l): l is google.maps.StreetViewLink => l != null),
			);
		});
		setHeading(panorama.getPov().heading);
		setZoom(panorama.getZoom());
		setLinks((panorama.getLinks() ?? []).filter((l): l is google.maps.StreetViewLink => l != null));
		return () => {
			google?.maps?.event?.removeListener(povListener);
			google?.maps?.event?.removeListener(zoomListener);
			google?.maps?.event?.removeListener(linksListener);
		};
	}, [panorama]);

	const pointNorth = useCallback(
		(e?: React.MouseEvent) => {
			if (e?.ctrlKey && links.length > 0) {
				if (animRef.current || links.length === 0) return;
				const h = panorama.getPov().heading;
				const next = links.reduce((best, cur) => {
					const bestDelta = (best.heading! + 360 - h) % 360;
					const curDelta = (cur.heading! + 360 - h) % 360;
					if (bestDelta <= 0.01) return cur;
					if (curDelta <= 0.01) return best;
					return curDelta < bestDelta ? cur : best;
				});
				if (next) animatePov({ heading: next.heading!, pitch: 0 });
				return;
			}
			const targetHeading = animRef.current?.target.heading ?? panorama.getPov().heading;
			if (targetHeading === 0) {
				animatePov({ heading: 0, pitch: -90 });
			} else {
				animatePov({ heading: 0, pitch: 0 });
			}
		},
		[panorama, links, animatePov],
	);

	const navigateToLink = useCallback(
		(linkHeading: number) => {
			animatePov({ heading: linkHeading, pitch: 0 });
		},
		[animatePov],
	);

	const zoomIn = useCallback(() => {
		panorama.setZoom(Math.min(4, panorama.getZoom() + 1));
	}, [panorama]);

	const zoomOut = useCallback(() => {
		panorama.setZoom(Math.max(0, panorama.getZoom() - 1));
	}, [panorama]);

	const resetZoom = useCallback(() => {
		panorama.setZoom(0);
	}, [panorama]);

	const buildMapsUrl = useCallback(() => {
		const loc = panorama.getLocation();
		const pos = panorama.getPosition();
		const pov = panorama.getPov();
		if (!loc || !pos || !pov) return null;
		const fov = (360 / Math.PI) * Math.atan(0.75 * Math.pow(2, 1 - panorama.getZoom()));
		const panoId = loc.pano ?? "";
		const data = `!3m4!1e1!3m2!1s${panoId}!2e0`;
		const url = new URL(
			`https://www.google.com/maps/@${pos.lat()},${pos.lng()},3a,${fov.toFixed(1)}y,${pov.heading.toFixed(2)}h,${(pov.pitch + 90).toFixed(2)}t/data=${data}`,
		);
		url.searchParams.set("coh", "235716");
		url.searchParams.set("entry", "tts");
		return url;
	}, [panorama]);

	const openInMaps = useCallback(() => {
		const url = buildMapsUrl();
		if (url) open(url.toString());
	}, [buildMapsUrl]);

	const copyLink = useCallback(async () => {
		const url = buildMapsUrl();
		if (!url) return;
		setCopyState("loading");
		try {
			const short = await shortenMapsUrl(url.toString());
			await navigator.clipboard.writeText(short);
		} catch {
			await navigator.clipboard.writeText(url.toString()).catch(() => {});
		}
		setCopyState("done");
		setTimeout(() => setCopyState("idle"), 500);
	}, [buildMapsUrl]);

	const hasChanged =
		panorama.getPov().heading !== location.heading ||
		panorama.getPov().pitch !== location.pitch ||
		panorama.getZoom() !== location.zoom;

	const jumpForwardRef = useHotkeyRef(jumpForwardKey);
	const jumpBackwardRef = useHotkeyRef(jumpBackwardKey);
	const jumpPending = useRef<Promise<void> | null>(null);

	const jump = useCallback(
		async (headingOffset: number) => {
			await jumpPending.current;
			const pos = panorama.getPosition();
			if (!pos) return;
			if (!google?.maps?.geometry) return;
			const target = google.maps.geometry.spherical.computeOffset(
				pos,
				100,
				panorama.getPov().heading + headingOffset,
			);
			try {
				const loc = await lookupStreetView(target.lat(), target.lng(), 0, {
					onlyOfficial: true,
					radius: 100,
				});
				if (!loc?.panoId) return;
				if (loc.flags & LocationFlag.LoadAsPanoId) {
					panorama.setPano(loc.panoId);
				} else {
					panorama.setPosition({ lat: loc.lat, lng: loc.lng });
				}
			} catch {
				// no coverage found
			} finally {
				jumpPending.current = null;
			}
		},
		[panorama],
	);

	const jumpForward = useCallback(() => {
		jumpPending.current = jump(0);
	}, [jump]);

	const jumpBackward = useCallback(() => {
		jumpPending.current = jump(180);
	}, [jump]);

	return (
		<div className="embed-controls">
			{vis.showFullscreenButton && (
				<div
					className="embed-controls__control"
					data-position="top-right"
					style={{ inset: "0px 0px auto auto" }}
				>
					<div className="map-control map-control--button">
						<button
							onClick={onFullscreen}
							role="tooltip"
							aria-label={`Toggle fullscreen (${fullscreenKey.toUpperCase()})`}
							data-microtip-position="bottom-left"
						>
							{isFullscreen ? (
								<svg height="24" width="24" viewBox="0 0 24 24">
									<path d="M14,14H19V16H16V19H14V14M5,14H10V19H8V16H5V14M8,5H10V10H5V8H8V5M19,8V10H14V5H16V8H19Z" />
								</svg>
							) : (
								<svg height="24" width="24" viewBox="0 0 24 24">
									<path d="M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z" />
								</svg>
							)}
						</button>
					</div>
				</div>
			)}

			{vis.showJumpButtons && (
				<div
					className="embed-controls__control"
					data-position="right-top"
					style={{ inset: "56px 0px auto auto" }}
				>
					<div className="map-control map-control--button">
						<button
							ref={jumpForwardRef}
							disabled={vis.defaultMovementMode !== "moving"}
							onClick={jumpForward}
							role="tooltip"
							aria-label={`Jump forward 100 metres (${jumpForwardKey})`}
							data-microtip-position="left"
						>
							100m
						</button>
						<button
							ref={jumpBackwardRef}
							disabled={vis.defaultMovementMode !== "moving"}
							onClick={jumpBackward}
							role="tooltip"
							aria-label={`Jump backward 100 metres (${jumpBackwardKey})`}
							data-microtip-position="left"
						>
							-100m
						</button>
					</div>
				</div>
			)}

			{vis.showCompass && (
				<div
					className="embed-controls__control"
					data-position="left-bottom"
					style={{ inset: "auto auto 248px 0px" }}
				>
					<div className="map-control map-control--transparent">
						<div className="compass-control">
							<button
								className="compass-control__button"
								onClick={pointNorth}
								role="tooltip"
								aria-label="Click to point north (N). Ctrl+click to cycle through linked panoramas."
								data-microtip-position="right"
							>
								<Compass heading={heading} />
							</button>
							{links.map((link) => (
								<button
									key={link.pano}
									className={`compass-control__link${Math.abs(heading - (link.heading ?? 0)) < 1 ? " is-active" : ""}`}
									style={
										{ "--heading": `${(link.heading ?? 0).toFixed(2)}deg` } as React.CSSProperties
									}
									onClick={() => navigateToLink(link.heading ?? 0)}
								>
									<svg height="24" width="24" viewBox="0 0 24 24">
										<path d="M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z" />
									</svg>
								</button>
							))}
						</div>
					</div>
				</div>
			)}

			{vis.showCompassTape && (
				<CompassTape heading={heading} />
			)}

			{vis.showZoom && (
				<div
					className="embed-controls__control"
					data-position="left-bottom"
					style={{ inset: "auto auto 112px 0px" }}
				>
					<div className="map-control map-control--button">
						<button
							onClick={zoomIn}
							role="tooltip"
							aria-label="Zoom in"
							data-microtip-position="right"
						>
							<svg height="24" width="24" viewBox="0 0 24 24">
								<path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" />
							</svg>
						</button>
						<button
							disabled={zoom === 0}
							onClick={resetZoom}
							role="tooltip"
							aria-label="Reset zoom"
							data-microtip-position="right"
						>
							<svg height="24" width="24" viewBox="0 0 24 24">
								<path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M19,19H15V21H19A2,2 0 0,0 21,19V15H19M19,3H15V5H19V9H21V5A2,2 0 0,0 19,3M5,5H9V3H5A2,2 0 0,0 3,5V9H5M5,15H3V19A2,2 0 0,0 5,21H9V19H5V15Z" />
							</svg>
						</button>
						<button
							disabled={zoom === 0}
							onClick={zoomOut}
							role="tooltip"
							aria-label="Zoom out"
							data-microtip-position="right"
						>
							<svg height="24" width="24" viewBox="0 0 24 24">
								<path d="M19,13H5V11H19V13Z" />
							</svg>
						</button>
					</div>
				</div>
			)}

			{vis.showReturnToSpawn && (
				<div
					className="embed-controls__control"
					data-position="left-bottom"
					style={{ inset: "auto auto 56px 0px" }}
				>
					<div className="map-control map-control--button">
						<button
							disabled={!hasChanged}
							onClick={onReturnToSpawn}
							role="tooltip"
							aria-label="Return to spawn (R)"
							data-microtip-position="right"
						>
							<svg height="24" width="24" viewBox="0 0 24 24">
								<path d="M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z" />
							</svg>
						</button>
					</div>
				</div>
			)}

			<div
				className="embed-controls__control"
				data-position="bottom-left"
				style={{ inset: "auto auto 0px 0px" }}
			>
				{vis.showMapLinks && (
					<div className="map-control map-control--button map-links-control">
						<button
							onClick={openInMaps}
							role="tooltip"
							aria-label="Open in maps"
							data-microtip-position="top-right"
						>
							<svg height="24" width="24" viewBox="0 0 24 24">
								<path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" />
							</svg>
						</button>
						<button
							onClick={copyLink}
							role="tooltip"
							aria-label="Copy link"
							data-microtip-position="right"
						>
							{copyState === "loading" ? (
								<svg height="24" width="24" viewBox="0 0 24 24" className="spin">
									<path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" />
								</svg>
							) : copyState === "done" ? (
								<svg height="24" width="24" viewBox="0 0 24 24">
									<path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" />
								</svg>
							) : (
								<svg height="24" width="24" viewBox="0 0 24 24">
									<path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" />
								</svg>
							)}
						</button>
					</div>
				)}
			</div>

			{vis.showCoordinateDisplay && (
				<div
					className="embed-controls__control"
					data-position="bottom-left"
					style={{ inset: "auto auto 0px 96px" }}
				>
					<div className="map-control coordinate-control is-dark">
						<svg height="10" width="10" viewBox="0 0 24 24">
							<path d="M23 18H1L8.25 8.33L10.25 11L14 6L23 18M11.5 12.67L14 16L19 16L14 9.33L11.5 12.67M5 16L11.5 16L8.25 11.67L5 16Z" />
						</svg>
						<span>
							{altitude === 0
								? ` zoom ${(zoom ?? 0).toFixed(2)}`
								: ` ${altitude.toFixed(2)}m · zoom ${(zoom ?? 0).toFixed(2)}`}
						</span>
					</div>
				</div>
			)}

			{vis.showPanoMetadata && (
				<div
					className="embed-controls__control"
					data-position="top-left"
					style={{ inset: "0px auto auto 0px" }}
				>
					<div
						className="map-control coordinate-control is-dark"
						style={{ fontSize: "10px", display: "flex", flexDirection: "column", gap: "2px" }}
					>
						<span>Pinned pano: {hasLoadAsPanoId(location) ? "yes" : "no"}</span>
						{location.extra &&
							Object.entries(location.extra).map(([key, val]) => (
								<span key={key}>
									{key}: {val == null ? "null" : String(val)}
								</span>
							))}
					</div>
				</div>
			)}
		</div>
	);
}
