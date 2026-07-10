import { useEffect, useRef, useCallback, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
	mdiGoogleStreetView,
	mdiMapMarker,
	mdiPlus,
	mdiMinus,
	mdiContentCopy,
	mdiDelete,
} from "@mdi/js";
import { startSceneEngine, loadScene, clearScene, recolorScene } from "@/lib/render/sceneStore";
import { useMapSurface } from "@/lib/render/useMapSurface";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { svThumbnailUrl, svSearchRadius } from "@/lib/sv/lookup";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { getSettings, useSetting } from "@/store/settings";
import { useMeasure } from "@/lib/sv/measure";
import { MeasurementBar } from "@/components/primitives/MeasurementBar";
import { MapContextMenuContent } from "@/components/editor/map/MapContextMenu";
import { useCurrentMap, selectPolygon, mapOpen } from "@/store/useMapStore";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { BLOBBY_ZOOM_THRESHOLD } from "@/lib/sv/constants";
import { setMapHost, tryInterceptDraw } from "@/lib/map/mapState";
import { createMapHost, hostKindForMapType, type MapHost } from "@/lib/map/host";
import { mountSearchRadiusCursor } from "@/lib/map/searchRadiusCursor";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { PolygonTools } from "@/components/editor/PolygonTools";

import { SearchControl } from "@/components/editor/map/SearchControl";
import type { ParsedLocation } from "@/lib/data/importExport";
import { MapTypeDropdown, MapSettingsDropdown } from "@/components/editor/map/MapSettingsPanel";
import { CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { type MapEmbedPrefs, DEFAULT_PREFS } from "@/store/mapEmbedPrefs";
import { FpsCounter } from "@/components/editor/map/FpsCounter";

/** Live zoom text with its own zoom subscription, so zooming doesn't re-render MapEmbed. */
function ZoomReadout({ host }: { host: MapHost | null }) {
	const [zoom, setZoom] = useState(() => host?.getZoom() ?? 2);
	useEffect(() => {
		if (!host) return;
		setZoom(host.getZoom());
		return host.on("zoom", () => setZoom(Math.round(host.getZoom() * 100) / 100));
	}, [host]);
	return <> · zoom {zoom}</>;
}

export function MapEmbed({
	onAddLocation,
}: {
	onAddLocation: (parsed: ParsedLocation) => void | Promise<void>;
}) {
	const map = useCurrentMap();
	const containerRef = useRef<HTMLDivElement>(null);
	const [host, setHost] = useState<MapHost | null>(null);
	const hostRef = useRef<MapHost | null>(null);

	const [prefs, setPrefs] = useLocalStorage<MapEmbedPrefs>("mapEmbedPrefs", DEFAULT_PREFS);
	const pref =
		<K extends keyof MapEmbedPrefs>(k: K) =>
		(v: MapEmbedPrefs[K]) =>
			setPrefs((p) => ({ ...p, [k]: v }));
	const {
		svOpacity,
		mapType,
		markerStyle,
		markerOpacity,
		showPerfectScoreCircle,
		showSearchRadiusCursor,
		showPreviews,
		selectOnly,
	} = prefs;
	const coordDisplayRef = useRef<HTMLSpanElement>(null);
	// Boolean, not the raw zoom: re-renders only when crossing the blobby threshold.
	// The live zoom readout subscribes itself (ZoomReadout).
	const [belowBlobbyZoom, setBelowBlobbyZoom] = useState(2 <= BLOBBY_ZOOM_THRESHOLD);

	const [customStyles, setCustomStyles] = useLocalStorage<CustomStyle[]>(CUSTOM_STYLES_KEY, []);
	const [showStylesDialog, setShowStylesDialog] = useState(false);
	const [svPreview, setSvPreview] = useState<{
		url: string;
		date?: string;
	} | null>(null);
	const previewAbortRef = useRef<AbortController | null>(null);
	const [opacityTarget, setOpacityTarget] = useState<"sv" | "markers">("sv");
	const freehandPathRef = useRef<number[][] | null>(null);
	const contextTriggerRef = useRef<HTMLSpanElement>(null);
	const { isMeasuring } = useMeasure();

	const dispatchContextMenu = useCallback((clientX: number, clientY: number) => {
		contextTriggerRef.current?.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX, clientY }),
		);
	}, []);

	// The editor map is a consumer of the shared surface, with the full capability set.
	const { requestUpdate } = useMapSurface(host, {
		prefs,
		measuring: isMeasuring,
		onContextMenu: dispatchContextMenu,
		freehandPathRef,
		onError: (e: unknown) => log.error("[deck.gl overlay error]", e),
		followActive: true,
		panToActiveHotkey: true,
		keyboardNav: true,
	});

	useEffect(() => {
		if (!host || !showSearchRadiusCursor) return;
		return mountSearchRadiusCursor();
	}, [host, showSearchRadiusCursor]);

	// Latest inputs for host creation; only a host-kind change should recreate the host.
	const buildRef = useRef({ prefs, customStyles });
	buildRef.current = { prefs, customStyles };
	// Camera carried across host swaps; also flags that this isn't the first host.
	const savedCameraRef = useRef<{ center: { lat: number; lng: number }; zoom: number } | null>(
		null,
	);

	const hostKind = hostKindForMapType(mapType);

	useEffect(() => {
		if (!containerRef.current || !map) return;
		if (!savedCameraRef.current) mapOpen.mark("mounted");
		let cancelled = false;
		const offs: (() => void)[] = [];
		let created: MapHost | null = null;
		let hostDiv: HTMLDivElement | null = null;

		// opensv always loads: the Google host renders with it, and every host needs
		// the SV services (click lookup, previews, pano).
		loadOpenSV().then(async () => {
			if (cancelled || !containerRef.current) return;
			if (hostKind === "google" && !google?.maps) return;

			const first = !savedCameraRef.current;
			hostDiv = document.createElement("div");
			hostDiv.style.cssText = "position:absolute;inset:0";
			containerRef.current.appendChild(hostDiv);

			const { prefs: p, customStyles: cs } = buildRef.current;
			created = await createMapHost(hostKind, hostDiv, p, {
				useBlobby: p.svBlobby,
				customStyles: cs,
				camera: savedCameraRef.current ?? undefined,
			});
			if (cancelled) {
				created.destroy();
				hostDiv.remove();
				return;
			}

			offs.push(
				created.on("mousemove", (ll) => {
					if (coordDisplayRef.current) {
						coordDisplayRef.current.textContent = `${ll.lat.toFixed(6)}° ${ll.lng.toFixed(6)}°`;
					}
				}),
				created.on("zoom", () => {
					setBelowBlobbyZoom((hostRef.current?.getZoom() ?? 0) <= BLOBBY_ZOOM_THRESHOLD);
				}),
			);

			hostRef.current = created;
			setMapHost(created);
			setHost(created);
			setBelowBlobbyZoom(created.getZoom() <= BLOBBY_ZOOM_THRESHOLD);
			if (first) {
				mapOpen.mark("map-ready");
				created.once("tilesloaded", () => mapOpen.mark("tiles"));
				if (map.meta.locationCount > 0) {
					cmd.storeBounds(false).then((bounds) => {
						if (cancelled || !hostRef.current || !bounds) return;
						const [west, south, east, north] = bounds;
						hostRef.current.fitBounds({ west, south, east, north }, undefined, { snap: true });
					});
				}
			}
		});

		return () => {
			cancelled = true;
			offs.forEach((off) => off());
			const h = hostRef.current ?? created;
			if (h) {
				const center = h.getCenter();
				if (center) savedCameraRef.current = { center, zoom: h.getZoom() };
				h.destroy();
			}
			hostDiv?.remove();
			hostRef.current = null;
			setMapHost(null);
			setHost(null);
		};
	}, [hostKind]);

	useEffect(() => {
		if (!host) return;
		const blobbySingleType =
			prefs.svBlobby && belowBlobbyZoom && prefs.svCoverageType !== "default";
		host.setSvOpacity(blobbySingleType ? svOpacity * 0.6 : svOpacity);
	}, [host, svOpacity, prefs.svBlobby, belowBlobbyZoom, prefs.svCoverageType]);

	// The editor map drives the single scene engine (delta/selection/active subscriptions)
	useEffect(() => startSceneEngine(), []);

	// Full (re)load on open and on marker-style change; clear when the map isn't ready.
	useEffect(() => {
		if (host) void loadScene(markerStyle, getSettings().markerColor);
		else clearScene();
	}, [host, markerStyle]);

	// Marker color repaints buffers in place — never a full scene reload.
	const markerColor = useSetting("markerColor");
	useEffect(() => {
		recolorScene(markerColor);
	}, [markerColor]);

	useEffect(() => {
		if (svPreview?.url) return () => URL.revokeObjectURL(svPreview.url);
	}, [svPreview?.url]);

	useEffect(() => {
		if (!host || !showPreviews) {
			setSvPreview(null);
			return;
		}
		if (!google?.maps) return;

		const offMove = host.on("mousemove", async (ll) => {
			setSvPreview(null);
			previewAbortRef.current?.abort();
			const ac = new AbortController();
			previewAbortRef.current = ac;

			const { lat, lng } = ll;
			const zoom = host.getZoom();

			await new Promise((r) => setTimeout(r, 300));
			if (ac.signal.aborted) return;

			const sv = new google.maps.StreetViewService();
			sv.getPanorama(
				{
					location: { lat, lng },
					radius: svSearchRadius(lat, zoom),
					sources: [google.maps.StreetViewSource.GOOGLE],
					preference: google.maps.StreetViewPreference.NEAREST,
				},
				async (data: google.maps.StreetViewPanoramaData | null, status: string) => {
					if (ac.signal.aborted || status !== "OK" || !data?.location?.pano) return;
					const heading = data.tiles.centerHeading ?? 0;
					const url = svThumbnailUrl(data.location.pano, heading);
					try {
						const res = await fetch(url, { signal: ac.signal });
						if (!res.ok || ac.signal.aborted) return;
						const blob = await res.blob();
						if (ac.signal.aborted) return;
						setSvPreview({ url: URL.createObjectURL(blob) });
					} catch {
						// ignored
					}
				},
			);
		});

		const offOut = host.on("mouseout", () => {
			previewAbortRef.current?.abort();
			previewAbortRef.current = null;
			setSvPreview(null);
		});

		return () => {
			offMove();
			offOut();
			previewAbortRef.current?.abort();
			setSvPreview(null);
		};
	}, [host, showPreviews]);

	const useBlobby = prefs.svBlobby && belowBlobbyZoom;

	useEffect(() => {
		hostRef.current?.applyPrefs(prefs, { useBlobby, customStyles });
	}, [host, prefs, useBlobby, customStyles]);

	const handleSearchResult = useCallback((lat: number, lng: number, _name: string) => {
		hostRef.current?.fitBounds({
			west: lng - 0.003,
			south: lat - 0.003,
			east: lng + 0.003,
			north: lat + 0.003,
		});
	}, []);

	const zoomIn = useCallback(() => {
		const h = hostRef.current;
		if (h) h.setZoom(h.getZoom() + 1);
	}, []);

	const zoomOut = useCallback(() => {
		const h = hostRef.current;
		if (h) h.setZoom(Math.max(1, h.getZoom() - 1));
	}, []);

	const showFps = useSetting("showFps");

	useHotkey(useBinding("mapZoomReset"), () => {
		hostRef.current?.moveCamera({ zoom: 1 });
	});

	useHotkey(useBinding("toggleSelectOnly"), () => {
		setPrefs((p) => ({ ...p, selectOnly: !p.selectOnly }));
	});
	useHotkey(useBinding("mapZoomBounds"), () => {
		cmd.storeBounds(false).then((bounds) => {
			if (!hostRef.current || !bounds) return;
			const [west, south, east, north] = bounds;
			hostRef.current.fitBounds({ west, south, east, north }, undefined, { snap: true });
		});
	});

	useHotkey(useBinding("mapZoomSelection"), () => {
		cmd.storeBounds(true).then((bounds) => {
			if (!hostRef.current || !bounds) return;
			const [west, south, east, north] = bounds;
			hostRef.current.fitBounds({ west, south, east, north }, undefined, { snap: true });
		});
	});

	return (
		<ContextMenu.Root modal={false}>
			<div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
			<div className="embed-controls">
				{/* TopLeft: Map dropdown, Search */}
				<div
					className="embed-controls__control"
					style={{ top: 0, left: 0, display: "flex", alignItems: "flex-start" }}
				>
					<MapTypeDropdown
						layerConfig={{
							prefs,
							setPref: pref,
							supportsLabels: mapType !== "osm" && mapType !== "vector",
							supportsTerrain: mapType === "map" || mapType === "satellite",
							supportsStyling: mapType !== "vector",
							customStyles,
							onManageStyles: () => setShowStylesDialog(true),
						}}
					/>
					<SearchControl onResult={handleSearchResult} onAddLocation={onAddLocation} />
				</div>
				{/* LeftTop: polygon/rectangle drawing tools */}
				{host && (
					<div className="embed-controls__control" style={{ left: 0, top: "52px" }}>
						<PolygonTools
							host={host}
							onDraw={(rings) => {
								if (rings.length === 0) return;
								if (tryInterceptDraw(rings)) return;
								selectPolygon({ coordinates: rings as [number, number][][] });
							}}
							freehandPathRef={freehandPathRef}
							requestOverlayUpdate={requestUpdate}
						/>
					</div>
				)}
				{/* TopRight: Map settings, SV opacity slider */}
				<div
					className="embed-controls__control"
					style={{
						top: 0,
						right: 0,
						display: "flex",
						alignItems: "flex-start",
					}}
				>
					<MapSettingsDropdown
						settings={{
							markerStyle,
							setMarkerStyle: pref("markerStyle"),
							markerSize: prefs.markerSize,
							setMarkerSize: pref("markerSize"),
							showPerfectScoreCircle,
							setShowPerfectScoreCircle: pref("showPerfectScoreCircle"),
							showSearchRadiusCursor,
							setShowSearchRadiusCursor: pref("showSearchRadiusCursor"),
							showPreviews,
							setShowPreviews: pref("showPreviews"),
							selectOnly,
							setSelectOnly: pref("selectOnly"),
						}}
					/>
					<div className="map-control sv-opacity-control">
						<Tooltip
							content={
								opacityTarget === "sv"
									? "Adjusting Street View opacity"
									: "Adjusting marker opacity"
							}
							side="left"
						>
							<button
								className="opacity-target-toggle"
								onClick={() => setOpacityTarget((t) => (t === "sv" ? "markers" : "sv"))}
							>
								<Icon
									path={opacityTarget === "sv" ? mdiGoogleStreetView : mdiMapMarker}
									size={20}
								/>
							</button>
						</Tooltip>
						<input
							className="sv-opacity-control__slider"
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={opacityTarget === "sv" ? svOpacity : markerOpacity}
							onChange={(e) =>
								pref(opacityTarget === "sv" ? "svOpacity" : "markerOpacity")(Number(e.target.value))
							}
							title={opacityTarget === "sv" ? "Street View layer opacity" : "Marker layer opacity"}
						/>
					</div>
				</div>
				<div className="embed-controls__control" style={{ right: 0, bottom: 10 }}>
					<div className="map-control map-control--button white">
						<Tooltip content="Zoom in" side="left">
							<button onClick={zoomIn} aria-label="Zoom in">
								<Icon path={mdiPlus} size={18} />
							</button>
						</Tooltip>
						<Tooltip content="Zoom out" side="left">
							<button onClick={zoomOut} aria-label="Zoom out">
								<Icon path={mdiMinus} size={18} />
							</button>
						</Tooltip>
					</div>
				</div>
				{svPreview && (
					<div className="embed-controls__control" style={{ bottom: "40px", left: 0 }}>
						<div className="map-control sv-preview-control">
							<figure className="sv-preview-control__window">
								<img src={svPreview.url} width={320} height={180} />
								{svPreview.date && (
									<figcaption className="sv-preview-control__caption">
										<span>{svPreview.date}</span>
									</figcaption>
								)}
							</figure>
						</div>
					</div>
				)}
				<MeasurementBar />
				<div className="embed-controls__control" style={{ bottom: 0, left: 0 }}>
					<div className="map-control coordinate-control">
						<span ref={coordDisplayRef} />
						<ZoomReadout host={host} />
						{showFps && (
							<>
								<span style={{ margin: "0 4px" }}>·</span>
								<FpsCounter />
							</>
						)}
					</div>
				</div>
			</div>
			{showStylesDialog && (
				<Dialog open onOpenChange={(open) => !open && setShowStylesDialog(false)}>
					<DialogContent title="Manage map styles" className="map-styles-modal">
						{customStyles.length > 0 && (
							<ul className="map-style-list">
								{customStyles.map((s) => (
									<li key={s.name} className="map-style-thumb">
										<span className="map-style-thumb__name">{s.name}</span>
										<div className="map-style-thumb__actions">
											<button
												className="icon-button"
												style={{ color: "var(--sand-11)" }}
												onClick={() => {
													navigator.clipboard.writeText(JSON.stringify(s.style, null, 2));
												}}
												aria-label="Copy JSON"
											>
												<Icon path={mdiContentCopy} size={20} />
											</button>
											<button
												className="icon-button"
												style={{ color: "var(--sand-11)" }}
												onClick={() => {
													const next = customStyles.filter((c) => c.name !== s.name);
													setCustomStyles(next);
													if (prefs.mapStyleName === s.name) pref("mapStyleName")("default");
												}}
												aria-label="Delete style"
											>
												<Icon path={mdiDelete} size={20} />
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
						<strong>New style</strong>
						<p style={{ margin: 0 }}>Paste a Google Maps style JSON array below.</p>
						<form
							onSubmit={(ev) => {
								ev.preventDefault();
								const fd = new FormData(ev.currentTarget);
								const name = (fd.get("name") as string)?.trim();
								const raw = (fd.get("style") as string)?.trim();
								if (!name || !raw) return;
								try {
									const style = JSON.parse(raw);
									if (!Array.isArray(style)) return;
									const next = [...customStyles.filter((s) => s.name !== name), { name, style }];
									setCustomStyles(next);
									ev.currentTarget.reset();
								} catch {
									// ignored
								}
							}}
						>
							<p>
								<input
									name="name"
									className="input"
									placeholder="Style name"
									required
									style={{ width: "100%" }}
								/>
							</p>
							<p>
								<textarea
									name="style"
									className="input"
									placeholder='[{"featureType":"water","stylers":[{"color":"#ff0000"}]}]'
									rows={5}
									style={{
										width: "100%",
										fontFamily: "monospace",
										fontSize: "0.8rem",
									}}
									required
								/>
							</p>
							<p>
								<button type="submit" className="button button--primary">
									Upload
								</button>
							</p>
						</form>
					</DialogContent>
				</Dialog>
			)}
			<ContextMenu.Trigger asChild>
				<span ref={contextTriggerRef} title="Context menu" />
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<MapContextMenuContent host={host} />
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
