import { useState, useEffect, useRef, useMemo, type RefObject } from "react";
import { NSelect } from "@/components/primitives/NSelect";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { Button } from "@/components/primitives/Button";
import { buildTileUrl, createRoadmapTileConfig, type MapStyle } from "@/lib/geo/tiles";
import {
	BUILTIN_STYLE_KEYS,
	BUILTIN_STYLE_LABELS,
	VECTOR_STYLE_KEYS,
	VECTOR_STYLE_LABELS,
} from "@/lib/geo/mapStyles";
import type { MapEmbedPrefs } from "@/store/mapEmbedPrefs";
import { Icon } from "@/components/primitives/Icon";
import { mdiChevronDown, mdiCogOutline } from "@mdi/js";
import type { MapTypeKey, SvCoverageType, MarkerStyle } from "@/types";
import { ColorPicker } from "@/components/primitives/ColorPicker";
import { useClickOutside } from "@/lib/hooks/useClickOutside";
import { useStableHandler } from "@/lib/hooks/useStableHandler";
import { Slider } from "@/components/primitives/Slider";
import { hexToRgb, rgbToHex, resolveSvColorHex } from "@/lib/util/color";
import { useMapSetting } from "@/store/useMapSetting";
import { formatDistance } from "@/lib/util/format";
import { useSetting } from "@/store/settings";
import { t, msg } from "@/lib/i18n";

const MAP_TYPE_LABELS: Record<MapTypeKey, string> = {
	map: msg("Map"),
	satellite: msg("Satellite"),
	osm: msg("OSM"),
	vector: msg("Vector"),
};

export interface LayerConfig {
	prefs: MapEmbedPrefs;
	setPref: <K extends keyof MapEmbedPrefs>(k: K) => (v: MapEmbedPrefs[K]) => void;
	supportsLabels: boolean;
	supportsTerrain: boolean;
	// Google styler options (borders, hide POI, styles); off for vector basemaps.
	supportsStyling: boolean;
	customStyles: { name: string; style: MapStyle[] }[];
	onManageStyles: () => void;
}

function SearchRadiusSlider({
	value,
	onChange,
}: {
	value: number | null;
	onChange: (v: number | null) => void;
}) {
	const [dragging, setDragging] = useState<number | null>(null);
	const display = dragging ?? value ?? 50;
	useSetting("units");
	return (
		<label className="settings-popup__item settings-popup__select">
			{t("Min search radius:")}{" "}
			<Slider
				min={10}
				max={500}
				step={10}
				value={display}
				onInput={(e) => setDragging(Number((e.target as HTMLInputElement).value))}
				onChange={() => {}}
				onPointerUp={() => {
					if (dragging != null) {
						onChange(dragging === 50 ? null : dragging);
						setDragging(null);
					}
				}}
				style={{ width: 80, verticalAlign: "middle" }}
			/>{" "}
			<span className="mono">{formatDistance(display)}</span>
		</label>
	);
}

