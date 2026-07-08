/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, useCallback } from "react";
import { hasLoadAsPanoId, LocationFlag } from "@/types";
import { PANO_ZOOM, SV_JUMP_RADIUS } from "@/lib/sv/constants";
import type { Location } from "@/bindings.gen";
import { google } from "@/lib/sv/opensv";
import { lookupStreetView } from "@/lib/sv/lookup";
import { shortenMapsUrl } from "@/lib/sv/shortUrl";
import { isOfficialPano } from "@/lib/sv/panoId";
import { useSettings } from "@/store/settings";
import { getCurrentMap } from "@/store/useMapStore";
import { useBinding } from "@/lib/util/hotkeys";
import { useHotkeyRef } from "@/lib/hooks/useHotkey";
import { open } from "@tauri-apps/plugin-shell";
import { tweenPov } from "@/lib/sv/tweenPov";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import {
	mdiFullscreenExit,
	mdiFullscreen,
	mdiChevronUp,
	mdiPlus,
	mdiImageFilterCenterFocus,
	mdiMinus,
	mdiHome,
	mdiOpenInNew,
	mdiLoading,
	mdiCheck,
	mdiContentCopy,
	mdiImageFilterHdrOutline,
} from "@mdi/js";

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
	[0, "N"],
	[45, "NE"],
	[90, "E"],
	[135, "SE"],
	[180, "S"],
	[225, "SW"],
	[270, "W"],
	[315, "NW"],
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
									<div
										className={`compass-tape__mark${isCardinal ? " compass-tape__mark--cardinal" : t.label ? " compass-tape__mark--inter" : ""}`}
									/>
									{t.label && (
										<span
											className={`compass-tape__label${isCardinal ? " compass-tape__label--cardinal" : ""}`}
										>
											{t.label}
										</span>
									)}
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
		panorama.setZoom(Math.min(PANO_ZOOM.max, Math.max(0, panorama.getZoom()) + 1));
	}, [panorama]);

	const zoomOut = useCallback(() => {
		panorama.setZoom(Math.max(0, panorama.getZoom() - 1));
	}, [panorama]);

	const resetZoom = useCallback(() => {
		panorama.setZoom(PANO_ZOOM.min);
	}, [panorama]);

	const buildMapsUrl = useCallback(() => {
		const loc = panorama.getLocation();
		const pos = panorama.getPosition();
		const pov = panorama.getPov();
		if (!loc || !pos || !pov) return null;
		const fov = (360 / Math.PI) * Math.atan(0.75 * Math.pow(2, 1 - panorama.getZoom()));
		const panoId = loc.pano ?? "";

		// Official panos embed a Street View thumbnail (!6s) so the link unfurls with a preview.
		let data: string;
		if (isOfficialPano(panoId)) {
			const thumb = new URL("https://streetviewpixels-pa.googleapis.com/v1/thumbnail");
			thumb.searchParams.set("panoid", panoId);
			thumb.searchParams.set("cb_client", "maps_sv.share");
			thumb.searchParams.set("w", "900");
			thumb.searchParams.set("h", "600");
			thumb.searchParams.set("yaw", String(pov.heading));
			thumb.searchParams.set("pitch", String(-pov.pitch));
			thumb.searchParams.set("thumbfov", fov.toFixed(0));
			data = `!3m5!1e1!3m3!1s${panoId}!2e0!6s${encodeURIComponent(thumb.toString())}`;
		} else {
			data = `!3m4!1e1!3m2!1s${panoId}!2e0`;
		}

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

	// `long` skips the shortenMapsUrl redirect lookup and copies the raw long URL;
	// `noTags` omits the tag/loadMode params.
	const doCopy = useCallback(
		async ({ long, noTags }: { long: boolean; noTags: boolean }) => {
			const url = buildMapsUrl();
			if (!url) return;
			if (!noTags) {
				const tagsById = getCurrentMap()?.meta.tags ?? {};
				for (const id of location.tags) {
					const name = tagsById[id]?.name;
					if (name) url.searchParams.append("extra[tags]", name);
				}
				if (!hasLoadAsPanoId(location)) url.searchParams.set("extra[loadMode]", "latLng");
			}
			const longStr = url.toString();
			if (long) {
				await navigator.clipboard.writeText(longStr).catch(() => {});
				setCopyState("done");
				setTimeout(() => setCopyState("idle"), 500);
				return;
			}
			setCopyState("loading");
			try {
				const short = await shortenMapsUrl(longStr);
				await navigator.clipboard.writeText(short);
			} catch {
				await navigator.clipboard.writeText(longStr).catch(() => {});
			}
			setCopyState("done");
			setTimeout(() => setCopyState("idle"), 500);
		},
		[buildMapsUrl, location],
	);

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
				SV_JUMP_RADIUS,
				panorama.getPov().heading + headingOffset,
			);
			try {
				const loc = await lookupStreetView(target.lat(), target.lng(), 0, {
					onlyOfficial: true,
					radius: SV_JUMP_RADIUS,
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
						<Tooltip
							content={`Toggle fullscreen (${fullscreenKey.toUpperCase()})`}
							side="bottom"
							align="end"
						>
							<button
								onClick={onFullscreen}
								aria-label={`Toggle fullscreen (${fullscreenKey.toUpperCase()})`}
							>
								{isFullscreen ? <Icon path={mdiFullscreenExit} /> : <Icon path={mdiFullscreen} />}
							</button>
						</Tooltip>
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
						<Tooltip content={`Jump forward 100 metres (${jumpForwardKey})`} side="left">
							<button
								ref={jumpForwardRef}
								disabled={vis.defaultMovementMode !== "moving"}
								onClick={jumpForward}
								aria-label={`Jump forward 100 metres (${jumpForwardKey})`}
							>
								100m
							</button>
						</Tooltip>
						<Tooltip content={`Jump backward 100 metres (${jumpBackwardKey})`} side="left">
							<button
								ref={jumpBackwardRef}
								disabled={vis.defaultMovementMode !== "moving"}
								onClick={jumpBackward}
								aria-label={`Jump backward 100 metres (${jumpBackwardKey})`}
							>
								-100m
							</button>
						</Tooltip>
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
							<Tooltip
								content="Click to point north (N). Ctrl+click to cycle through linked panoramas."
								side="right"
							>
								<button
									className="compass-control__button"
									onClick={pointNorth}
									aria-label="Point north"
								>
									<Compass heading={heading} />
								</button>
							</Tooltip>
							{links.map((link) => (
								<button
									key={link.pano}
									className={`compass-control__link${Math.abs(heading - (link.heading ?? 0)) < 1 ? " is-active" : ""}`}
									style={
										{ "--heading": `${(link.heading ?? 0).toFixed(2)}deg` } as React.CSSProperties
									}
									onClick={() => navigateToLink(link.heading ?? 0)}
								>
									<Icon path={mdiChevronUp} />
								</button>
							))}
						</div>
					</div>
				</div>
			)}

			{vis.showCompassTape && <CompassTape heading={heading} />}

			{vis.showZoom && (
				<div
					className="embed-controls__control"
					data-position="left-bottom"
					style={{ inset: "auto auto 112px 0px" }}
				>
					<div className="map-control map-control--button">
						<Tooltip content="Zoom in" side="right">
							<button onClick={zoomIn} aria-label="Zoom in">
								<Icon path={mdiPlus} />
							</button>
						</Tooltip>
						<Tooltip content="Reset zoom" side="right">
							<button disabled={zoom <= PANO_ZOOM.min} onClick={resetZoom} aria-label="Reset zoom">
								<Icon path={mdiImageFilterCenterFocus} />
							</button>
						</Tooltip>
						<Tooltip content="Zoom out" side="right">
							<button disabled={zoom <= 0} onClick={zoomOut} aria-label="Zoom out">
								<Icon path={mdiMinus} />
							</button>
						</Tooltip>
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
						<Tooltip content="Return to spawn (R)" side="right">
							<button
								disabled={!hasChanged}
								onClick={onReturnToSpawn}
								aria-label="Return to spawn (R)"
							>
								<Icon path={mdiHome} />
							</button>
						</Tooltip>
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
						<Tooltip content="Open in maps" side="top" align="start">
							<button onClick={openInMaps} aria-label="Open in maps">
								<Icon path={mdiOpenInNew} />
							</button>
						</Tooltip>
						<Tooltip content="Copy link - Shift: without tags, Alt: long URL" side="right">
							<button
								onClick={(e) => doCopy({ long: e.altKey, noTags: e.shiftKey })}
								aria-label="Copy link"
							>
								{copyState === "loading" ? (
									<Icon path={mdiLoading} className="spin" />
								) : copyState === "done" ? (
									<Icon path={mdiCheck} />
								) : (
									<Icon path={mdiContentCopy} />
								)}
							</button>
						</Tooltip>
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
						<Icon path={mdiImageFilterHdrOutline} size={10} />
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
