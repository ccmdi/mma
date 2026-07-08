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
import { setGoogleMap as setGoogleMapInstance, tryInterceptDraw } from "@/lib/map/mapState";
import { mountSearchRadiusCursor } from "@/lib/map/searchRadiusCursor";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { PolygonTools } from "@/components/editor/PolygonTools";

import { SearchControl } from "@/components/editor/map/SearchControl";
import type { ParsedLocation } from "@/lib/data/importExport";
import { MapTypeDropdown, MapSettingsDropdown } from "@/components/editor/map/MapSettingsPanel";
import { resolveStackForPrefs, CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { getStyleBackgroundColor } from "@/lib/geo/mapStyles";
import { type MapEmbedPrefs, DEFAULT_PREFS } from "@/store/mapEmbedPrefs";
import { FpsCounter } from "@/components/editor/map/FpsCounter";

export function MapEmbed({
	onAddLocation,
}: {
	onAddLocation: (parsed: ParsedLocation) => void | Promise<void>;
}) {
	const map = useCurrentMap();
	const containerRef = useRef<HTMLDivElement>(null);
	const gMapRef = useRef<google.maps.Map>(null);

	const [prefs, setPrefs] = useLocalStorage<MapEmbedPrefs>("mapEmbedPrefs", DEFAULT_PREFS);
	const pref =
		<K extends keyof MapEmbedPrefs>(k: K) =>
		(v: MapEmbedPrefs[K]) =>
			setPrefs((p) => ({ ...p, [k]: v }));
	const {
		svOpacity,
		svColor,
		showLabels,
		showTerrain,
		svPanoramas,
		svCoverageType,
		svThickness,
		svBlobby,
		boldCountryBorders,
		boldSubdivisionBorders,
		mapStyleName,
		mapType,
		markerStyle,
		markerOpacity,
		showPerfectScoreCircle,
		showSearchRadiusCursor,
		showPreviews,
		selectOnly,
	} = prefs;
	const coordDisplayRef = useRef<HTMLSpanElement>(null);
	const [mapZoom, setMapZoom] = useState(2);

	const [customStyles, setCustomStyles] = useLocalStorage<CustomStyle[]>(CUSTOM_STYLES_KEY, []);
	const [showStylesDialog, setShowStylesDialog] = useState(false);
	const [svPreview, setSvPreview] = useState<{
		url: string;
		date?: string;
	} | null>(null);
	const previewAbortRef = useRef<AbortController | null>(null);
	const [opacityTarget, setOpacityTarget] = useState<"sv" | "markers">("sv");
	const [mapReady, setMapReady] = useState(false);
	const freehandPathRef = useRef<number[][] | null>(null);
	const contextTriggerRef = useRef<HTMLSpanElement>(null);
	const { isMeasuring } = useMeasure();

	const dispatchContextMenu = useCallback((clientX: number, clientY: number) => {
		contextTriggerRef.current?.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, clientX, clientY }),
		);
	}, []);

	// The editor map is a consumer of the shared surface, with the full capability set.
	const { requestUpdate } = useMapSurface(mapReady ? gMapRef.current : null, {
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
		if (!mapReady || !showSearchRadiusCursor) return;
		return mountSearchRadiusCursor();
	}, [mapReady, showSearchRadiusCursor]);

	const svLayerRef = useRef<google.maps.ImageMapType>(null);

	useEffect(() => {
		if (!containerRef.current || !map) return;
		mapOpen.mark("mounted");
		let cancelled = false;

		loadOpenSV().then(() => {
			if (cancelled || !containerRef.current) return;
			if (!google?.maps) return;

			if (!gMapRef.current) {
				gMapRef.current = new google.maps.Map(containerRef.current, {
					center: { lat: 0, lng: 0 },
					zoom: 2,
					minZoom: 1,
					disableDefaultUI: true,
					scaleControl: true,
					cameraControl: false,
					zoomControl: false,
					streetViewControl: false,
					fullscreenControl: false,
					mapTypeControl: false,
					clickableIcons: false,
					gestureHandling: "greedy",
					draggableCursor: "crosshair",
					backgroundColor: getStyleBackgroundColor(prefs.mapStyleName),
					styles: [{ stylers: [{ visibility: "off" }] }],
				});

				const { mapType: stack, svLayer } = resolveStackForPrefs(prefs, {
					useBlobby: svBlobby,
					customStyles,
				});
				svLayerRef.current = svLayer;
				gMapRef.current.mapTypes.set("stack", stack);
				gMapRef.current.setMapTypeId("stack");
				setGoogleMapInstance(gMapRef.current);

				gMapRef.current.addListener("mousemove", (e: google.maps.MapMouseEvent) => {
					if (e.latLng) {
						if (coordDisplayRef.current) {
							coordDisplayRef.current.textContent = `${e.latLng.lat().toFixed(6)}° ${e.latLng.lng().toFixed(6)}°`;
						}
					}
				});
				gMapRef.current.addListener("zoom_changed", () => {
					setMapZoom(gMapRef.current?.getZoom() ?? 0);
				});
				setMapReady(true);
				mapOpen.mark("map-ready");
				google.maps.event.addListenerOnce(gMapRef.current, "tilesloaded", () =>
					mapOpen.mark("tiles"),
				);

				if (map.meta.locationCount > 0) {
					cmd.storeBounds(false).then((bounds) => {
						if (cancelled || !gMapRef.current || !bounds) return;
						const [west, south, east, north] = bounds;
						const gm = gMapRef.current!;
						gm.fitBounds({ west, south, east, north });
						google.maps.event.addListenerOnce(gm, "bounds_changed", () => {
							gm.moveCamera({ center: gm.getCenter()!, zoom: gm.getZoom()! });
						});
					});
				}
			}
		});

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!svLayerRef.current) return;
		const blobbySingleType =
			svBlobby && mapZoom <= BLOBBY_ZOOM_THRESHOLD && svCoverageType !== "default";
		svLayerRef.current.setOpacity(blobbySingleType ? svOpacity * 0.6 : svOpacity);
	}, [svOpacity, svBlobby, mapZoom, svCoverageType]);

	// The editor map drives the single scene engine (delta/selection/active subscriptions)
	useEffect(() => startSceneEngine(), []);

	// Full (re)load on open and on marker-style change; clear when the map isn't ready.
	useEffect(() => {
		if (mapReady) void loadScene(markerStyle, getSettings().markerColor);
		else clearScene();
	}, [mapReady, markerStyle]);

	// Marker color repaints buffers in place — never a full scene reload.
	const markerColor = useSetting("markerColor");
	useEffect(() => {
		recolorScene(markerColor);
	}, [markerColor]);

	useEffect(() => {
		if (svPreview?.url) return () => URL.revokeObjectURL(svPreview.url);
	}, [svPreview?.url]);

	useEffect(() => {
		if (!gMapRef.current || !showPreviews) {
			setSvPreview(null);
			return;
		}
		const map = gMapRef.current;
		if (!google?.maps) return;

		const moveListener = map.addListener("mousemove", async (e: google.maps.MapMouseEvent) => {
			if (!e.latLng) return;
			setSvPreview(null);
			previewAbortRef.current?.abort();
			const ac = new AbortController();
			previewAbortRef.current = ac;

			const lat = e.latLng.lat();
			const lng = e.latLng.lng();
			const zoom = map.getZoom() ?? 2;

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

		const outListener = map.addListener("mouseout", () => {
			previewAbortRef.current?.abort();
			previewAbortRef.current = null;
			setSvPreview(null);
		});

		return () => {
			google.maps.event.removeListener(moveListener);
			google.maps.event.removeListener(outListener);
			previewAbortRef.current?.abort();
			setSvPreview(null);
		};
	}, [showPreviews]);

	const useBlobby = svBlobby && mapZoom <= BLOBBY_ZOOM_THRESHOLD;

	useEffect(() => {
		if (!gMapRef.current) return;
		if (!google?.maps) return;
		const { mapType: stack, svLayer } = resolveStackForPrefs(prefs, { useBlobby, customStyles });
		svLayerRef.current = svLayer;
		gMapRef.current.mapTypes.set("stack", stack);
		gMapRef.current.setMapTypeId("stack");
		const bg = getStyleBackgroundColor(prefs.mapStyleName);
		gMapRef.current.setOptions({ backgroundColor: bg });
		const mapDiv = gMapRef.current.getDiv();
		mapDiv.style.backgroundColor = bg;
		const inner = mapDiv.querySelector<HTMLElement>("div[style*='background-color']");
		if (inner) inner.style.backgroundColor = bg;
	}, [prefs, useBlobby, customStyles]);

	const handleSearchResult = useCallback((lat: number, lng: number, _name: string) => {
		if (!gMapRef.current) return;
		if (!google?.maps) return;
		const bounds = new google.maps.LatLngBounds(
			{ lat: lat - 0.003, lng: lng - 0.003 },
			{ lat: lat + 0.003, lng: lng + 0.003 },
		);
		gMapRef.current.fitBounds(bounds);
	}, []);

	const zoomIn = useCallback(() => {
		if (gMapRef.current) gMapRef.current.setZoom((gMapRef.current.getZoom() ?? 0) + 1);
	}, []);

	const zoomOut = useCallback(() => {
		if (gMapRef.current) gMapRef.current.setZoom(Math.max(1, (gMapRef.current.getZoom() ?? 0) - 1));
	}, []);

	const showFps = useSetting("showFps");

	useHotkey(useBinding("mapZoomReset"), () => {
		const gm = gMapRef.current;
		if (gm) gm.moveCamera({ zoom: 1 });
	});

	useHotkey(useBinding("toggleSelectOnly"), () => {
		setPrefs((p) => ({ ...p, selectOnly: !p.selectOnly }));
	});
	useHotkey(useBinding("mapZoomBounds"), () => {
		cmd.storeBounds(false).then((bounds) => {
			const gm = gMapRef.current;
			if (!gm || !bounds || !google?.maps) return;
			const [west, south, east, north] = bounds;
			gm.fitBounds({ west, south, east, north });
			google.maps.event.addListenerOnce(gm, "bounds_changed", () => {
				gm.moveCamera({ center: gm.getCenter()!, zoom: gm.getZoom()! });
			});
		});
	});

	useHotkey(useBinding("mapZoomSelection"), () => {
		cmd.storeBounds(true).then((bounds) => {
			const gm = gMapRef.current;
			if (!gm || !bounds || !google?.maps) return;
			const [west, south, east, north] = bounds;
			gm.fitBounds({ west, south, east, north });
			google.maps.event.addListenerOnce(gm, "bounds_changed", () => {
				gm.moveCamera({ center: gm.getCenter()!, zoom: gm.getZoom()! });
			});
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
							basemap: mapType,
							setBasemap: pref("mapType"),
							labels: showLabels,
							setLabels: pref("showLabels"),
							supportsLabels: mapType !== "osm",
							terrain: showTerrain,
							setTerrain: pref("showTerrain"),
							supportsTerrain: mapType === "map" || mapType === "satellite",
							streetViewPanoramas: svPanoramas,
							setStreetViewPanoramas: pref("svPanoramas"),
							streetViewCoverageType: svCoverageType,
							setStreetViewCoverageType: pref("svCoverageType"),
							svColor,
							setSvColor: pref("svColor"),
							streetViewCoverageThickness: svThickness,
							setStreetViewCoverageThickness: pref("svThickness"),
							streetViewBlobby: svBlobby,
							setStreetViewBlobby: pref("svBlobby"),
							boldCountryBorders,
							setBoldCountryBorders: pref("boldCountryBorders"),
							boldSubdivisionBorders,
							setBoldSubdivisionBorders: pref("boldSubdivisionBorders"),
							mapStyleName,
							setMapStyleName: pref("mapStyleName"),
							customStyles,
							onManageStyles: () => setShowStylesDialog(true),
						}}
					/>
					<SearchControl onResult={handleSearchResult} onAddLocation={onAddLocation} />
				</div>
				{/* LeftTop: polygon/rectangle drawing tools */}
				{mapReady && (
					<div className="embed-controls__control" style={{ left: 0, top: "52px" }}>
						<PolygonTools
							map={gMapRef.current}
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
						<span ref={coordDisplayRef} /> · zoom {mapZoom}
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
													if (mapStyleName === s.name) pref("mapStyleName")("default");
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
				<MapContextMenuContent mapRef={gMapRef} />
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