function SettingsPopup({ layerConfig: e }: { layerConfig: LayerConfig }) {
	const { prefs: p, setPref } = e;
	return (
		<div className="layer-config">
			{/* Layers */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					{t("Layers")} <span className="layer-config__divider" />
				</legend>
				<SwitchRow
					className="layer-config__item"
					checked={p.showTerrain}
					disabled={!e.supportsTerrain}
					onChange={(v) => setPref("showTerrain")(v)}
					label={t("Terrain")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked
					disabled
					onChange={() => {}}
					label={t("Street View")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.showLabels}
					disabled={!e.supportsLabels}
					onChange={(v) => setPref("showLabels")(v)}
					label={t("Labels")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.svPanoramas}
					onChange={(v) => setPref("svPanoramas")(v)}
					label={t("Panoramas (requires close zoom)")}
				/>
			</fieldset>
			{/* Street View */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					{t("Street\u00A0View")} <span className="layer-config__divider" />
				</legend>
				<div
					className="layer-config__item"
					style={{ display: "flex", justifyContent: "space-between" }}
				>
					<span>{t("Show lines:")}</span>
					<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<div className="button-group">
							{[
								{ value: "official" as SvCoverageType, name: t("Official") },
								{ value: "unofficial" as SvCoverageType, name: t("Unofficial") },
								{ value: "default" as SvCoverageType, name: t("All") },
							].map((opt) => (
								<Button
									key={opt.value}
									className="button-group__button"
									aria-checked={p.svCoverageType === opt.value}
									onClick={() => setPref("svCoverageType")(opt.value)}
								>
									{opt.name}
								</Button>
							))}
						</div>
						<ColorPicker
							color={hexToRgb(resolveSvColorHex(p.svColor))}
							onChange={(c) => setPref("svColor")(rgbToHex(c))}
							ariaLabel={t("Coverage line color")}
						/>
					</div>
				</div>
				<SwitchRow
					className="layer-config__item"
					checked={p.svThickness === "high"}
					onChange={(v) => setPref("svThickness")(v ? "high" : "default")}
					label={t("Make the lines thinner")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.svBlobby}
					onChange={(v) => setPref("svBlobby")(v)}
					label={t("Use blobby layer while zoomed out")}
				/>
			</fieldset>
			{/* Settings */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					{t("Settings")} <span className="layer-config__divider" />
				</legend>
				<SwitchRow
					className="layer-config__item"
					checked={p.boldCountryBorders}
					disabled={!e.supportsStyling}
					onChange={(v) => setPref("boldCountryBorders")(v)}
					label={t("Emphasise country borders")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.boldSubdivisionBorders}
					disabled={!e.supportsStyling}
					onChange={(v) => setPref("boldSubdivisionBorders")(v)}
					label={t("Emphasise subdivision borders")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.hideRoadLabels}
					disabled={!e.supportsStyling}
					onChange={(v) => setPref("hideRoadLabels")(v)}
					label={t("Hide road labels")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.hidePoi}
					disabled={!e.supportsStyling}
					onChange={(v) => setPref("hidePoi")(v)}
					label={t("Hide points of interest")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.hideTransit}
					disabled={!e.supportsStyling}
					onChange={(v) => setPref("hideTransit")(v)}
					label={t("Hide transit")}
				/>
				<SwitchRow
					className="layer-config__item"
					checked={p.hideHighways}
					disabled={!e.supportsStyling}
					onChange={(v) => setPref("hideHighways")(v)}
					label={t("Hide highways")}
				/>
			</fieldset>
			{/* Map style */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					{t("Map\u00A0style")} <span className="layer-config__divider" />
				</legend>
				{p.mapType === "vector" ? (
					<div
						className="layer-config__item settings-popup__select"
						style={{ display: "flex", alignItems: "center", gap: 4 }}
					>
						{t("Style:")}{" "}
						<NSelect
							className="nselect--limited"
							value={p.vectorStyleName}
							onChange={(ev) => setPref("vectorStyleName")(ev.target.value)}
							style={{ flex: 1 }}
						>
							{VECTOR_STYLE_KEYS.map((key) => (
								<option key={key} value={key}>
									{t(VECTOR_STYLE_LABELS[key])}
								</option>
							))}
						</NSelect>
					</div>
				) : (
					<div
						className="layer-config__item settings-popup__select"
						style={{ display: "flex", alignItems: "center", gap: 4 }}
					>
						{t("Style:")}{" "}
						<NSelect
							className="nselect--limited"
							value={p.mapStyleName}
							disabled={!e.supportsStyling}
							onChange={(ev) => setPref("mapStyleName")(ev.target.value)}
							style={{ flex: 1 }}
						>
							{BUILTIN_STYLE_KEYS.map((key) => (
								<option key={key} value={key}>
									{t(BUILTIN_STYLE_LABELS[key])}
								</option>
							))}
							{e.customStyles.map((s) => (
								<option key={s.name} value={s.name}>
									{s.name}
								</option>
							))}
						</NSelect>
						<button
							className="icon-button icon-button--inline"
							title={t("Manage map styles")}
							onClick={(ev) => {
								ev.preventDefault();
								e.onManageStyles();
							}}
						>
							<Icon path={mdiCogOutline} size={18} />
						</button>
					</div>
				)}
			</fieldset>
		</div>
	);
}

const MAP_TYPE_PREVIEW_STATIC: Partial<Record<MapTypeKey, string>> = {
	satellite: "https://mts1.googleapis.com/vt?hl=en-US&lyrs=s&x=0&y=0&z=0",
	osm: "https://tile.openstreetmap.org/0/0/0.png",
	// No raster endpoint for OpenFreeMap styles; Carto's voyager raster is a close stand-in.
	vector: "https://basemaps.cartocdn.com/rastertiles/voyager/0/0/0.png",
};

const MAP_TYPES: MapTypeKey[] = ["map", "satellite", "osm", "vector"];

function BasemapSelector({
	previewUrls,
	selected,
	onSelect,
}: {
	previewUrls: Record<MapTypeKey, string>;
	selected: MapTypeKey;
	onSelect: (type: MapTypeKey) => void;
}) {
	return (
		<div className="map-type-control__basemap">
			{MAP_TYPES.map((type) => (
				<button
					key={type}
					type="button"
					className="map-type-control__button"
					data-state={selected === type ? "on" : "off"}
					onClick={() => onSelect(type)}
				>
					<div className="map-type-control__background">
						<img src={previewUrls[type]} alt="" draggable={false} />
					</div>
					<span>{t(MAP_TYPE_LABELS[type])}</span>
				</button>
			))}
		</div>
	);
}

function LayerConfigToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			className="map-type-control__toggle"
			data-state={open ? "open" : "closed"}
			aria-expanded={open}
			aria-label={t("Layers and map style")}
			title={t("Layers and map style")}
			onClick={onClick}
		>
			<Icon path={mdiChevronDown} size={20} />
		</button>
	);
}

function useCloseOnEscape(close: () => void, enabled: boolean) {
	const handler = useStableHandler(close);
	useEffect(() => {
		if (!enabled) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") handler();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [handler, enabled]);
}

/** Collapse to a single menu button when the expanded basemap would overlap top-right controls. */
function useMapTypeCompact(
	containerRef: RefObject<HTMLDivElement | null>,
	rowMeasureRef: RefObject<HTMLDivElement | null>,
) {
	const [compact, setCompact] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		const measure = rowMeasureRef.current;
		if (!el) return;
		const root = el.closest(".embed-controls");
		const leftGroup = el.closest(".embed-controls__control");
		if (!root || !leftGroup) return;

		const check = () => {
			const rowWidth = measure?.scrollWidth ?? 0;
			if (rowWidth === 0) return;

			const rootRect = root.getBoundingClientRect();
			const leftEdge = rootRect.left + 8;
			const topBandBottom = rootRect.top + 52;
			let conflictLeft = rootRect.right - 8;

			for (const control of Array.from(root.querySelectorAll(".embed-controls__control"))) {
				if (control === leftGroup) continue;
				const rect = control.getBoundingClientRect();
				if (rect.top >= topBandBottom || rect.bottom <= rootRect.top) continue;
				if (rect.left > leftEdge + 80) {
					conflictLeft = Math.min(conflictLeft, rect.left);
				}
			}

			const marginX = (n: HTMLElement) => {
				const s = getComputedStyle(n);
				return (parseFloat(s.marginLeft) || 0) + (parseFloat(s.marginRight) || 0);
			};
			let siblingsWidth = 0;
			for (const child of Array.from(leftGroup.children)) {
				if (child !== el && child instanceof HTMLElement) {
					siblingsWidth += child.getBoundingClientRect().width + marginX(child);
				}
			}

			const available = conflictLeft - leftEdge - 8;
			const needed = rowWidth + marginX(el) + siblingsWidth;
			setCompact((prev) => {
				// Hysteresis avoids flip-flopping at the breakpoint.
				if (prev) return needed > available;
				return needed > available + 8;
			});
		};

		const obs = new ResizeObserver(check);
		obs.observe(root);
		if (measure) obs.observe(measure);
		for (const child of Array.from(leftGroup.children)) {
			if (child !== el && child instanceof HTMLElement) obs.observe(child);
		}
		check();
		return () => obs.disconnect();
	}, [containerRef, rowMeasureRef]);

	return compact;
}

export function MapTypeDropdown({ layerConfig }: { layerConfig: LayerConfig }) {
	const [isOpen, setIsOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const rowMeasureRef = useRef<HTMLDivElement>(null);
	const rowRef = useRef<HTMLDivElement>(null);
	const compact = useMapTypeCompact(containerRef, rowMeasureRef);
	const mapPreviewUrl = useMemo(() => buildTileUrl(createRoadmapTileConfig(), 0, 0, 0), []);

	useEffect(() => {
		const measure = rowMeasureRef.current;
		const visible = rowRef.current;
		if (!measure || !visible) return;
		const sync = () => {
			visible.style.width = `${measure.scrollWidth}px`;
		};
		const obs = new ResizeObserver(sync);
		obs.observe(measure);
		sync();
		return () => obs.disconnect();
	}, [compact]);

	useClickOutside(containerRef, () => setIsOpen(false), isOpen);
	useCloseOnEscape(() => setIsOpen(false), isOpen);

	const previewUrls: Record<MapTypeKey, string> = {
		map: mapPreviewUrl,
		satellite: MAP_TYPE_PREVIEW_STATIC.satellite!,
		osm: MAP_TYPE_PREVIEW_STATIC.osm!,
		vector: MAP_TYPE_PREVIEW_STATIC.vector!,
	};

	const settingsPopup = isOpen && (
		<div
			className="settings-popup"
			style={{
				position: "absolute",
				top: "100%",
				left: 0,
				zIndex: 3,
				width: compact ? undefined : "100%",
				boxSizing: "border-box",
				maxHeight: "calc(100vh - 80px)",
				overflowY: "auto",
			}}
		>
			{compact && (
				<BasemapSelector
					previewUrls={previewUrls}
					selected={layerConfig.prefs.mapType}
					onSelect={(t) => layerConfig.setPref("mapType")(t)}
				/>
			)}
			<SettingsPopup layerConfig={layerConfig} />
		</div>
	);

	return (
		<div
			className="map-control map-type-control"
			ref={containerRef}
			style={{ position: "relative" }}
		>
			<div
				ref={rowMeasureRef}
				className="map-type-control__row map-type-control__row--measure"
				aria-hidden
			>
				<BasemapSelector
					previewUrls={previewUrls}
					selected={layerConfig.prefs.mapType}
					onSelect={() => {}}
				/>
				<LayerConfigToggle open={false} onClick={() => {}} />
			</div>
			{compact ? (
				<>
					<button
						type="button"
						className="map-control__menu-button"
						onClick={() => setIsOpen(!isOpen)}
					>
						{t(MAP_TYPE_LABELS[layerConfig.prefs.mapType])}
					</button>
					{settingsPopup}
				</>
			) : (
				<>
					<div ref={rowRef} className="map-type-control__row">
						<BasemapSelector
							previewUrls={previewUrls}
							selected={layerConfig.prefs.mapType}
							onSelect={(t) => layerConfig.setPref("mapType")(t)}
						/>
						<LayerConfigToggle open={isOpen} onClick={() => setIsOpen((v) => !v)} />
					</div>
					{settingsPopup}
				</>
			)}
		</div>
	);
}

export function MapSettingsDropdown({
	prefs: p,
	setPref,
}: {
	prefs: MapEmbedPrefs;
	setPref: <K extends keyof MapEmbedPrefs>(k: K) => (v: MapEmbedPrefs[K]) => void;
}) {
	const [pointAlongRoad, setPointAlongRoad] = useMapSetting("pointAlongRoad");
	const [preferDirection, setPreferDirection] = useMapSetting("preferDirection");
	const [preferOfficial, setPreferOfficial] = useMapSetting("preferOfficial");
	const [preferHigherQuality, setPreferHigherQuality] = useMapSetting("preferHigherQuality");
	const [onlyOfficial, setOnlyOfficial] = useMapSetting("onlyOfficial");
	const [defaultPanoId, setDefaultPanoId] = useMapSetting("defaultPanoId");
	const [searchRadius, setSearchRadius] = useMapSetting("searchRadius");
	const [isOpen, setIsOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useClickOutside(containerRef, () => setIsOpen(false), isOpen);
	useCloseOnEscape(() => setIsOpen(false), isOpen);

	return (
		<div
			className="map-control map-control--menu"
			ref={containerRef}
			style={{ position: "relative" }}
		>
			<button className="map-control__menu-button" onClick={() => setIsOpen(!isOpen)}>
				{t("Map settings")}
			</button>
			{isOpen && (
				<div
					className="settings-popup"
					style={{
						position: "absolute",
						top: "100%",
						right: 0,
						zIndex: 3,
						maxHeight: "calc(100vh - 80px)",
						overflowY: "auto",
					}}
				>
					<fieldset className="fieldset">
						<legend className="fieldset__header">
							{t("Selecting new locations")} <span className="fieldset__divider" />
						</legend>
						<SwitchRow
							checked={pointAlongRoad}
							onChange={setPointAlongRoad}
							label={t("Point view along the road by default")}
						/>
						{pointAlongRoad && (
							<label className="settings-popup__item settings-popup__select">
								{t("Direction:")}{" "}
								<NSelect
									className="nselect--compact"
									value={preferDirection ?? ""}
									onChange={(e) => setPreferDirection(e.target.value || null)}
								>
									<option value="">{t("None")}</option>
									<option value="forwards">{t("Forwards")}</option>
									<option value="backwards">{t("Backwards")}</option>
									<option value="north">{t("Most Northern")}</option>
									<option value="east">{t("Most Eastern")}</option>
									<option value="south">{t("Most Southern")}</option>
									<option value="west">{t("Most Western")}</option>
									<option value="random">{t("Random")}</option>
								</NSelect>
							</label>
						)}
						<SwitchRow
							checked={preferOfficial}
							onChange={setPreferOfficial}
							label={t("Prefer official coverage over unofficial")}
						/>
						<SwitchRow
							checked={preferHigherQuality}
							onChange={setPreferHigherQuality}
							label={t("Prefer higher quality over newer images")}
						/>
						<SwitchRow
							checked={onlyOfficial}
							onChange={setOnlyOfficial}
							label={t("Disallow unofficial coverage")}
						/>
						<SwitchRow
							checked={defaultPanoId}
							onChange={setDefaultPanoId}
							label={t("Use Pano ID locations by default")}
						/>
						<SearchRadiusSlider value={searchRadius} onChange={setSearchRadius} />
					</fieldset>
					<fieldset className="fieldset">
						<legend className="fieldset__header">
							{t("Map behaviour")} <span className="fieldset__divider" />
						</legend>
						<SwitchRow
							checked={p.showPreviews}
							onChange={setPref("showPreviews")}
							label={t("Show location previews when hovering the map")}
						/>
						<SwitchRow
							checked={p.selectOnly}
							onChange={setPref("selectOnly")}
							label={t("Select-only mode")}
						/>
					</fieldset>
					<fieldset className="fieldset">
						<legend className="fieldset__header">
							{t("Display")} <span className="fieldset__divider" />
						</legend>
						<label className="settings-popup__item settings-popup__select">
							{t("Marker style:")}{" "}
							<NSelect
								className="nselect--compact"
								value={p.markerStyle}
								onChange={(e) => setPref("markerStyle")(e.target.value as MarkerStyle)}
							>
								<option value="pin">{t("Pin")}</option>
								<option value="circle">{t("Circle")}</option>
								<option value="arrow">{t("Camera direction arrow")}</option>
							</NSelect>
						</label>
						<label className="settings-popup__item">
							{t("Marker size:")}{" "}
							<Slider
								min={0.5}
								max={3}
								step={0.25}
								value={p.markerSize}
								onChange={(e) => setPref("markerSize")(Number(e.target.value))}
							/>
						</label>
						<SwitchRow
							checked={p.showPerfectScoreCircle}
							onChange={setPref("showPerfectScoreCircle")}
							label={t("Display 5K radius")}
						/>
						<SwitchRow
							checked={p.showSearchRadiusCursor}
							onChange={setPref("showSearchRadiusCursor")}
							label={t("Show click search radius at cursor")}
						/>
					</fieldset>
				</div>
			)}
		</div>
	);
}
