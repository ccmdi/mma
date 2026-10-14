import { useEffect, useRef, useCallback, useState, type CSSProperties } from "react";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import {
	mdiGoogleStreetView,
	mdiMapMarker,
	mdiPlus,
	mdiMinus,
	mdiContentCopy,
	mdiDelete,
} from "@mdi/js";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { Query } from "@/store/query";
import { Scene } from "@/lib/render/scene";
import { useMapSurface } from "@/lib/render/useMapSurface";
import { Icon } from "@/components/primitives/Icon";
import { svThumbnailUrl, svSearchRadius } from "@/lib/sv/lookup";
import { PanoType } from "@/bindings.consts";
import { panosAt } from "@/lib/sv/query";
import { log } from "@/lib/util/log";
import { latest } from "@/lib/util/latest";
import { delay } from "@/lib/util/concurrent";
import { useAsync } from "@/lib/hooks/useAsync";
import { getSettings, useSetting } from "@/store/settings";
import { useMeasure, useMeasureInteraction } from "@/lib/sv/measure";
import { MeasurementBar } from "@/components/primitives/MeasurementBar";
import { MapContextMenuContent } from "@/components/editor/map/MapContextMenu";
import { addSelection } from "@/store/selections";
import { rgbCss } from "@/lib/util/color";
import { mapOpen } from "@/lib/util/debug";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { MapHost } from "@/lib/map/host";
import { mountSearchRadiusCursor } from "@/lib/map/searchRadiusCursor";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { Dialog, DialogActions, DialogContent, DialogForm } from "@/components/primitives/Dialog";
import { Hint } from "@/components/primitives/Hint";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";
import { TextInput } from "@/components/primitives/TextInput";
import { Slider } from "@/components/primitives/Slider";
import { PolygonTools } from "@/components/editor/PolygonTools";
import { SearchControl } from "@/components/editor/map/SearchControl";
import type { ParsedLocation } from "@/bindings.gen";
import { MapTypeDropdown, MapSettingsDropdown } from "@/components/editor/map/MapSettingsPanel";
import { CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import {
	MAP_EMBED_PREFS,
	toggledLayer,
	layerOpacity,
	type MapEmbedPrefs,
	type OpacityLayer,
} from "@/store/mapEmbedPrefs";
import { FpsCounter } from "@/components/editor/map/FpsCounter";
import { msg, t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";

const OPACITY_TARGET_ICONS: Record<OpacityLayer, string> = {
	sv: mdiGoogleStreetView,
	marker: mdiMapMarker,
	selected: mdiMapMarker,
};

const OPACITY_TARGET_LABELS: Record<OpacityLayer, string> = {
	sv: msg("Street View layer opacity"),
	marker: msg("Unselected marker opacity"),
	selected: msg("Selected marker opacity"),
};

/** Live zoom text with its own zoom subscription, so zooming doesn't re-render MapEmbed. */
function ZoomReadout({ host }: { host: MapHost | null }) {
	const [zoom, setZoom] = useState(() => host?.getZoom() ?? 2);
	useEffect(() => {
		if (!host) return;
		setZoom(host.getZoom());
		return host.on("zoom", () => setZoom(Math.round(host.getZoom() * 100) / 100));
	}, [host]);
	return <> · {t("zoom {zoom}", { zoom })}</>;
}

export function MapEmbed({
	onAddLocation,
}: {
	onAddLocation: (parsed: ParsedLocation) => void | Promise<void>;
}) {
	const map = Store.use((s) => s.map);
	const containerRef = useRef<HTMLDivElement>(null);
	const [host, setHost] = useState<MapHost | null>(null);
	const hostRef = useRef<MapHost | null>(null);

	const [prefs, setPrefs] = useLocalStorage(MAP_EMBED_PREFS);
	const pref =
		<K extends keyof MapEmbedPrefs>(k: K) =>
		(v: MapEmbedPrefs[K]) =>
			setPrefs((p) => ({ ...p, [k]: v }));
	const { mapType, markerStyle, showSearchRadiusCursor, showPreviews } = prefs;
	const toggleLayer = (layer: OpacityLayer) =>
		setPrefs((p) => {
			const next = toggledLayer(
				p[`${layer}Opacity`],
				p[`${layer}Visible`],
				getSettings().opacityToggleMode,
			);
			return { ...p, [`${layer}Opacity`]: next.opacity, [`${layer}Visible`]: next.visible };
		});
	// The slider drives the effective opacity: dragging to 0 hides the layer without losing its value.
	const setLayerOpacity = (layer: OpacityLayer, v: number) =>
		setPrefs((p) => ({
			...p,
			[`${layer}Visible`]: v > 0,
			...(v > 0 ? { [`${layer}Opacity`]: v } : {}),
		}));
	const coordDisplayRef = useRef<HTMLSpanElement>(null);

	const [customStyles, setCustomStyles] = useLocalStorage<CustomStyle[]>(CUSTOM_STYLES_KEY, []);
	const [showStylesDialog, setShowStylesDialog] = useState(false);
	const styleFormRef = useRef<HTMLFormElement>(null);
	const [svPreview, setSvPreview] = useState<{
		url: string;
		date?: string;
	} | null>(null);
	const [previews] = useState(() =>
		latest<string | null>({
			publish: (url) => setSvPreview(url ? { url } : null),
			discard: (url) => {
				if (url) URL.revokeObjectURL(url);
			},
			failed: (error) => log.debug("[map] pano preview failed:", error),
		}),
	);
	const [pickedOpacityTarget, setOpacityTarget] = useState<OpacityLayer>("sv");
	const selectionTint = Store.use(() => {
		const active = SelectionList.active();
		return active.length > 0 ? rgbCss(active[0].color) : null;
	});
	const opacityTargets: OpacityLayer[] = selectionTint
		? ["sv", "marker", "selected"]
		: ["sv", "marker"];
	const opacityTarget = opacityTargets.includes(pickedOpacityTarget)
		? pickedOpacityTarget
		: "marker";
	const freehandPathRef = useRef<number[][] | null>(null);
	const polygonVerticesRef = useRef<number[][] | null>(null);
	const contextTriggerRef = useRef<HTMLSpanElement>(null);
	const isMeasuring = useMeasure();

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
		polygonVerticesRef,
		onError: (e: unknown) => log.error("[deck.gl overlay error]", e),
		followOpen: true,
		panToActiveHotkey: true,
		keyboardNav: true,
	});

	useMeasureInteraction(host);

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

	const hostKind = MapHost.kindForMapType(mapType);

	// opensv always loads: the Google host renders with it, and every host needs
	// the SV services (click lookup, previews, pano).
	const built = useAsync(
		async (signal) => {
			if (!containerRef.current || !map) return null;
			const previous = hostRef.current;
			const center = previous?.getCenter();
			const camera =
				previous && center ? { center, zoom: previous.getZoom() } : savedCameraRef.current;
			if (!camera) mapOpen.mark("mounted");
			await loadOpenSV();
			const container = containerRef.current;
			if (signal.aborted || !container) return null;
			if (hostKind === "google" && !google?.maps) return null;
			const div = document.createElement("div");
			div.style.cssText = "position:absolute;inset:0";
			container.appendChild(div);
			const { prefs: p, customStyles: cs } = buildRef.current;
			try {
				const created = await MapHost.create(hostKind, div, p, {
					customStyles: cs,
					camera: camera ?? undefined,
				});
				return { host: created, div, first: !camera };
			} catch (error) {
				div.remove();
				log.error("[map] host creation failed:", error);
				return null;
			}
		},
		[hostKind],
		{
			discard: (superseded) => {
				superseded?.host.destroy();
				superseded?.div.remove();
			},
		},
	);
	const surface = built.data;

	useEffect(() => {
		if (!surface) return;
		const { host: created, div, first } = surface;
		const offMove = created.on("mousemove", (ll) => {
			if (coordDisplayRef.current) {
				coordDisplayRef.current.textContent = `${ll.lat.toFixed(6)}° ${ll.lng.toFixed(6)}°`;
			}
		});
		hostRef.current = created;
		MapHost.set(created);
		setHost(created);
		if (first) {
			mapOpen.mark("map-ready");
			created.once("tilesloaded", () => mapOpen.mark("tiles"));
			if (Store.get().locationCount > 0) {
				void Query.read({ type: "Everything" }, { kind: "bounds" }).then((bounds) => {
					if (hostRef.current !== created || !bounds) return;
					const [west, south, east, north] = bounds;
					created.fitBounds({ west, south, east, north }, undefined, { snap: true });
				});
			}
		}

		return () => {
			offMove();
			const center = created.getCenter();
			if (center) savedCameraRef.current = { center, zoom: created.getZoom() };
			created.destroy();
			div.remove();
			hostRef.current = null;
			MapHost.set(null);
			setHost(null);
		};
	}, [surface]);

	useEffect(() => Scene.clear, []);

	// Full (re)load on open and on marker-style change; clear when the map isn't ready.
	useEffect(() => {
		if (host) void Scene.load(markerStyle, getSettings().markerColor);
		else Scene.clear();
	}, [host, markerStyle]);

	// Marker color repaints buffers in place — never a full scene reload.
	const markerColor = useSetting("markerColor");
	useEffect(() => {
		Scene.recolor(markerColor);
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

		const offMove = host.on("mousemove", ({ lat, lng }) => {
			setSvPreview(null);
			const zoom = host.getZoom();
			void previews.replace(async (signal) => {
				await delay(300, signal);
				const [pano] = await panosAt(
					[{ lat, lng }],
					svSearchRadius(lat, zoom),
					{ sources: [PanoType.Official] },
					signal,
				);
				if (!pano) return null;
				const res = await fetch(svThumbnailUrl(pano.id, pano.centerHeading), { signal });
				return res.ok ? URL.createObjectURL(await res.blob()) : null;
			});
		});

		const offOut = host.on("mouseout", () => {
			previews.cancel();
			setSvPreview(null);
		});

		return () => {
			offMove();
			offOut();
			previews.cancel();
			setSvPreview(null);
		};
	}, [host, showPreviews, previews]);

	useEffect(() => {
		hostRef.current?.applyPrefs(prefs, { customStyles });
	}, [host, prefs, customStyles]);

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
	const fullscreenMap = useSetting("fullscreenMap");

	useHotkey(useBinding("mapZoomReset"), () => {
		hostRef.current?.moveCamera({ zoom: 1 });
	});

	useHotkey(useBinding("toggleSelectOnly"), () => {
		setPrefs((p) => ({ ...p, clickMode: p.clickMode === "selectOnly" ? "default" : "selectOnly" }));
	});
	useHotkey(useBinding("toggleSvOpacity"), () => toggleLayer("sv"));
	useHotkey(useBinding("toggleMarkerOpacity"), () => toggleLayer("marker"));
	useHotkey(useBinding("mapZoomBounds"), () => {
		void Query.read({ type: "Everything" }, { kind: "bounds" }).then((bounds) => {
			if (!hostRef.current || !bounds) return;
			const [west, south, east, north] = bounds;
			hostRef.current.fitBounds({ west, south, east, north }, undefined, { snap: true });
		});
	});

	useHotkey(useBinding("mapZoomSelection"), () => {
		void Query.read({ type: "Selected" }, { kind: "bounds" }).then((bounds) => {
			if (!hostRef.current || !bounds) return;
			const [west, south, east, north] = bounds;
			hostRef.current.fitBounds({ west, south, east, north }, undefined, { snap: true });
		});
	});

	return (
		<ContextMenu.Root>
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
								if (MapHost.tryInterceptDraw(rings)) return;
								void SelectionList.update(
									addSelection({
										type: "Polygon",
										polygon: { coordinates: rings as [number, number][][], extraPolygons: null },
									}),
								);
							}}
							freehandPathRef={freehandPathRef}
							polygonVerticesRef={polygonVerticesRef}
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
					<MapSettingsDropdown prefs={prefs} setPref={pref} />
					<div className="map-control sv-opacity-control">
						<div className="opacity-targets">
							{opacityTargets.map((layer) => {
								const opacity = layerOpacity(prefs, layer);
								return (
									<IconButton
										key={layer}
										icon={OPACITY_TARGET_ICONS[layer]}
										size={20}
										label={t(OPACITY_TARGET_LABELS[layer])}
										tooltipSide="bottom"
										className="opacity-target"
										active={layer === opacityTarget}
										data-hidden={opacity === 0 || undefined}
										style={
											{
												"--layer-opacity": opacity,
												...(layer === "selected" && selectionTint ? { color: selectionTint } : {}),
											} as CSSProperties
										}
										onClick={() => setOpacityTarget(layer)}
									/>
								);
							})}
						</div>
						<Slider
							className="sv-opacity-control__slider"
							min={0}
							max={1}
							step={0.05}
							value={layerOpacity(prefs, opacityTarget)}
							onChange={(e) => setLayerOpacity(opacityTarget, Number(e.target.value))}
							title={t(OPACITY_TARGET_LABELS[opacityTarget])}
						/>
					</div>
				</div>
				<div
					className="embed-controls__control"
					style={fullscreenMap ? { left: 0, bottom: 10 } : { right: 0, bottom: 10 }}
				>
					<div className="map-control map-control--button white">
						<IconButton
							icon={mdiPlus}
							size={18}
							label={t("Zoom in")}
							tooltipSide="left"
							onClick={zoomIn}
						/>
						<IconButton
							icon={mdiMinus}
							size={18}
							label={t("Zoom out")}
							tooltipSide="left"
							onClick={zoomOut}
						/>
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
					<DialogContent title={t("Manage map styles")} size="lg">
						{customStyles.length > 0 && (
							<ul className="map-style-list">
								{customStyles.map((s) => (
									<li key={s.name} className="map-style-thumb">
										<span className="map-style-thumb__name">{s.name}</span>
										<div className="map-style-thumb__actions">
											<IconButton
												icon={mdiContentCopy}
												size={20}
												label={t("Copy JSON")}
												onClick={() => {
													void navigator.clipboard.writeText(JSON.stringify(s.style, null, 2));
												}}
											/>
											<ConfirmButton
												small
												variant="ghost"
												onConfirm={() => {
													const next = customStyles.filter((c) => c.name !== s.name);
													setCustomStyles(next);
													if (prefs.mapStyleName === s.name) pref("mapStyleName")("default");
												}}
												aria-label={t("Delete style")}
											>
												<Icon path={mdiDelete} size={20} />
											</ConfirmButton>
										</div>
									</li>
								))}
							</ul>
						)}
						<DialogForm
							ref={styleFormRef}
							onSubmit={() => {
								const form = styleFormRef.current;
								if (!form) return;
								const fd = new FormData(form);
								const name = (fd.get("name") as string)?.trim();
								const raw = (fd.get("style") as string)?.trim();
								if (!name || !raw) return;
								try {
									const style = JSON.parse(raw);
									if (!Array.isArray(style)) return;
									const next = [...customStyles.filter((s) => s.name !== name), { name, style }];
									setCustomStyles(next);
									form.reset();
								} catch {
									// ignored
								}
							}}
						>
							<strong>{t("New style")}</strong>
							<Hint>{t("Paste a Google Maps style JSON array below.")}</Hint>
							<TextInput name="name" placeholder={t("Style name")} required />
							<textarea
								name="style"
								className="text-input mono"
								placeholder='[{"featureType":"water","stylers":[{"color":"#ff0000"}]}]'
								rows={5}
								required
							/>
							<DialogActions cancel={{ label: t("Close") }} primary={{ label: t("Upload") }} />
						</DialogForm>
					</DialogContent>
				</Dialog>
			)}
			<ContextMenu.Trigger render={<span ref={contextTriggerRef} title={t("Context menu")} />} />
			<MapContextMenuContent />
		</ContextMenu.Root>
	);
}
