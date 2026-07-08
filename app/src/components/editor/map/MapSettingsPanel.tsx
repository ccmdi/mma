import { useState, useEffect, useRef, useMemo, type RefObject } from "react";
import { ManageFieldsModal } from "@/components/dialogs/ManageFieldsModal";
import { NSelect } from "@/components/primitives/NSelect";
import { getEnrichFieldOptions, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { buildTileUrl, createRoadmapTileConfig, type MapStyle } from "@/lib/geo/tiles";
import { BUILTIN_STYLE_KEYS, BUILTIN_STYLE_LABELS } from "@/lib/geo/mapStyles";
import { EnrichInfoButton } from "@/components/editor/map/EnrichInfoButton";
import { Icon } from "@/components/primitives/Icon";
import { mdiCogOutline } from "@mdi/js";
import {
	type SvColor,
	SV_COLORS,
	type MapTypeKey,
	type SvCoverageType,
	type SvThickness,
	type MarkerStyle,
} from "@/types";
import { useMapSetting } from "@/store/useMapSetting";
import { ScoreBoundsEditor } from "./ScoreBoundsEditor";

const MAP_TYPE_LABELS: Record<MapTypeKey, string> = {
	map: "Map",
	satellite: "Satellite",
	osm: "OSM",
};

export interface LayerConfig {
	basemap: MapTypeKey;
	setBasemap: (v: MapTypeKey) => void;
	labels: boolean;
	setLabels: (v: boolean) => void;
	supportsLabels: boolean;
	terrain: boolean;
	setTerrain: (v: boolean) => void;
	supportsTerrain: boolean;
	streetViewPanoramas: boolean;
	setStreetViewPanoramas: (v: boolean) => void;
	streetViewCoverageType: SvCoverageType;
	setStreetViewCoverageType: (v: SvCoverageType) => void;
	svColor: SvColor;
	setSvColor: (v: SvColor) => void;
	streetViewCoverageThickness: SvThickness;
	setStreetViewCoverageThickness: (v: SvThickness) => void;
	streetViewBlobby: boolean;
	setStreetViewBlobby: (v: boolean) => void;
	boldCountryBorders: boolean;
	setBoldCountryBorders: (v: boolean) => void;
	boldSubdivisionBorders: boolean;
	setBoldSubdivisionBorders: (v: boolean) => void;
	mapStyleName: string;
	setMapStyleName: (v: string) => void;
	customStyles: { name: string; style: MapStyle[] }[];
	onManageStyles: () => void;
}

/** App-level (localStorage) prefs the panel renders. Per-map settings are read
 *  directly via `useMapSetting`, not passed in. */
export interface MapSettingsDropdownProps {
	markerStyle: MarkerStyle;
	setMarkerStyle: (v: MarkerStyle) => void;
	markerSize: number;
	setMarkerSize: (v: number) => void;
	showPerfectScoreCircle: boolean;
	setShowPerfectScoreCircle: (v: boolean) => void;
	showSearchRadiusCursor: boolean;
	setShowSearchRadiusCursor: (v: boolean) => void;
	showPreviews: boolean;
	setShowPreviews: (v: boolean) => void;
	selectOnly: boolean;
	setSelectOnly: (v: boolean) => void;
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
	return (
		<label className="settings-popup__item settings-popup__select">
			Min search radius:{" "}
			<input
				type="range"
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
			{display}m
		</label>
	);
}

function SettingsPopup({ layerConfig: e }: { layerConfig: LayerConfig }) {
	return (
		<div className="layer-config">
			{/* Layers */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					Layers <span className="layer-config__divider" />
				</legend>
				<label className="layer-config__item" role="menuitem">
					<input
						role="menuitemcheckbox"
						type="checkbox"
						checked={e.terrain}
						disabled={!e.supportsTerrain}
						onChange={(ev) => e.setTerrain(ev.target.checked)}
					/>
					Terrain
				</label>
				<label className="layer-config__item">
					<input role="menuitemcheckbox" type="checkbox" checked disabled />
					Street View
				</label>
				<label className="layer-config__item">
					<input
						role="menuitemcheckbox"
						type="checkbox"
						checked={e.labels}
						disabled={!e.supportsLabels}
						onChange={(ev) => e.setLabels(ev.target.checked)}
					/>
					Labels
				</label>
				<label className="layer-config__item">
					<input
						role="menuitemcheckbox"
						type="checkbox"
						checked={e.streetViewPanoramas}
						onChange={(ev) => e.setStreetViewPanoramas(ev.target.checked)}
					/>
					Panoramas (requires close zoom)
				</label>
			</fieldset>
			{/* Street View */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					Street&nbsp;View <span className="layer-config__divider" />
				</legend>
				<div
					className="layer-config__item"
					style={{ display: "flex", justifyContent: "space-between" }}
				>
					<span>Show lines:</span>
					<div className="button-group">
						{[
							{ value: "official" as SvCoverageType, name: "Official" },
							{ value: "unofficial" as SvCoverageType, name: "Unofficial" },
							{ value: "default" as SvCoverageType, name: "All" },
						].map((opt) => (
							<button
								key={opt.value}
								className="button button-group__button"
								aria-checked={e.streetViewCoverageType === opt.value}
								onClick={() => e.setStreetViewCoverageType(opt.value)}
							>
								{opt.name}
							</button>
						))}
					</div>
				</div>
				<label className="layer-config__item">
					<div className="color-swatch">
						{SV_COLORS.map((c) => (
							<button
								key={c}
								type="button"
								className="color-swatch__block"
								data-state={e.svColor === c ? "on" : "off"}
								onClick={() => e.setSvColor(c)}
							>
								<div className="color-block" style={{ backgroundColor: `var(--${c}-7)` }} />
							</button>
						))}
					</div>
				</label>
				<label className="layer-config__item">
					<input
						type="checkbox"
						checked={e.streetViewCoverageThickness === "high"}
						onChange={(ev) =>
							e.setStreetViewCoverageThickness(ev.target.checked ? "high" : "default")
						}
					/>{" "}
					Make the lines thinner
				</label>
				<label className="layer-config__item">
					<input
						type="checkbox"
						checked={e.streetViewBlobby}
						onChange={(ev) => e.setStreetViewBlobby(ev.target.checked)}
					/>{" "}
					Use blobby layer while zoomed out
				</label>
			</fieldset>
			{/* Settings */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					Settings <span className="layer-config__divider" />
				</legend>
				<label className="layer-config__item">
					<input
						role="menuitemcheckbox"
						type="checkbox"
						checked={e.boldCountryBorders}
						onChange={(ev) => e.setBoldCountryBorders(ev.target.checked)}
					/>
					Emphasise country borders
				</label>
				<label className="layer-config__item">
					<input
						role="menuitemcheckbox"
						type="checkbox"
						checked={e.boldSubdivisionBorders}
						onChange={(ev) => e.setBoldSubdivisionBorders(ev.target.checked)}
					/>
					Emphasise subdivision borders
				</label>
			</fieldset>
			{/* Map style */}
			<fieldset className="layer-config__group">
				<legend className="layer-config__header">
					Map&nbsp;style <span className="layer-config__divider" />
				</legend>
				<label className="layer-config__item settings-popup__select">
					Style:{" "}
					<NSelect
						className="nselect--limited"
						value={e.mapStyleName}
						onChange={(ev) => e.setMapStyleName(ev.target.value)}
					>
						{BUILTIN_STYLE_KEYS.map((key) => (
							<option key={key} value={key}>
								{BUILTIN_STYLE_LABELS[key]}
							</option>
						))}
						{e.customStyles.map((s) => (
							<option key={s.name} value={s.name}>
								{s.name}
							</option>
						))}
					</NSelect>
				</label>
				<a
					href="#"
					onClick={(ev) => {
						ev.preventDefault();
						e.onManageStyles();
					}}
				>
					Manage map styles
				</a>
			</fieldset>
		</div>
	);
}

const MAP_TYPE_PREVIEW_STATIC: Partial<Record<MapTypeKey, string>> = {
	satellite: "https://mts1.googleapis.com/vt?hl=en-US&lyrs=s&x=0&y=0&z=0",
	osm: "https://tile.openstreetmap.org/0/0/0.png",
};

const MAP_TYPES: MapTypeKey[] = ["map", "satellite", "osm"];

function BasemapSelector({
	previewUrls,
	selected,
	onSelect,
	onMouseEnter,
}: {
	previewUrls: Record<MapTypeKey, string>;
	selected: MapTypeKey;
	onSelect: (type: MapTypeKey) => void;
	onMouseEnter?: () => void;
}) {
	return (
		<div className="map-type-control__basemap">
			{MAP_TYPES.map((t) => (
				<button
					key={t}
					type="button"
					className="map-type-control__button"
					data-state={selected === t ? "on" : "off"}
					onClick={() => onSelect(t)}
					onMouseEnter={onMouseEnter}
				>
					<div className="map-type-control__background">
						<img src={previewUrls[t]} alt="" draggable={false} />
					</div>
					<span>{MAP_TYPE_LABELS[t]}</span>
				</button>
			))}
		</div>
	);
}

/** Collapse to a single menu button when the expanded basemap would overlap top-right controls. */
function useMapTypeCompact(
	containerRef: RefObject<HTMLDivElement | null>,
	basemapMeasureRef: RefObject<HTMLDivElement | null>,
) {
	const [compact, setCompact] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		const measure = basemapMeasureRef.current;
		if (!el) return;
		const root = el.closest(".embed-controls");
		const leftGroup = el.closest(".embed-controls__control");
		if (!root || !leftGroup) return;

		const check = () => {
			const basemapWidth = measure?.scrollWidth ?? 0;
			if (basemapWidth === 0) return;

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

			let siblingsWidth = 0;
			for (const child of Array.from(leftGroup.children)) {
				if (child !== el && child instanceof HTMLElement) {
					siblingsWidth += child.getBoundingClientRect().width;
				}
			}

			const available = conflictLeft - leftEdge - 8;
			const needed = basemapWidth + siblingsWidth;
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
	}, [containerRef, basemapMeasureRef]);

	return compact;
}

export function MapTypeDropdown({ layerConfig }: { layerConfig: LayerConfig }) {
	const [isOpen, setIsOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const basemapMeasureRef = useRef<HTMLDivElement>(null);
	const compact = useMapTypeCompact(containerRef, basemapMeasureRef);
	const mapPreviewUrl = useMemo(() => buildTileUrl(createRoadmapTileConfig(), 0, 0, 0), []);

	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [isOpen]);

	const previewUrls: Record<MapTypeKey, string> = {
		map: mapPreviewUrl,
		satellite: MAP_TYPE_PREVIEW_STATIC.satellite!,
		osm: MAP_TYPE_PREVIEW_STATIC.osm!,
	};

	const settingsPopup = isOpen && (
		<div
			className="settings-popup"
			style={{
				position: "absolute",
				top: "100%",
				left: 0,
				zIndex: 3,
				maxHeight: "calc(100vh - 80px)",
				overflowY: "auto",
			}}
		>
			{compact && (
				<BasemapSelector
					previewUrls={previewUrls}
					selected={layerConfig.basemap}
					onSelect={(t) => layerConfig.setBasemap(t)}
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
				ref={basemapMeasureRef}
				className="map-type-control__basemap map-type-control__basemap--measure"
				aria-hidden
			>
				<BasemapSelector
					previewUrls={previewUrls}
					selected={layerConfig.basemap}
					onSelect={() => {}}
				/>
			</div>
			{compact ? (
				<>
					<button
						type="button"
						className="map-control__menu-button"
						onClick={() => setIsOpen(!isOpen)}
					>
						{MAP_TYPE_LABELS[layerConfig.basemap]}
					</button>
					{settingsPopup}
				</>
			) : (
				<>
					<BasemapSelector
						previewUrls={previewUrls}
						selected={layerConfig.basemap}
						onSelect={(t) => {
							if (layerConfig.basemap === t) {
								setIsOpen((v) => !v);
							} else {
								layerConfig.setBasemap(t);
								setIsOpen(false);
							}
						}}
						onMouseEnter={() => {
							setIsOpen(true);
						}}
					/>
					{settingsPopup}
				</>
			)}
		</div>
	);
}

export function MapSettingsDropdown({ settings: s }: { settings: MapSettingsDropdownProps }) {
	const [pointAlongRoad, setPointAlongRoad] = useMapSetting("pointAlongRoad");
	const [preferDirection, setPreferDirection] = useMapSetting("preferDirection");
	const [preferOfficial, setPreferOfficial] = useMapSetting("preferOfficial");
	const [preferHigherQuality, setPreferHigherQuality] = useMapSetting("preferHigherQuality");
	const [onlyOfficial, setOnlyOfficial] = useMapSetting("onlyOfficial");
	const [defaultPanoId, setDefaultPanoId] = useMapSetting("defaultPanoId");
	const [searchRadius, setSearchRadius] = useMapSetting("searchRadius");
	const [enrichMetadata, setEnrichMetadata] = useMapSetting("enrichMetadata");
	const [enrichFields, setEnrichFields] = useMapSetting("enrichFields");
	const [isOpen, setIsOpen] = useState(false);
	const [showManageFields, setShowManageFields] = useState(false);
	const [showEnrichFields, setShowEnrichFields] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setIsOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [isOpen]);

	return (
		<div
			className="map-control map-control--menu"
			ref={containerRef}
			style={{ position: "relative" }}
		>
			<button className="map-control__menu-button" onClick={() => setIsOpen(!isOpen)}>
				Map settings
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
							Selecting new locations <span className="fieldset__divider" />
						</legend>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={pointAlongRoad}
								onChange={(e) => setPointAlongRoad(e.target.checked)}
							/>
							Point view along the road by default
						</label>
						{pointAlongRoad && (
							<label className="settings-popup__item settings-popup__select">
								Direction:{" "}
								<NSelect
									className="nselect--compact"
									value={preferDirection ?? ""}
									onChange={(e) => setPreferDirection(e.target.value || null)}
								>
									<option value="">None</option>
									<option value="forwards">Forwards</option>
									<option value="backwards">Backwards</option>
									<option value="north">Most Northern</option>
									<option value="east">Most Eastern</option>
									<option value="south">Most Southern</option>
									<option value="west">Most Western</option>
									<option value="random">Random</option>
								</NSelect>
							</label>
						)}
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={preferOfficial}
								onChange={(e) => setPreferOfficial(e.target.checked)}
							/>
							Prefer official coverage over unofficial
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={preferHigherQuality}
								onChange={(e) => setPreferHigherQuality(e.target.checked)}
							/>
							Prefer higher quality over newer images
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={onlyOfficial}
								onChange={(e) => setOnlyOfficial(e.target.checked)}
							/>
							Disallow unofficial coverage
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={defaultPanoId}
								onChange={(e) => setDefaultPanoId(e.target.checked)}
							/>
							Use Pano ID locations by default
						</label>
						<SearchRadiusSlider value={searchRadius} onChange={setSearchRadius} />
					</fieldset>
					<fieldset className="fieldset">
						<legend className="fieldset__header">
							Map behaviour <span className="fieldset__divider" />
						</legend>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={s.showPreviews}
								onChange={(e) => s.setShowPreviews(e.target.checked)}
							/>
							Show location previews when hovering the map
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={s.selectOnly}
								onChange={(e) => s.setSelectOnly(e.target.checked)}
							/>
							Select-only mode
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={enrichMetadata}
								onChange={(e) => setEnrichMetadata(e.target.checked)}
							/>
							Enrich locations with metadata
							<EnrichInfoButton />
							<button
								className="icon-button"
								title="Configure enrichment fields"
								style={{ padding: 0, color: "#888", flexShrink: 0 }}
								onClick={(e) => {
									e.preventDefault();
									setShowEnrichFields(true);
									setIsOpen(false);
								}}
							>
								<Icon path={mdiCogOutline} size={14} />
							</button>
						</label>
					</fieldset>
					<ScoreBoundsEditor />
					<fieldset className="fieldset">
						<legend className="fieldset__header">
							Display <span className="fieldset__divider" />
						</legend>
						<label className="settings-popup__item settings-popup__select">
							Marker style:{" "}
							<NSelect
								className="nselect--compact"
								value={s.markerStyle}
								onChange={(e) => s.setMarkerStyle(e.target.value as MarkerStyle)}
							>
								<option value="pin">Pin</option>
								<option value="circle">Circle</option>
								<option value="arrow">Camera direction arrow</option>
							</NSelect>
						</label>
						<label className="settings-popup__item settings-popup__slider">
							Marker size:{" "}
							<input
								type="range"
								min={0.5}
								max={3}
								step={0.25}
								value={s.markerSize}
								onChange={(e) => s.setMarkerSize(Number(e.target.value))}
							/>
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={s.showPerfectScoreCircle}
								onChange={(e) => s.setShowPerfectScoreCircle(e.target.checked)}
							/>
							Display 5K radius
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={s.showSearchRadiusCursor}
								onChange={(e) => s.setShowSearchRadiusCursor(e.target.checked)}
							/>
							Show click search radius at cursor
						</label>
					</fieldset>
					<div className="settings-popup__footer">
						<button
							className="button"
							type="button"
							onClick={() => {
								setShowManageFields(true);
								setIsOpen(false);
							}}
						>
							Manage metadata fields
						</button>
					</div>
				</div>
			)}
			{showManageFields && <ManageFieldsModal onClose={() => setShowManageFields(false)} />}
			<Dialog open={showEnrichFields} onOpenChange={setShowEnrichFields}>
				<DialogContent title="Enrichment fields">
					<p style={{ margin: "0 0 .5rem", fontSize: ".85rem", color: "#888" }}>
						Choose which metadata fields to add when enriching locations.
					</p>
					{getEnrichFieldOptions().map((f) => {
						const enabled = enrichFields ? enrichFields.includes(f.key) : !f.defaultOff;
						return (
							<label
								key={f.key}
								className="settings-popup__item"
								style={{ display: "flex", alignItems: "center", gap: ".5rem" }}
							>
								<input
									type="checkbox"
									checked={enabled}
									onChange={(e) => {
										const defaultKeys = getDefaultEnrichKeys();
										const current = enrichFields ?? [...defaultKeys];
										const next = e.target.checked
											? [...current, f.key]
											: current.filter((k) => k !== f.key);
										const isDefault =
											next.length === defaultKeys.length &&
											next.every((k) => defaultKeys.includes(k));
										setEnrichFields(isDefault ? null : next);
									}}
								/>
								{f.label}
							</label>
						);
					})}
				</DialogContent>
			</Dialog>
		</div>
	);
}
