/* eslint-disable react-refresh/only-export-components */
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useCallback,
	useMemo,
	useSyncExternalStore,
} from "react";
import { LocationFlag, createLocation, isVirtualLocation } from "@/types";
import type { Location } from "@/types";
import type { Tag } from "@/bindings.gen";
import {
	useActiveLocation,
	useCurrentMap,
	updateLocation,
	patchLocationExtra,
	getActiveLocation,
	fetchLocation,
	getCurrentMap,
	removeLocations,
	duplicateLocation,
	addLocations,
	createTags,
	setActiveLocation,
	getVisibleTags,
	getTagCounts,
} from "@/store/useMapStore";
import { sortTagsByMode } from "@/lib/util/util";
import { ReviewBar } from "@/components/editor/location/ReviewBar";
import {
	useReviewSession,
	reviewNext,
	reviewPrev,
	reviewDelete,
	isAtStart,
} from "@/lib/review/review";
import { loadOpenSV, google } from "@/lib/sv/opensv";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { useHotkey, parseHotkey, matchesKey, isEditableElement } from "@/lib/hooks/useHotkey";
import { registerMapKeyActionHandler } from "@/lib/map/mapKeyBindings";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { useBinding, getBinding } from "@/lib/util/hotkeys";
import { useSettings, useSetting, setSetting, getSettings } from "@/store/settings";
import { useTimezone } from "@/lib/util/timezone";
import { isFieldEnabled } from "@/lib/data/fieldDefs";
import * as Select from "@radix-ui/react-select";
import { PluginLocationPanels } from "@/plugins/PluginPanels";
import { patchOpenSV, setPanoHovered } from "@/lib/sv/opensvPatch";
import { dateFmt } from "@/lib/util/format";
import { textColorFor } from "@/lib/util/color";
import {
	type PanoReference,
	type ResolvedPano,
	parsePanoDate,
	resolvePano,
	fetchPanoData,
	followLinkedPanos,
	downloadPano,
	showToast,
	nearestLinkHeading,
} from "@/lib/sv/lookup";
import { isOfficialPano } from "@/lib/sv/panoId";
import { enrich } from "@/lib/sv/enrich";
import {
	buildTileUrl,
	buildStyledTileUrl,
	createRoadmapTileConfig,
	createLegacyTileConfig,
	createSatelliteTileConfig,
	createTerrainBasemapTileConfig,
	LEGACY_STYLE_MAP_ID,
	type MapStyle,
} from "@/lib/geo/tiles";
import { PanoControls, CrosshairOverlay, sendHideCar } from "./PanoControls";
import { tweenPov } from "@/lib/sv/tweenPov";
import {
	seenPanoChanged,
	seenFlush,
	seenSetCanvas,
	seenSkipNext,
	seenUpdateGeo,
} from "@/lib/seen/seen";
import type { SeenEntry } from "@/bindings.gen";
import { useReverseGeocode } from "@/components/editor/location/useReverseGeocode";
import { useCameraType } from "@/components/editor/location/useCameraType";
import { useExactDate } from "@/components/editor/location/useExactDate";
import { PanoViewerProvider, usePanoViewer } from "./PanoViewerContext";
import {
	toggleViewportLock,
	applyViewportLock,
	getViewportLockInfo,
	subscribeViewportLock,
	getViewportLockSnapshot,
} from "@/lib/sv/viewportLock";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";

function PanoBadge({ cameraType }: { cameraType: FullCameraType | null }) {
	switch (cameraType) {
		case "unofficial":
			return <span className="pano-option__badge badge badge--unofficial">unofficial</span>;
		case "gen1":
			return <span className="pano-option__badge badge badge--gen1">Gen1</span>;
		case "gen2":
			return <span className="pano-option__badge badge badge--gen2">Gen2/3</span>;
		case "gen4":
			return <span className="pano-option__badge badge badge--gen4">Gen4</span>;
		case "badcam":
			return <span className="pano-option__badge badge badge--badcam">Badcam</span>;
		case "tripod":
			return <span className="pano-option__badge badge badge--tripod">Tripod</span>;
		case "trekker":
			return <span className="pano-option__badge badge badge--rb">Trekker</span>;
		default:
			return null;
	}
}

