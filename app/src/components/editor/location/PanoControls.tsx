/* eslint-disable react-refresh/only-export-components */
import { memo, useEffect, useRef, useState, useCallback } from "react";
import { hasLoadAsPanoId } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import {
	PANO_ZOOM,
	SV_JUMP_RADIUS,
	displayZoom,
	zoomInStep,
	zoomOutStep,
} from "@/lib/sv/constants";
import { google } from "@/lib/sv/opensv";
import { wrapDeg } from "@/lib/geo/geo";
import { lookupStreetView } from "@/lib/sv/lookup";
import { copyMapsLink, mapsPanoUrl, appendLinkTags } from "@/lib/sv/mapsLink";
import { fileTimestamp, formatDistance } from "@/lib/util/format";
import { useSettings } from "@/store/settings";
import { getMapState, useMapState } from "@/store/useMapStore";
import { usePanoViewer } from "./PanoViewerContext";
import { metadataPatch } from "@/lib/sv/getMetadata";
import { getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { fieldLabel, fieldValueLabel, getFieldDef } from "@/lib/data/fieldDefRegistry";
import { useBinding } from "@/lib/util/hotkeys";
import { useHotkeyRef } from "@/lib/hooks/useHotkey";
import { usePanoEvent } from "@/lib/hooks/usePanoEvent";
import { open } from "@tauri-apps/plugin-shell";
import { tweenPov } from "@/lib/sv/tweenPov";
import { snapshotPanoView, renderPanoView, canvasToBlob } from "@/lib/sv/panoCapture";
import { downloadBlob, copyImageToClipboard } from "@/lib/util/util";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import {
	mdiCameraOutline,
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
import { t } from "@/lib/i18n";

// --- Compass ---

export function Compass({ panorama }: { panorama: google.maps.StreetViewPanorama }) {
	const ref = useRef<HTMLDivElement>(null);
	usePanoEvent(panorama, "pov_changed", () => {
		ref.current?.style.setProperty("--heading", `${(-panorama.getPov().heading).toFixed(2)}deg`);
	});
	return (
		<div ref={ref} className="compass">
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

export function CompassTape({ panorama }: { panorama: google.maps.StreetViewPanorama }) {
	const innerRef = useRef<HTMLDivElement>(null);
	usePanoEvent(panorama, "pov_changed", () => {
		if (innerRef.current)
			innerRef.current.style.transform = `translateX(${(-panorama.getPov().heading * TAPE_PX_PER_DEG).toFixed(1)}px)`;
	});

	const ticks: { deg: number; label?: string }[] = [];
	for (let d = 0; d < 360; d += 5) {
		const dir = TAPE_DIRECTIONS.find(([a]) => a === d);
		ticks.push({ deg: d, label: dir?.[1] });
	}

	return (
		<div className="compass-tape">
			<div className="compass-tape__center-mark" />
			<div className="compass-tape__strip" style={{ width: TAPE_WIDTH_PX }}>
				<div className="compass-tape__inner" ref={innerRef}>
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

// --- Pano control subcomponents ---

function CompassControl({ panorama }: { panorama: google.maps.StreetViewPanorama }) {
	const [links, setLinks] = useState<google.maps.StreetViewLink[]>([]);
	const controlRef = useRef<HTMLDivElement>(null);
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

	usePanoEvent(panorama, "links_changed", () => {
		setLinks((panorama.getLinks() ?? []).filter((l): l is google.maps.StreetViewLink => l != null));
	});

	usePanoEvent(
		panorama,
		"pov_changed",
		() => {
			const h = panorama.getPov().heading;
			controlRef.current?.querySelectorAll<HTMLElement>(".compass-control__link").forEach((btn) => {
				btn.classList.toggle("is-active", Math.abs(h - Number(btn.dataset.heading ?? 0)) < 1);
			});
		},
		[links],
	);

	const pointNorth = useCallback(
		(e?: React.MouseEvent) => {
			if (e?.ctrlKey && links.length > 0) {
				if (animRef.current || links.length === 0) return;
				const h = panorama.getPov().heading;
				const next = links.reduce((best, cur) => {
					const bestDelta = wrapDeg(best.heading! - h, 0);
					const curDelta = wrapDeg(cur.heading! - h, 0);
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

	return (
		<div
			className="embed-controls__control"
			data-position="left-bottom"
			style={{ inset: "auto auto 248px 0px" }}
		>
			<div className="map-control map-control--transparent">
				<div className="compass-control" ref={controlRef}>
					<Tooltip
						content={t("Click to point north (N). Ctrl+click to cycle through linked panoramas.")}
						side="right"
					>
						<button
							className="compass-control__button"
							onClick={pointNorth}
							aria-label={t("Point north")}
						>
							<Compass panorama={panorama} />
						</button>
					</Tooltip>
					{links.map((link) => (
						<button
							key={link.pano}
							className="compass-control__link"
							data-heading={(link.heading ?? 0).toFixed(2)}
							style={{ "--heading": `${(link.heading ?? 0).toFixed(2)}deg` } as React.CSSProperties}
							onClick={() => navigateToLink(link.heading ?? 0)}
						>
							<Icon path={mdiChevronUp} />
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function ZoomControl({ panorama }: { panorama: google.maps.StreetViewPanorama }) {
	const [atMin, setAtMin] = useState(() => (panorama.getZoom() ?? 0) <= PANO_ZOOM.min);
	usePanoEvent(panorama, "zoom_changed", () => {
		setAtMin((panorama.getZoom() ?? 0) <= PANO_ZOOM.min);
	});

	const zoomIn = useCallback(() => {
		panorama.setZoom(zoomInStep(panorama.getZoom()));
	}, [panorama]);

	const zoomOut = useCallback(() => {
		panorama.setZoom(zoomOutStep(panorama.getZoom()));
	}, [panorama]);

	const resetZoom = useCallback(() => {
		panorama.setZoom(PANO_ZOOM.min);
	}, [panorama]);

	return (
		<div
			className="embed-controls__control"
			data-position="left-bottom"
			style={{ inset: "auto auto 112px 0px" }}
		>
			<div className="map-control map-control--button">
				<Tooltip content={t("Zoom in")} side="right">
					<button onClick={zoomIn} aria-label={t("Zoom in")}>
						<Icon path={mdiPlus} />
					</button>
				</Tooltip>
				<Tooltip content={t("Reset zoom")} side="right">
					<button disabled={atMin} onClick={resetZoom} aria-label={t("Reset zoom")}>
						<Icon path={mdiImageFilterCenterFocus} />
					</button>
				</Tooltip>
				<Tooltip content={t("Zoom out")} side="right">
					<button disabled={atMin} onClick={zoomOut} aria-label={t("Zoom out")}>
						<Icon path={mdiMinus} />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}

function ReturnToSpawnControl({
	panorama,
	onReturnToSpawn,
}: {
	panorama: google.maps.StreetViewPanorama;
	onReturnToSpawn: () => void | Promise<void>;
}) {
	const location = useMapState((s) => s.activeLocation);
	const [hasChanged, setHasChanged] = useState(false);
	const checkChanged = () => {
		if (!location) return;
		const pov = panorama.getPov();
		setHasChanged(
			pov.heading !== location.heading ||
				pov.pitch !== location.pitch ||
				panorama.getZoom() !== displayZoom(location.zoom),
		);
	};
	usePanoEvent(panorama, "pov_changed", checkChanged, [location]);
	usePanoEvent(panorama, "zoom_changed", checkChanged, [location]);

	return (
		<div
			className="embed-controls__control"
			data-position="left-bottom"
			style={{ inset: "auto auto 56px 0px" }}
		>
			<div className="map-control map-control--button">
				<Tooltip content={t("Return to spawn (R)")} side="right">
					<button
						disabled={!hasChanged}
						onClick={() => void Promise.resolve(onReturnToSpawn())}
						aria-label={t("Return to spawn (R)")}
					>
						<Icon path={mdiHome} />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}

function CoordinateControl({ panorama }: { panorama: google.maps.StreetViewPanorama }) {
	const textRef = useRef<HTMLSpanElement>(null);
	const altitude = usePanoViewer().pano?.altitude ?? 0;
	// Zoom ticks every frame of a pinch, so the text is written straight to the DOM.
	const updateDisplay = useCallback(() => {
		const zoom = (panorama.getZoom() ?? 0).toFixed(2);
		if (textRef.current)
			textRef.current.textContent =
				altitude === 0
					? " " + t("zoom {zoom}", { zoom })
					: ` ${formatDistance(altitude, 2)} · ` + t("zoom {zoom}", { zoom });
	}, [panorama, altitude]);
	usePanoEvent(panorama, "zoom_changed", updateDisplay);
	useEffect(updateDisplay, [updateDisplay]);

	return (
		<div
			className="embed-controls__control"
			data-position="bottom-left"
			style={{ inset: "auto auto 0px 96px" }}
		>
			<div className="map-control coordinate-control is-dark">
				<Icon path={mdiImageFilterHdrOutline} size={10} />
				<span ref={textRef} />
			</div>
		</div>
	);
}

// --- PanoControls ---

// The live extra: the stored row with what the viewed pano writes onto it, not yet persisted.
function PanoMetadataControl() {
	const location = useMapState((s) => s.activeLocation);
	const enrichFields = useMapState((s) => s.map?.settings.enrichFields ?? null);
	const { pano } = usePanoViewer();
	if (!location) return null;
	const fields = pano
		? {
				...location.extra,
				...metadataPatch(pano, location.extra, new Set(enrichFields ?? getDefaultEnrichKeys())),
			}
		: location.extra;
	return (
		<div
			className="embed-controls__control"
			data-position="top-left"
			style={{ inset: "0px auto auto 0px" }}
		>
			<div
				className="map-control coordinate-control is-dark"
				style={{ fontSize: "10px", display: "flex", flexDirection: "column", gap: "2px" }}
			>
				<span>
					{t("Pinned pano:")} {hasLoadAsPanoId(location) ? t("yes") : t("no")}
				</span>
				{fields &&
					Object.entries(fields).map(([key, val]) => (
						<span key={key}>
							{fieldLabel(key)}
							{t(":")} {val == null ? "null" : fieldValueLabel(getFieldDef(key), val)}
						</span>
					))}
			</div>
		</div>
	);
}

export const PanoControls = memo(function PanoControls({
	panorama,
	isFullscreen,
	onFullscreen,
	onReturnToSpawn,
}: {
	panorama: google.maps.StreetViewPanorama;
	isFullscreen: boolean;
	onFullscreen: () => void;
	onReturnToSpawn: () => void | Promise<void>;
}) {
	const vis = useSettings();
	const fullscreenKey = useBinding("toggleFullscreen");
	const jumpForwardKey = useBinding("jumpForward");
	const jumpBackwardKey = useBinding("jumpBackward");
	const [copyState, setCopyState] = useState<"idle" | "loading" | "done">("idle");
	const [screenshotState, setScreenshotState] = useState<"idle" | "loading" | "done">("idle");

	// Built from the LIVE pano, not the saved location: the link shares what you're looking at.
	const buildMapsUrl = useCallback(() => {
		const loc = panorama.getLocation();
		const pos = panorama.getPosition();
		const pov = panorama.getPov();
		if (!loc || !pos || !pov) return null;
		return mapsPanoUrl({
			lat: pos.lat(),
			lng: pos.lng(),
			heading: pov.heading,
			pitch: pov.pitch,
			zoom: panorama.getZoom(),
			panoId: loc.pano ?? "",
		});
	}, [panorama]);

	const openInMaps = useCallback(() => {
		const url = buildMapsUrl();
		if (url) void open(url.toString());
	}, [buildMapsUrl]);

	// `long` skips the shortenMapsUrl redirect lookup and copies the raw long URL;
	// `noTags` omits the tag/loadMode params.
	const doCopy = useCallback(
		async ({ long, noTags }: { long: boolean; noTags: boolean }) => {
			const url = buildMapsUrl();
			if (!url) return;
			const location = getMapState().activeLocation;
			if (!noTags && location) appendLinkTags(url, location, getMapState().tags);
			if (!long) setCopyState("loading");
			await copyMapsLink(url, { long });
			setCopyState("done");
			setTimeout(() => setCopyState("idle"), 500);
		},
		[buildMapsUrl],
	);

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

	const jumpDistance = formatDistance(SV_JUMP_RADIUS, 0);
	const jumpForward = useCallback(() => {
		jumpPending.current = jump(0);
	}, [jump]);

	const jumpBackward = useCallback(() => {
		jumpPending.current = jump(180);
	}, [jump]);

	const takeScreenshot = useCallback(
		async (download: boolean) => {
			setScreenshotState("loading");
			try {
				const view = snapshotPanoView(panorama);
				const blob = await canvasToBlob(await renderPanoView(view, 1920, 1080));
				const copied = download ? false : await copyImageToClipboard(blob);
				if (copied) {
					toast(t("Screenshot copied"));
				} else {
					const stamp = fileTimestamp();
					downloadBlob(blob, `${view.panoId}_${stamp}.png`);
					toast(
						download ? t("Screenshot downloaded") : t("Clipboard unavailable, downloaded instead"),
					);
				}
				setScreenshotState("done");
				setTimeout(() => setScreenshotState("idle"), 500);
			} catch (error) {
				log.warn("[pano-screenshot] capture failed", error);
				setScreenshotState("idle");
				toast(t("Screenshot failed"));
			}
		},
		[panorama],
	);

	return (
		<div className="embed-controls">
			{(vis.showScreenshotButton || vis.showFullscreenButton) && (
				<div
					className="embed-controls__control"
					data-position="top-right"
					style={{ inset: "0px 0px auto auto", display: "flex" }}
				>
					{vis.showScreenshotButton && (
						<div className="map-control map-control--button">
							<Tooltip content={t("Copy screenshot (Shift: download)")} side="bottom" align="end">
								<button
									onClick={(e) => void takeScreenshot(e.shiftKey)}
									disabled={screenshotState !== "idle"}
									aria-label={t("Copy screenshot to clipboard")}
									data-qa="pano-screenshot"
								>
									{screenshotState === "loading" ? (
										<Icon path={mdiLoading} className="spin" />
									) : screenshotState === "done" ? (
										<Icon path={mdiCheck} />
									) : (
										<Icon path={mdiCameraOutline} />
									)}
								</button>
							</Tooltip>
						</div>
					)}
					{vis.showFullscreenButton && (
						<div className="map-control map-control--button">
							<Tooltip
								content={t("Toggle fullscreen ({key})", { key: fullscreenKey.toUpperCase() })}
								side="bottom"
								align="end"
							>
								<button
									onClick={onFullscreen}
									aria-label={t("Toggle fullscreen ({key})", {
										key: fullscreenKey.toUpperCase(),
									})}
								>
									{isFullscreen ? <Icon path={mdiFullscreenExit} /> : <Icon path={mdiFullscreen} />}
								</button>
							</Tooltip>
						</div>
					)}
				</div>
			)}

			{vis.showJumpButtons && (
				<div
					className="embed-controls__control"
					data-position="right-top"
					style={{ inset: "56px 0px auto auto" }}
				>
					<div className="map-control map-control--button">
						<Tooltip
							content={t("Jump forward {distance} ({key})", {
								distance: jumpDistance,
								key: jumpForwardKey,
							})}
							side="left"
						>
							<button
								ref={jumpForwardRef}
								disabled={vis.defaultMovementMode !== "moving"}
								onClick={jumpForward}
								aria-label={t("Jump forward {distance} ({key})", {
									distance: jumpDistance,
									key: jumpForwardKey,
								})}
							>
								{jumpDistance}
							</button>
						</Tooltip>
						<Tooltip
							content={t("Jump backward {distance} ({key})", {
								distance: jumpDistance,
								key: jumpBackwardKey,
							})}
							side="left"
						>
							<button
								ref={jumpBackwardRef}
								disabled={vis.defaultMovementMode !== "moving"}
								onClick={jumpBackward}
								aria-label={t("Jump backward {distance} ({key})", {
									distance: jumpDistance,
									key: jumpBackwardKey,
								})}
							>
								-{jumpDistance}
							</button>
						</Tooltip>
					</div>
				</div>
			)}

			{vis.showCompass && <CompassControl panorama={panorama} />}

			{vis.showCompassTape && <CompassTape panorama={panorama} />}

			{vis.showZoom && <ZoomControl panorama={panorama} />}

			{vis.showReturnToSpawn && (
				<ReturnToSpawnControl panorama={panorama} onReturnToSpawn={onReturnToSpawn} />
			)}

			<div
				className="embed-controls__control"
				data-position="bottom-left"
				style={{ inset: "auto auto 0px 0px" }}
			>
				{vis.showMapLinks && (
					<div className="map-control map-control--button map-links-control">
						<Tooltip content={t("Open in maps")} side="top" align="start">
							<button onClick={openInMaps} aria-label={t("Open in maps")}>
								<Icon path={mdiOpenInNew} />
							</button>
						</Tooltip>
						<Tooltip content={t("Copy link - Shift: without tags, Alt: long URL")} side="right">
							<button
								onClick={(e) => void doCopy({ long: e.altKey, noTags: e.shiftKey })}
								aria-label={t("Copy link")}
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

			{vis.showCoordinateDisplay && <CoordinateControl panorama={panorama} />}

			{vis.showPanoMetadata && <PanoMetadataControl />}
		</div>
	);
});