function PanoDatePicker({
	defaultPanoId,
	onChange,
	onExactDateResolved,
}: {
	defaultPanoId: string | null;
	onChange: (panoId: string | null) => void;
	onExactDateResolved?: (ts: number, timezone: string | null) => void;
}) {
	const { currentPano, panoDates, selectedPanoId } = usePanoViewer();
	const location = useActiveLocation();
	const lat = currentPano?.location?.latLng?.lat() ?? location?.lat ?? 0;
	const lng = currentPano?.location?.latLng?.lng() ?? location?.lng ?? 0;
	const defaultEntry = panoDates.find((d) => d.pano === defaultPanoId);
	const resolvedEntry = currentPano?.location
		? panoDates.find((d) => d.pano === currentPano.location!.pano)
		: undefined;
	const sorted = useMemo(
		() => [...panoDates].sort((a, b) => a.date.getTime() - b.date.getTime()),
		[panoDates],
	);
	const currentEntry =
		selectedPanoId == null
			? (defaultEntry ?? resolvedEntry)
			: sorted.find((d) => d.pano === selectedPanoId);
	const isDefault = selectedPanoId == null;
	const displayDate =
		currentEntry?.date ??
		(isDefault && currentPano?.imageDate ? parsePanoDate(currentPano.imageDate) : null);
	const prevLabelRef = useRef("");
	const displayLabel = displayDate
		? isDefault
			? `Default (${dateFmt.format(displayDate)})`
			: dateFmt.format(displayDate)
		: prevLabelRef.current;
	if (displayLabel) prevLabelRef.current = displayLabel;

	const handleValueChange = useCallback(
		(value: string) => {
			if (value === "default") onChange(null);
			else onChange(value);
		},
		[onChange],
	);

	const showBadges = useSetting("showCameraBadges");
	const currentMap = useCurrentMap();
	const datetimeEnabled = isFieldEnabled(
		currentMap?.meta.settings.enrichFields ?? null,
		"datetime",
	);
	const exactDateFormat = useSetting("exactDateFormat");
	const dateTimezone = useSetting("dateTimezone");
	const triggerPanoId =
		currentEntry?.pano ??
		currentPano?.location?.pano ??
		sorted[sorted.length - 1]?.pano ??
		defaultPanoId;
	const triggerCameraType = useCameraType(triggerPanoId);

	const newestPano = sorted.length > 0 ? sorted[sorted.length - 1] : null;
	const isNewest = triggerPanoId != null && triggerPanoId === newestPano?.pano;
	const yearMonth = displayDate
		? `${displayDate.getFullYear()}-${String(displayDate.getMonth() + 1).padStart(2, "0")}`
		: null;
	const exactDate = useExactDate(triggerPanoId, lat, lng, yearMonth, datetimeEnabled && isNewest);
	const resolvedTz = useTimezone(lat, lng, datetimeEnabled && dateTimezone === "location");
	const tzOption = dateTimezone === "utc" ? "UTC" : (resolvedTz ?? undefined);
	const exactLabel = exactDate.ts
		? exactDateFormat === "datetime"
			? new Date(exactDate.ts * 1000).toLocaleString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					timeZone: tzOption,
				})
			: new Date(exactDate.ts * 1000).toLocaleDateString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
					timeZone: tzOption,
				})
		: null;

	useEffect(() => {
		if (exactDate.ts != null && onExactDateResolved) {
			onExactDateResolved(exactDate.ts, resolvedTz);
		}
	}, [exactDate.ts, resolvedTz, onExactDateResolved]);

	if (sorted.length === 0) {
		return (
			<Select.Root disabled>
				<Select.Trigger className="select__input">
					<Select.Value placeholder="No dates" />
				</Select.Trigger>
			</Select.Root>
		);
	}

	return (
		<Select.Root value={selectedPanoId ?? "default"} onValueChange={handleValueChange}>
			<Select.Trigger className="select__input">
				<Select.Value>
					<span className="pano-value">
						{exactDate.loading ? displayLabel : (exactLabel ?? displayLabel)}
						<span style={{ display: "flex", gap: 4, alignItems: "center" }}>
							{exactDate.loading && <span className="badge badge--loading">...</span>}
							{(triggerCameraType === "unofficial" || showBadges) && (
								<PanoBadge cameraType={triggerCameraType} />
							)}
						</span>
						<span className="badge badge--number">{sorted.length}</span>
					</span>
				</Select.Value>
			</Select.Trigger>
			<Select.Portal>
				<Select.Content
					className="select__content"
					position="popper"
					side="top"
					style={{ color: "#000" }}
				>
					<Select.Viewport>
						<Select.Group>
							<Select.Label className="select__group-header">Specific Panorama</Select.Label>
							{sorted.map((d) => (
								<PanoOption key={d.pano} pano={d} />
							))}
						</Select.Group>
						<Select.Group>
							<Select.Label className="select__group-header">Default / auto-updating</Select.Label>
							<Select.Item value="default" className="select__option pano-option">
								<Select.ItemText>
									<span className="pano-option__name">
										Default
										{(defaultEntry?.date ?? sorted[sorted.length - 1]?.date)
											? ` (${dateFmt.format((defaultEntry?.date ?? sorted[sorted.length - 1]?.date)!)})`
											: ""}
									</span>
								</Select.ItemText>
							</Select.Item>
						</Select.Group>
					</Select.Viewport>
				</Select.Content>
			</Select.Portal>
		</Select.Root>
	);
}

function PanoOption({ pano }: { pano: PanoReference }) {
	const showBadges = useSetting("showCameraBadges");
	const cameraType = useCameraType(pano.pano);
	return (
		<Select.Item value={pano.pano} className="select__option pano-option">
			<Select.ItemText>
				<span className="pano-option__name">{dateFmt.format(pano.date)}</span>
				{(cameraType === "unofficial" || showBadges) && <PanoBadge cameraType={cameraType} />}
			</Select.ItemText>
		</Select.Item>
	);
}

const DARK_MODE_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#242f3e" }] },
	{ elementType: "geometry.stroke", stylers: [{ color: "#cccccc" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
	{ featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
	{ featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
	{ featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
];

function buildMiniMapType(): google.maps.ImageMapType {
	const tileSize = new google.maps.Size(256, 256);
	const prefs = (() => {
		try {
			return JSON.parse(localStorage.getItem("mapEmbedPrefs") ?? "{}");
		} catch {
			return {};
		}
	})() as Partial<{ mapType: string; showTerrain: boolean; mapStyleName: string }>;
	const basemap = prefs.mapType ?? "map";
	const terrain = prefs.showTerrain ?? false;
	const style = prefs.mapStyleName ?? "default";
	// Re-enable labels and borders that createRoadmapTileConfig strips (they're normally a separate layer)
	const showLabelsAndBorders: MapStyle[] = [
		{ elementType: "labels", stylers: [{ visibility: "on" }] },
		{
			elementType: "geometry.stroke",
			featureType: "administrative",
			stylers: [{ visibility: "on" }],
		},
	];
	const extraStyles: MapStyle[] = [
		...(style === "darkMode" ? DARK_MODE_STYLES : []),
		...showLabelsAndBorders,
	];

	if (basemap === "satellite") {
		const cfg = createSatelliteTileConfig();
		return new google.maps.ImageMapType({
			getTileUrl: (c: TileCoord, z: number) => buildTileUrl(cfg, c.x, c.y, z),
			tileSize,
			minZoom: 0,
			maxZoom: 20,
		});
	}
	if (basemap === "osm") {
		return new google.maps.ImageMapType({
			getTileUrl: (_c: TileCoord, z: number) =>
				`https://tile.openstreetmap.org/${z}/${_c.x}/${_c.y}.png`,
			tileSize,
			minZoom: 0,
			maxZoom: 19,
		});
	}
	if (terrain) {
		const cfg = createTerrainBasemapTileConfig(extraStyles);
		return new google.maps.ImageMapType({
			getTileUrl: (c: TileCoord, z: number) => buildTileUrl(cfg, c.x, c.y, z),
			tileSize,
			minZoom: 0,
			maxZoom: 20,
		});
	}
	if (style === "legacy") {
		const cfg = createLegacyTileConfig();
		return new google.maps.ImageMapType({
			getTileUrl: (c: TileCoord, z: number) =>
				buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, c.x, c.y, z),
			tileSize,
			minZoom: 0,
			maxZoom: 20,
		});
	}
	const cfg = createRoadmapTileConfig(extraStyles);
	return new google.maps.ImageMapType({
		getTileUrl: (c: TileCoord, z: number) => buildTileUrl(cfg, c.x, c.y, z),
		tileSize,
		minZoom: 0,
		maxZoom: 20,
	});
}

function createDotOverlay(map: google.maps.Map, pos: { lat: number; lng: number }) {
	const overlay = new google.maps.OverlayView();
	const div = document.createElement("div");
	div.className = "fullscreen-minimap__marker";
	let position = new google.maps.LatLng(pos.lat, pos.lng);

	overlay.onAdd = () => {
		overlay.getPanes()!.overlayMouseTarget.appendChild(div);
	};
	overlay.draw = () => {
		const proj = overlay.getProjection();
		if (!proj) return;
		const pt = proj.fromLatLngToDivPixel(position);
		if (pt) {
			div.style.left = `${pt.x}px`;
			div.style.top = `${pt.y}px`;
		}
	};
	overlay.onRemove = () => {
		div.remove();
	};
	overlay.setMap(map);

	return {
		setPosition(p: { lat: number; lng: number }) {
			position = new google.maps.LatLng(p.lat, p.lng);
			overlay.draw();
		},
		remove() {
			overlay.setMap(null);
		},
	};
}

const MINIMAP_SCALE_MIN = 0.5;
const MINIMAP_SCALE_MAX = 2;
const MINIMAP_SCALE_STEP = 0.5;
const MINIMAP_BASE_W = 800;
const MINIMAP_BASE_H = 600;
const MINIMAP_CLOSE_DELAY = 500;

function FullscreenMiniMap({
	lat,
	lng,
	panorama,
}: {
	lat: number;
	lng: number;
	panorama: google.maps.StreetViewPanorama | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const scale = useSetting("fullscreenMinimapScale");
	const [expanded, setExpanded] = useState(false);
	const closeTimer = useRef<number | null>(null);

	const setScale = (next: number) => {
		const clamped = Math.min(MINIMAP_SCALE_MAX, Math.max(MINIMAP_SCALE_MIN, next));
		setSetting("fullscreenMinimapScale", Math.round(clamped * 100) / 100);
	};

	const open = () => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		setExpanded(true);
	};
	const scheduleClose = () => {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = window.setTimeout(() => {
			setExpanded(false);
			closeTimer.current = null;
		}, MINIMAP_CLOSE_DELAY);
	};

	useEffect(() => {
		return () => {
			if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		};
	}, []);
	const mapRef = useRef<google.maps.Map | null>(null);
	const dotRef = useRef<{
		setPosition: (p: { lat: number; lng: number }) => void;
		remove: () => void;
	} | null>(null);

	useEffect(() => {
		if (!containerRef.current || !google?.maps) return;
		const customType = buildMiniMapType();
		const map = new google.maps.Map(containerRef.current, {
			center: { lat, lng },
			zoom: 14,
			disableDefaultUI: true,
			gestureHandling: "greedy",
			mapTypeId: "custom",
			mapTypeControlOptions: { mapTypeIds: ["custom"] },
		});
		map.mapTypes.set("custom", customType);
		map.setMapTypeId("custom");
		mapRef.current = map;
		dotRef.current = createDotOverlay(map, { lat, lng });
		return () => {
			dotRef.current?.remove();
			dotRef.current = null;
			mapRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!panorama) return;
		const listener = panorama.addListener("position_changed", () => {
			const pos = panorama.getPosition();
			if (!pos) return;
			const ll = { lat: pos.lat(), lng: pos.lng() };
			mapRef.current?.panTo(ll);
			dotRef.current?.setPosition(ll);
		});
		return () => {
			google?.maps?.event?.removeListener(listener);
		};
	}, [panorama]);

	useEffect(() => {
		mapRef.current?.panTo({ lat, lng });
		dotRef.current?.setPosition({ lat, lng });
	}, [lat, lng]);

	const sizeVars = {
		"--fs-minimap-w": `${Math.round(MINIMAP_BASE_W * scale)}px`,
		"--fs-minimap-h": `${Math.round(MINIMAP_BASE_H * scale)}px`,
	} as React.CSSProperties;

	return (
		<div
			className={`fullscreen-minimap${expanded ? " is-expanded" : ""}`}
			style={sizeVars}
			onMouseEnter={open}
			onMouseLeave={scheduleClose}
		>
			<div ref={containerRef} className="fullscreen-minimap__map" />
			<div className="fullscreen-minimap__size">
				<button
					type="button"
					className="fullscreen-minimap__size-btn"
					aria-label="Smaller minimap"
					disabled={scale <= MINIMAP_SCALE_MIN}
					onClick={() => setScale(scale - MINIMAP_SCALE_STEP)}
				>
					<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M19,13H5V11H19V13Z" />
					</svg>
				</button>
				<button
					type="button"
					className="fullscreen-minimap__size-btn"
					aria-label="Larger minimap"
					disabled={scale >= MINIMAP_SCALE_MAX}
					onClick={() => setScale(scale + MINIMAP_SCALE_STEP)}
				>
					<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" />
					</svg>
				</button>
			</div>
		</div>
	);
}

function FullscreenTagBar({
	pendingTags,
	onChangeTags,
	tags,
}: {
	pendingTags: number[];
	onChangeTags: (tags: number[]) => void;
	tags: Tag[];
}) {
	const [input, setInput] = useState("");
	const [focused, setFocused] = useState(false);
	const tagSortMode = useSetting("tagSortMode");

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();
		const name = input.trim();
		if (!name) return;
		const [resolved] = await createTags([name]);
		if (!pendingTags.includes(resolved.id)) {
			onChangeTags([...pendingTags, resolved.id]);
		}
		setInput("");
	};

	const toggleTag = (t: Tag) => {
		if (pendingTags.includes(t.id)) {
			onChangeTags(pendingTags.filter((id) => id !== t.id));
		} else {
			onChangeTags([...pendingTags, t.id]);
		}
		setInput("");
	};

	const locTags = pendingTags.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as Tag[];
	const sorted = sortTagsByMode(tags, tagSortMode, getTagCounts());
	const available = sorted.filter((t) => !pendingTags.includes(t.id));
	const filtered = input.trim()
		? available.filter((t) => t.name.toLowerCase().includes(input.toLowerCase()))
		: available;

	return (
		<div className="fullscreen-tagbar">
			<ul className="tag-list">
				{locTags.map((t) => (
					<li
						key={t.id}
						className="tag is-small has-button"
						style={{ backgroundColor: t.color, color: textColorFor(t.color) }}
					>
						<button
							className="button tag__button tag__button--delete"
							onClick={() => onChangeTags(pendingTags.filter((id) => id !== t.id))}
							type="button"
						>
							<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
								<path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" />
							</svg>
						</button>
						<span className="tag__text">{t.name}</span>
					</li>
				))}
			</ul>
			<form className="form-add-tag" onSubmit={handleAdd}>
				<button className="button form-add-tag__button" type="submit">
					+
				</button>
				<input
					className="form-add-tag__input fullscreen-tagbar__input"
					type="text"
					placeholder="Add a tag..."
					spellCheck={false}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setTimeout(() => setFocused(false), 150)}
				/>
			</form>
			{focused && filtered.length > 0 && (
				<div className="fullscreen-tagbar__palette">
					{filtered.map((t) => (
						<button
							key={t.id}
							className="tag is-small fullscreen-tagbar__palette-tag"
							style={{ backgroundColor: t.color, color: textColorFor(t.color) }}
							onMouseDown={() => toggleTag(t)}
							type="button"
						>
							<span className="tag__text">{t.name}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

let singletonPano: google.maps.StreetViewPanorama | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- debug helper
(window as any).__mma_pano = () => singletonPano;

export async function loadSeenPano(entry: SeenEntry) {
	seenSkipNext(entry.panoId);

	// Resolve to a live location; recreate from the entry if the id is stale/deleted.
	const existing = entry.locationId != null ? await fetchLocation(entry.locationId) : null;

	if (existing) {
		const active = getActiveLocation();
		if (active?.id !== existing.id) {
			setActiveLocation(existing.id);
			return;
		}
	} else {
		const loc = createLocation({
			lat: entry.lat,
			lng: entry.lng,
			heading: entry.heading,
			pitch: entry.pitch,
			zoom: entry.zoom,
			panoId: entry.panoId,
			extra: entry.countryCode ? { countryCode: entry.countryCode } : undefined,
		});
		await addLocations([loc]);
		await setActiveLocation(loc.id, false);
		return;
	}

	if (!singletonPano) return;
	const pano = singletonPano;
	pano.setPano(entry.panoId);
	pano.setPov({ heading: entry.heading, pitch: entry.pitch });
	pano.setZoom(entry.zoom);
}
const singletonDiv = (() => {
	const el = document.createElement("div");
	Object.assign(el.style, { width: "100%", height: "100%" });
	el.addEventListener("pointerenter", () => setPanoHovered(true));
	el.addEventListener("pointerleave", () => setPanoHovered(false));
	const BLOCKED = new Set([
		"arrowleft",
		"arrowright",
		"arrowup",
		"arrowdown",
		"w",
		"a",
		"s",
		"d",
		"+",
		"-",
		"=",
	]);
	el.addEventListener(
		"keydown",
		(e) => {
			if (BLOCKED.has(e.key.toLowerCase())) e.stopPropagation();
		},
		true,
	);
	el.addEventListener(
		"keyup",
		(e) => {
			if (BLOCKED.has(e.key.toLowerCase())) e.stopPropagation();
		},
		true,
	);
	return el;
})();

function getPanorama(): google.maps.StreetViewPanorama | null {
	if (singletonPano) return singletonPano;
	if (!google?.maps) return null;
	const s = getSettings();
	const noMove = s.defaultMovementMode !== "moving";
	singletonPano = new google.maps.StreetViewPanorama(singletonDiv, {
		disableDefaultUI: true,
		showRoadLabels: s.showRoadLabels,
		linksControl: noMove ? false : s.showLinksControl,
		clickToGo: noMove ? false : s.clickToGo,
		scrollwheel: s.defaultMovementMode !== "nmpz",
		motionTracking: false,
		visible: false,
	});
	patchOpenSV(singletonPano);
	const root = Object.values(singletonPano).find((v) => v instanceof HTMLElement) as
		| HTMLElement
		| undefined;
	if (root) root.style.backgroundColor = "#000";
	return singletonPano;
}

function applyResolved(sv: google.maps.StreetViewPanorama, result: ResolvedPano, loc: Location) {
	if (result.pano?.location?.pano) {
		sv.setPano(result.pano.location.pano);
	} else {
		sv.setPosition({ lat: loc.lat, lng: loc.lng });
	}
	sv.setZoom(loc.zoom);
	sv.setPov({ heading: loc.heading, pitch: loc.pitch });
	sv.setVisible(true);
	sv.focus();
}

export function LocationPreview() {
	return (
		<PanoViewerProvider>
			<LocationPreviewInner />
		</PanoViewerProvider>
	);
}

function LocationPreviewInner() {
	const location = useActiveLocation();
	const isStaged = location != null && isVirtualLocation(location);
	const map = useCurrentMap();
	const reviewSession = useReviewSession();
	const isReviewMode = reviewSession !== null;
	const panoContainerRef = useRef<HTMLDivElement>(null);
	const fullscreenContainerRef = useRef<HTMLDivElement>(null);
	const {
		currentPano,
		setCurrentPano,
		panoDates,
		setPanoDates,
		isFullscreen,
		setIsFullscreen,
		panoReady,
		setPanoReady,
		altitude,
		setAltitude,
		selectedPanoId,
	} = usePanoViewer();
	const [tagInput, setTagInput] = useState("");
	const [pendingTags, setPendingTags] = useState<number[]>(location?.tags ?? []);
	const tagSortMode = useSetting("tagSortMode");
	const geoResult = useReverseGeocode(location?.lat ?? 0, location?.lng ?? 0);
	const cancelTweenRef = useRef<(() => void) | null>(null);
	const geoRef = useRef(geoResult);
	geoRef.current = geoResult;
	useEffect(() => {
		setPendingTags(location?.tags ?? []);
	}, [location?.id]);
	useEffect(() => {
		if (geoResult) seenUpdateGeo(geoResult.countryCode, geoResult.text);
	}, [geoResult]);
	const appSettings = useSettings();
	useSyncExternalStore(subscribeViewportLock, getViewportLockSnapshot);
	const lockInfo = getViewportLockInfo();

	useEffect(() => {
		if (!singletonPano) return;
		const noMove = appSettings.defaultMovementMode !== "moving";
		singletonPano.setOptions({
			linksControl: noMove ? false : appSettings.showLinksControl,
			clickToGo: noMove ? false : appSettings.clickToGo,
			showRoadLabels: appSettings.showRoadLabels,
			scrollwheel: appSettings.defaultMovementMode !== "nmpz",
		});
	}, [
		appSettings.showLinksControl,
		appSettings.clickToGo,
		appSettings.showRoadLabels,
		appSettings.defaultMovementMode,
	]);

	useEffect(() => {
		if (!singletonPano) return;
		sendHideCar(!appSettings.showCar);
		const listener = singletonPano.addListener("status_changed", () => {
			if (singletonPano!.getStatus() === "OK") sendHideCar(!appSettings.showCar);
		});
		return () => {
			listener.remove();
		};
	}, [appSettings.showCar]);

	useEffect(() => {
		if (!singletonPano || !appSettings.showCrosshair) return;
		const overlay = new CrosshairOverlay(singletonPano);
		return () => overlay.dispose();
	}, [appSettings.showCrosshair]);

	// Mount/unmount: move the persistent div in/out of the container.
	// useLayoutEffect so setVisible(false) + appendChild run before paint,
	// matches the og mount() which calls setOptions({visible:false})
	// before appending the div.
	useLayoutEffect(() => {
		const container = panoContainerRef.current;
		if (!container) return;
		if (singletonPano) singletonPano.setVisible(false);
		container.appendChild(singletonDiv);
		return () => {
			if (container.contains(singletonDiv)) container.removeChild(singletonDiv);
		};
	}, []);

	useEffect(() => {
		if (!location || !panoContainerRef.current) return;
		let cancelled = false;
		let statusListener: google.maps.MapsEventListener | null = null;
		let lockListener: google.maps.MapsEventListener | null = null;

		loadOpenSV().then(async () => {
			if (cancelled) return;
			if (!google?.maps) return;
			const pano = getPanorama();
			if (!pano) return;

			// status_changed fires when the pano is fully loaded (getStatus() === "OK").
			// All data (panoId, position, POV) is consistent at this point.
			statusListener = pano.addListener("status_changed", () => {
				if (cancelled || pano.getStatus() !== "OK") return;
				const panoId = pano.getPano();
				if (!panoId) return; // ?
				const pos = pano.getPosition();
				setCurrentPano((prev) => {
					if (prev?.location?.pano === panoId) return prev;
					return {
						location: { pano: panoId, latLng: pos! },
						imageDate: prev?.imageDate,
					};
				});
				if (pos) {
					pushTrail(pos.lng(), pos.lat());
					const activeForSeen = getActiveLocation();
					seenPanoChanged(
						panoId,
						pos.lat(),
						pos.lng(),
						// virtual locations have no persistent id to record against
						activeForSeen && !isVirtualLocation(activeForSeen) ? activeForSeen.id : null,
						(getActiveLocation()?.extra?.countryCode as string) ??
							geoRef.current?.countryCode ??
							null,
						geoRef.current?.text ?? null,
						() => ({
							heading: pano.getPov().heading,
							pitch: pano.getPov().pitch,
							zoom: pano.getZoom(),
						}),
					);
				}
			});

			lockListener = pano.addListener("pano_changed", () => {
				applyViewportLock(pano);
			});

			sendHideCar(!getSettings().showCar);
			setCurrentPano(null);
			setPanoDates([]);
			resetTrail(location.lng, location.lat);

			const result = await resolvePano(location);
			if (cancelled) return;
			applyResolved(pano, result, location);
			google.maps.event.trigger(pano, "resize");
			if (result.isFallback) {
				const root = Object.values(pano).find((v) => v instanceof HTMLElement) as
					| HTMLElement
					| undefined;
				if (root)
					showToast(root, "Configured pano ID could not be found. Falling back to lat/lng.", 3000);
			}
			// Populate currentPano from the resolve result immediately.
			// Covers the case where setPano() with the same ID doesn't trigger status_changed.
			if (result.pano?.location) {
				setCurrentPano(result.pano);
			}
			setPanoReady(true);
			seenSetCanvas(() => singletonDiv.querySelector("canvas"));
		});

		return () => {
			cancelled = true;
			clearTrail();
			if (statusListener) google?.maps?.event?.removeListener(statusListener);
			if (lockListener) google?.maps?.event?.removeListener(lockListener);
			const pano = singletonPano;
			if (pano) {
				seenFlush(() => ({
					heading: pano.getPov().heading,
					pitch: pano.getPov().pitch,
					zoom: pano.getZoom(),
				}));
			}
		};
	}, [location?.id]);

	// Reactive: fetch dates + metadata whenever the current pano changes.
	useEffect(() => {
		if (!currentPano) {
			setPanoDates([]);
			return;
		}
		let cancelled = false;

		function extractTimes(data: google.maps.StreetViewPanoramaData | null): PanoReference[] {
			const raw = (data as unknown as { time?: { pano: string; AA?: Date }[] })?.time ?? [];
			return raw.flatMap((t) =>
				t.pano && t.AA instanceof Date ? [{ pano: t.pano, date: t.AA }] : [],
			);
		}

		const loc = currentPano.location;
		if (!loc?.latLng) return;
		const panoPos = { lat: loc.latLng.lat(), lng: loc.latLng.lng() };
		const byPano = fetchPanoData({ pano: loc.pano });
		const byLoc = fetchPanoData({ location: panoPos, radius: 50 });

		Promise.all([byPano, byLoc]).then(([panoData, locData]) => {
			if (cancelled) return;
			const merged = new Map<string, PanoReference>();
			for (const t of extractTimes(locData)) merged.set(t.pano, t);
			for (const t of extractTimes(panoData)) merged.set(t.pano, t);

			// If all entries are unofficial, do an extra
			// official-only lookup to get the full multi-year coverage history.
			const allUnofficial = merged.size > 0 && [...merged.keys()].every((p) => !isOfficialPano(p));
			if (allUnofficial && !cancelled) {
				fetchPanoData({
					location: panoPos,
					radius: 25,
					sources: [google.maps.StreetViewSource.GOOGLE],
				}).then((officialData) => {
					if (cancelled) return;
					for (const t of extractTimes(officialData)) merged.set(t.pano, t);
					setPanoDates(Array.from(merged.values()));
				});
			} else {
				setPanoDates(Array.from(merged.values()));
			}
		});

		fetchSvMetadata([loc.pano]).then(([data]) => {
			if (cancelled || !data) return;
			setAltitude(data.extra?.altitude ?? 0);
			const loc = getActiveLocation();
			if (loc) enrich(loc, data);
		});

		return () => {
			cancelled = true;
		};
	}, [location?.id, currentPano?.location?.pano]);

	useEffect(() => {
		if (isFullscreen) {
			fullscreenContainerRef.current?.classList.add("is-fullscreen");
		} else {
			fullscreenContainerRef.current?.classList.remove("is-fullscreen");
		}
	}, [isFullscreen]);

	const handleDateChange = useCallback(
		(panoId: string | null) => {
			if (!singletonPano || !location) return;
			// updateLocation no-ops for staged (virtual) locations at the store level.
			if (panoId == null) {
				updateLocation(location, { flags: location.flags & ~LocationFlag.LoadAsPanoId });
				if (location.panoId) singletonPano.setPano(location.panoId);
			} else {
				updateLocation(location, { flags: location.flags | LocationFlag.LoadAsPanoId });
				singletonPano.setPano(panoId);
			}
		},
		[location],
	);

	const handleSave = useCallback(() => {
		if (!location || !singletonPano) return;
		// Staged (virtual) location: updateLocation no-ops, cursorId can't match a
		// negative id, so this falls through to setActiveLocation(null) = close.
		const pov = singletonPano.getPov();
		const zoom = singletonPano.getZoom();
		const pano = singletonPano.getPano();
		const pos = singletonPano.getPosition();

		const savedPanoId = selectedPanoId ?? pano ?? location.panoId;
		const panoChanged = savedPanoId !== location.panoId;
		updateLocation(location, {
			heading: pov.heading,
			pitch: pov.pitch,
			zoom: zoom,
			panoId: savedPanoId,
			lat: pos?.lat() ?? location.lat,
			lng: pos?.lng() ?? location.lng,
			tags: pendingTags,
			extra: panoChanged ? {} : location.extra,
		});
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			reviewNext();
		} else {
			setActiveLocation(null);
		}
	}, [location, selectedPanoId, isReviewMode, reviewSession, pendingTags]);

	const handleClose = useCallback(() => {
		if (isFullscreen) {
			setIsFullscreen(false);
			return;
		}
		if (isReviewMode) {
			reviewNext();
		} else {
			setActiveLocation(null);
		}
	}, [isReviewMode, isFullscreen]);

	const handleDelete = useCallback(() => {
		if (!location) return;
		// Staged: removeLocations treats virtual ids as "close the preview".
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			reviewDelete();
		} else {
			removeLocations(new Set([location.id]));
		}
	}, [location, isReviewMode, reviewSession]);

	const handleReturnToSpawn = useCallback(async () => {
		if (!location || !singletonPano) return;
		if (!google) return;
		const result = await resolvePano(location);
		applyResolved(singletonPano, result, location);
		google.maps.event.trigger(singletonPano, "resize");
		updateLocation(location, { flags: location.flags & ~LocationFlag.LoadAsPanoId });
	}, [location]);

	const handleFullscreen = useCallback(() => {
		setIsFullscreen((v) => !v);
	}, []);

	// Reflow the pano (and its FOV) when the preview aspect ratio changes.
	useEffect(() => {
		if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
	}, [appSettings.previewAspectRatio]);

	useHotkey(useBinding("locationSave"), () => {
		if (location) handleSave();
	});
	useHotkey(useBinding("locationClose"), () => {
		handleClose();
	});
	useHotkey(useBinding("locationDelete"), () => {
		if (location) handleDelete();
	});
	useHotkey(useBinding("reviewNext"), () => {
		if (isReviewMode) reviewNext();
	});
	useHotkey(useBinding("reviewPrev"), () => {
		if (isReviewMode) reviewPrev();
	});
	useHotkey(useBinding("toggleFullscreen"), () => {
		handleFullscreen();
	});
	useHotkey(useBinding("returnToSpawn"), () => {
		handleReturnToSpawn();
	});
	useHotkey(useBinding("pointNorth"), () => {
		if (singletonPano) {
			cancelTweenRef.current?.();
			const h = singletonPano.getPov().heading;
			if (Math.abs(h) < 1 && Math.abs(singletonPano.getPov().pitch) < 1) {
				cancelTweenRef.current = tweenPov(singletonPano, { heading: 0, pitch: -90 });
			} else {
				cancelTweenRef.current = tweenPov(singletonPano, { heading: 0, pitch: 0 });
			}
		}
	});
	useHotkey(useBinding("centerRoad"), () => {
		if (!singletonPano) return;
		const headings = (singletonPano.getLinks() ?? [])
			.map((l) => l?.heading)
			.filter((h): h is number => h != null);
		const nearest = nearestLinkHeading(headings, singletonPano.getPov().heading);
		if (nearest == null) return;
		cancelTweenRef.current?.();
		cancelTweenRef.current = tweenPov(singletonPano, { heading: nearest, pitch: 0 });
	});
	useHotkey(useBinding("spin180"), () => {
		if (singletonPano) {
			cancelTweenRef.current?.();
			const pov = singletonPano.getPov();
			cancelTweenRef.current = tweenPov(singletonPano, {
				heading: (pov.heading + 180) % 360,
				pitch: pov.pitch,
			});
		}
	});
	useHotkey(useBinding("zoomIn"), () => {
		if (singletonPano) {
			singletonPano.setZoom(Math.min(4, singletonPano.getZoom() + 1));
		}
	});
	useHotkey(useBinding("zoomOut"), () => {
		if (singletonPano) {
			singletonPano.setZoom(Math.max(0, singletonPano.getZoom() - 1));
		}
	});
	useHotkey(useBinding("panoZoomReset"), () => {
		if (singletonPano) {
			singletonPano.setZoom(0);
		}
	});
	useHotkey(useBinding("copyLink"), () => {
		if (!location) return;
		const btn = document.querySelector<HTMLButtonElement>('button[aria-label^="Copy link"]');
		btn?.click();
	});
	useHotkey(useBinding("toggleCrosshair"), () => {
		setSetting("showCrosshair", !getSettings().showCrosshair);
	});
	useHotkey(useBinding("toggleHideCar"), () => {
		setSetting("showCar", !getSettings().showCar);
	});
	useHotkey(useBinding("togglePanoUI"), () => {
		setSetting("hidePanoUI", !getSettings().hidePanoUI);
	});
	useHotkey(useBinding("duplicateLocation"), () => {
		if (location) duplicateLocation(location.id);
	});

	useHotkey(useBinding("downloadPanoTile"), () => {
		const panoId = singletonPano?.getPano();
		if (panoId) downloadPano(panoId);
	});
	useHotkey(useBinding("nextPanoDate"), () => {
		if (!panoDates.length) return;
		const currentPanoId = selectedPanoId ?? currentPano?.location?.pano ?? location?.panoId;
		const raw = currentPanoId ? panoDates.findIndex((d) => d.pano === currentPanoId) : -1;
		const idx = raw === -1 ? panoDates.length - 1 : raw;
		const next = idx < panoDates.length - 1 ? idx + 1 : 0;
		handleDateChange(panoDates[next].pano);
	});
	useHotkey(useBinding("prevPanoDate"), () => {
		if (!panoDates.length) return;
		const currentPanoId = selectedPanoId ?? currentPano?.location?.pano ?? location?.panoId;
		const raw = currentPanoId ? panoDates.findIndex((d) => d.pano === currentPanoId) : -1;
		const idx = raw === -1 ? panoDates.length - 1 : raw;
		const prev = idx > 0 ? idx - 1 : panoDates.length - 1;
		handleDateChange(panoDates[prev].pano);
	});
	useHotkey(useBinding("followRoad"), () => {
		if (!singletonPano) return;
		const panoId = singletonPano.getPano();
		const heading = singletonPano.getPov().heading;
		if (!panoId) return;
		const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
		if (container) showToast(container, "Following road...");
		followLinkedPanos(panoId, heading)
			.then((locs) => {
				if (locs.length > 0) addLocations(locs);
				if (container) showToast(container, `Added ${locs.length} locations`);
			})
			.catch(() => {
				if (container) showToast(container, "Follow road failed");
			});
	});

	useHotkey(useBinding("refreshPano"), () => {
		if (!singletonPano || !location) return;
		const panoId = singletonPano.getPano();
		const pov = singletonPano.getPov();
		const zoom = singletonPano.getZoom();
		singletonPano.setVisible(false);
		singletonPano = null;
		const fresh = getPanorama();
		if (!fresh) return;
		if (panoId) fresh.setPano(panoId);
		else fresh.setPosition({ lat: location.lat, lng: location.lng });
		fresh.setPov(pov);
		fresh.setZoom(zoom);
		fresh.setVisible(true);
		google.maps.event.trigger(fresh, "resize");
		sendHideCar(!getSettings().showCar);
	});

	useHotkey(useBinding("viewportLock"), () => {
		if (singletonPano) toggleViewportLock(singletonPano);
	});

	const pendingTagsRef = useRef(pendingTags);
	pendingTagsRef.current = pendingTags;
	// Quicktag slots 1-9: toggle the Nth tag in the current sort order. Bindings
	// are rebindable (registered as quicktag1..9 hotkey actions), defaulting to 1-9.
	const quicktagSlot = (idx: number) => {
		if (!location || !map) return;
		const tags = sortTagsByMode(getVisibleTags(), getSettings().tagSortMode, getTagCounts());
		if (idx >= tags.length) return;
		const tag = tags[idx];
		const cur = pendingTagsRef.current;
		const has = cur.includes(tag.id);
		setPendingTags(has ? cur.filter((t) => t !== tag.id) : [...cur, tag.id]);
	};
	// Per-map bindings: registered only while a location is open, so the keys
	// fall through to global hotkeys otherwise. Soft-deleted (invisible) tags
	// keep their binding for undo symmetry; declining lets the key fall through.
	// Staged (virtual) locations are read-only: both actions decline.
	const hasLocation = location != null;
	useEffect(() => {
		if (!hasLocation) return;
		const unregisterApply = registerMapKeyActionHandler("applyTag", ({ tagId }) => {
			const active = getActiveLocation();
			if (!active || isVirtualLocation(active)) return false;
			if (!getVisibleTags().some((t) => t.id === tagId)) return false;
			const cur = pendingTagsRef.current;
			setPendingTags(cur.includes(tagId) ? cur.filter((t) => t !== tagId) : [...cur, tagId]);
		});
		const unregisterCopy = registerMapKeyActionHandler("copyToMap", ({ mapId }) => {
			const loc = getActiveLocation();
			if (!loc || isVirtualLocation(loc)) return false;
			const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
			const t0 = performance.now();
			cmd
				.storeCopyLocationsToMap(mapId, [loc.id])
				.then((res) => {
					log.debug(`[copyToMap] ipc=${Math.round(performance.now() - t0)}ms`);
					if (!container) return;
					showToast(
						container,
						res.copied > 0
							? `Copied to "${res.targetName}"`
							: `Already in "${res.targetName}"`,
					);
				})
				.catch((e) => {
					log.error("[copyToMap] failed:", e);
					if (container) showToast(container, "Copy failed");
				});
		});
		return () => {
			unregisterApply();
			unregisterCopy();
		};
	}, [hasLocation]);

	useHotkey(useBinding("quicktag1"), () => quicktagSlot(0));
	useHotkey(useBinding("quicktag2"), () => quicktagSlot(1));
	useHotkey(useBinding("quicktag3"), () => quicktagSlot(2));
	useHotkey(useBinding("quicktag4"), () => quicktagSlot(3));
	useHotkey(useBinding("quicktag5"), () => quicktagSlot(4));
	useHotkey(useBinding("quicktag6"), () => quicktagSlot(5));
	useHotkey(useBinding("quicktag7"), () => quicktagSlot(6));
	useHotkey(useBinding("quicktag8"), () => quicktagSlot(7));
	useHotkey(useBinding("quicktag9"), () => quicktagSlot(8));

	const panoNavRef = useRef({ held: new Set<string>(), rafId: 0, alt: false, lastTime: 0 });
	const appSettingsRef = useRef(appSettings);
	appSettingsRef.current = appSettings;

	useEffect(() => {
		const nav = panoNavRef.current;
		const lookActions = ["panoLookLeft", "panoLookRight", "panoLookUp", "panoLookDown"] as const;
		const moveActions = ["panoMoveForward", "panoMoveBackward"] as const;
		const allActions = [...lookActions, ...moveActions] as const;

		function tick() {
			if (!singletonPano || nav.held.size === 0) {
				nav.rafId = 0;
				nav.lastTime = 0;
				return;
			}

			const now = performance.now();
			const dt = nav.lastTime ? (now - nav.lastTime) / 16.667 : 1;
			nav.lastTime = now;

			const s = appSettingsRef.current;
			const slow = nav.alt ? s.slowModifier : 1;
			const speed = (s.panoLookSpeed * 0.4 * dt) / slow;
			const pov = singletonPano.getPov();
			let dh = 0,
				dp = 0;
			if (nav.held.has("panoLookLeft")) dh -= speed;
			if (nav.held.has("panoLookRight")) dh += speed;
			if (nav.held.has("panoLookUp")) dp += speed;
			if (nav.held.has("panoLookDown")) dp -= speed;

			if (dh || dp) {
				singletonPano.setOptions({
					pov: {
						heading: (pov.heading + dh + 360) % 360,
						pitch: Math.max(-90, Math.min(90, pov.pitch + dp)),
					},
				});
			}

			nav.rafId = requestAnimationFrame(tick);
		}

		function getParsed() {
			return allActions.map((a) => ({ action: a, parsed: parseHotkey(getBinding(a)) }));
		}
		const bindings = getParsed();

		function onKeyDown(e: KeyboardEvent) {
			nav.alt = e.altKey;
			if (e.key === "Alt") {
				e.preventDefault();
				return;
			}
			if (e.defaultPrevented || e.repeat) return;
			if (isEditableElement(e.target)) return;
			for (const { action, parsed } of bindings) {
				for (const alt of parsed) {
					if (alt.length === 1 && matchesKey(e, alt[0], { ignoreAlt: true })) {
						if (action === "panoMoveForward" || action === "panoMoveBackward") {
							if (!singletonPano) return;
							const links = singletonPano
								.getLinks()
								?.filter((l): l is google.maps.StreetViewLink => l != null);
							if (!links?.length) return;
							const heading = singletonPano.getPov().heading;
							const target = action === "panoMoveForward" ? heading : (heading + 180) % 360;
							let best = links[0];
							let bestDiff = 360;
							for (const link of links) {
								const diff = Math.abs(((link.heading! - target + 540) % 360) - 180);
								if (diff < bestDiff) {
									bestDiff = diff;
									best = link;
								}
							}
							if (best.pano) singletonPano.setPano(best.pano);
							e.preventDefault();
							e.stopImmediatePropagation();
							return;
						}
						nav.held.add(action);
						if (!nav.rafId) nav.rafId = requestAnimationFrame(tick);
						e.preventDefault();
						e.stopImmediatePropagation();
						return;
					}
				}
			}
		}

		function onKeyUp(e: KeyboardEvent) {
			nav.alt = e.altKey;
			if (nav.held.size === 0) return;
			const key = e.key.toLowerCase();
			for (const { action, parsed } of bindings) {
				for (const alt of parsed) {
					if (alt.length === 1 && alt[0].key === key) {
						nav.held.delete(action);
					}
				}
			}
		}

		function onBlur() {
			nav.held.clear();
		}

		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
			if (nav.rafId) cancelAnimationFrame(nav.rafId);
			nav.held.clear();
		};
	}, []);

	const onExactDateResolved = useCallback((ts: number, timezone: string | null) => {
		if (!(getCurrentMap()?.meta.settings.enrichMetadata ?? true)) return;
		const loc = getActiveLocation();
		if (!loc || loc.extra?.datetime != null) return;
		patchLocationExtra(loc, { datetime: ts, timezone });
	}, []);

	if (!location || !map) return null;

	const locTags = pendingTags.map((id) => map.meta.tags[id]).filter(Boolean);
	const allTags = sortTagsByMode(getVisibleTags(), tagSortMode, getTagCounts());
	const suggestions = (() => {
		const available = allTags.filter((t) => !pendingTags.includes(t.id));
		if (tagInput.trim()) {
			const lower = tagInput.toLowerCase();
			return available.filter((t) => t.name.toLowerCase().includes(lower)).slice(0, 15);
		}
		return available.slice(0, 15);
	})();

	const handleAddTag = async (e: React.FormEvent) => {
		e.preventDefault();
		const name = tagInput.trim();
		if (!name) return;
		const [resolved] = await createTags([name]);
		if (!pendingTags.includes(resolved.id)) {
			setPendingTags([...pendingTags, resolved.id]);
		}
		setTagInput("");
	};

	const handleRemoveTag = (tagId: number) => {
		setPendingTags(pendingTags.filter((t) => t !== tagId));
	};

	const handleSuggestionClick = (t: Tag) => {
		if (!pendingTags.includes(t.id)) {
			setPendingTags([...pendingTags, t.id]);
		}
		setTagInput("");
	};

	return (
		<>
			<ReviewBar />
			<section className="location-preview">
				<div
					className="location-preview__panorama"
					ref={fullscreenContainerRef}
					style={isFullscreen ? undefined : { aspectRatio: appSettings.previewAspectRatio }}
				>
					<div
						className={`location-preview__embed${appSettings.hidePanoUI ? " hide-pano-ui" : ""}`}
					>
						<div style={{ position: "absolute", inset: 0 }} ref={panoContainerRef} />
						{appSettings.defaultMovementMode === "nmpz" && (
							<div style={{ position: "absolute", inset: 0, zIndex: 1 }} />
						)}
						{panoReady && singletonPano && !appSettings.hidePanoUI && (
							<PanoControls
								panorama={singletonPano}
								location={location}
								altitude={altitude}
								isFullscreen={isFullscreen}
								onFullscreen={handleFullscreen}
								onReturnToSpawn={handleReturnToSpawn}
							/>
						)}
						{lockInfo && (
							<div className="viewport-lock-badge">
								LOCK h {lockInfo.relHeading.toFixed(1)} p {lockInfo.relPitch.toFixed(1)} z{" "}
								{lockInfo.lockedZoom.toFixed(1)}
							</div>
						)}
					</div>
					{isFullscreen && appSettings.showFullscreenMinimap && (
						<FullscreenMiniMap lat={location.lat} lng={location.lng} panorama={singletonPano} />
					)}
					{isFullscreen && appSettings.showFullscreenTagbar && (
						<FullscreenTagBar
							pendingTags={pendingTags}
							onChangeTags={setPendingTags}
							tags={getVisibleTags()}
						/>
					)}
				</div>
				<div className="location-preview__meta">
					<span className="location-preview__description">
						{geoResult?.countryCode && (
							<span role="tooltip" aria-label="As identified by OSM" data-microtip-position="top">
								<img
									height={15}
									width={20}
									src={`/flags/${geoResult.countryCode.toUpperCase()}.svg`}
									alt={geoResult.countryCode}
									style={{ borderRadius: "2px", verticalAlign: "middle" }}
								/>
							</span>
						)}
						{geoResult?.countryCode && geoResult.text && " "}
						{geoResult?.text && <span>{geoResult.text}</span>}
					</span>
					<div className="location-preview__date">
						<PanoDatePicker
							defaultPanoId={location.panoId}
							onChange={handleDateChange}
							onExactDateResolved={onExactDateResolved}
						/>
					</div>
					<div className="location-preview__actions">
						<button className="button button--primary" onClick={handleSave} data-qa="location-save">
							Save
						</button>
						{isReviewMode ? (
							<div style={{ display: "flex", justifyContent: "space-around" }}>
								<button
									className="button"
									onClick={() => reviewPrev()}
									disabled={reviewSession ? isAtStart(reviewSession) : true}
									role="tooltip"
									aria-label="Go to previous location (Control+Left)"
									data-microtip-position="top"
									data-qa="review-prev"
								>
									<svg height="24" width="24" viewBox="0 0 24 24" fill="currentColor">
										<path d="M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z" />
									</svg>
								</button>
								<button
									className="button"
									onClick={handleClose}
									role="tooltip"
									aria-label="Go to next location (Control+Right)"
									data-microtip-position="top"
									data-qa="review-next"
								>
									<svg height="24" width="24" viewBox="0 0 24 24" fill="currentColor">
										<path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" />
									</svg>
								</button>
							</div>
						) : (
							<button className="button" onClick={handleClose} data-qa="location-close">
								Close
							</button>
						)}
						<button
							className="button button--destructive"
							onClick={handleDelete}
							data-qa="location-delete"
						>
							Delete
						</button>
					</div>
					<div className="location-preview__tags">
						{isStaged ? (
							<p>
								This location is still being imported and cannot be modified. Complete the
								import before making changes.
							</p>
						) : (
						<>
						<ul className="tag-list">
							{locTags.map((t) => (
								<li
									key={t.id}
									className="tag is-small has-button"
									style={{
										backgroundColor: t.color,
										color: textColorFor(t.color),
									}}
								>
									<button
										className="button tag__button tag__button--delete"
										onClick={() => handleRemoveTag(t.id)}
										type="button"
									>
										<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
											<path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" />
										</svg>
									</button>
									<span className="tag__text">{t.name}</span>
								</li>
							))}
							<li>
								<form className="form-add-tag" onSubmit={handleAddTag}>
									<button className="button form-add-tag__button" type="submit">
										+
									</button>
									<input
										className="form-add-tag__input"
										type="text"
										placeholder="Add a tag…"
										value={tagInput}
										onChange={(e) => setTagInput(e.target.value)}
									/>
								</form>
							</li>
						</ul>
						{suggestions.length > 0 && (
							<div style={{ paddingTop: "0.5rem" }}>
								<ol className="tag-list">
									{suggestions.map((t) => (
										<li
											key={t.id}
											className="tag is-small has-button"
											style={{
												backgroundColor: t.color,
												color: textColorFor(t.color),
											}}
										>
											<button
												className="button tag__button tag__button--add"
												onClick={() => handleSuggestionClick(t)}
												type="button"
											>
												<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
													<path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" />
												</svg>
											</button>
											<span className="tag__text">{t.name}</span>
										</li>
									))}
								</ol>
							</div>
						)}
						</>
						)}
					</div>
					<PluginLocationPanels />
				</div>
			</section>
		</>
	);
}
