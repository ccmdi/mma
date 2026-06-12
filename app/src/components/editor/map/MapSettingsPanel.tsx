import { useState, useEffect, useRef } from "react";
import { ManageFieldsModal } from "@/components/dialogs/ManageFieldsModal";
import { getEnrichFieldOptions, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import type { MapStyle } from "@/lib/geo/tiles";
import { EnrichInfoButton } from "@/components/editor/map/EnrichInfoButton";
import { Icon } from "@/components/primitives/Icon";
import { mdiCogOutline } from "@mdi/js";
import { type SvColor, SV_COLORS, type MapTypeKey } from "./mapSettingsTypes";
import { useMapSetting } from "./useMapSetting";
import { ScoreBoundsEditor } from "./ScoreBoundsEditor";

const MAP_TYPE_LABELS: Record<MapTypeKey, string> = {
	map: "Map",
	satellite: "Satellite",
	osm: "OSM",
};

export type SvCoverageType = "official" | "unofficial" | "default";
export type SvThickness = "default" | "high";

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

export type MarkerStyle = "pin" | "circle" | "arrow";

/** App-level (localStorage) prefs the panel renders. Per-map settings are read
 *  directly via `useMapSetting`, not passed in. */
export interface MapSettingsDropdownProps {
	markerStyle: MarkerStyle;
	setMarkerStyle: (v: MarkerStyle) => void;
	showPerfectScoreCircle: boolean;
	setShowPerfectScoreCircle: (v: boolean) => void;
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
				<label className="layer-config__item">
					<input
						type="radio"
						name="mapstyle"
						checked={e.mapStyleName === "default"}
						onChange={() => e.setMapStyleName("default")}
					/>
					Default
				</label>
				<label className="layer-config__item">
					<input
						type="radio"
						name="mapstyle"
						checked={e.mapStyleName === "darkMode"}
						onChange={() => e.setMapStyleName("darkMode")}
					/>
					Dark mode
				</label>
				<label className="layer-config__item">
					<input
						type="radio"
						name="mapstyle"
						checked={e.mapStyleName === "legacy"}
						onChange={() => e.setMapStyleName("legacy")}
					/>
					Legacy
				</label>
				{e.customStyles.map((s) => (
					<label key={s.name} className="layer-config__item">
						<input
							type="radio"
							name="mapstyle"
							checked={e.mapStyleName === s.name}
							onChange={() => e.setMapStyleName(s.name)}
						/>
						{s.name}
					</label>
				))}
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

export function MapTypeDropdown({ layerConfig }: { layerConfig: LayerConfig }) {
	const [isOpen, setIsOpen] = useState(false);
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
			className="map-control map-type-control"
			ref={containerRef}
			style={{ position: "relative" }}
		>
			<button className="map-control__menu-button" onClick={() => setIsOpen(!isOpen)}>
				{MAP_TYPE_LABELS[layerConfig.basemap]}
			</button>
			{isOpen && (
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
					<div className="map-type-control__basemap">
						{(["map", "satellite", "osm"] as MapTypeKey[]).map((t) => (
							<button
								key={t}
								className="map-type-control__button"
								data-state={layerConfig.basemap === t ? "on" : "off"}
								onClick={() => layerConfig.setBasemap(t)}
							>
								<span>{MAP_TYPE_LABELS[t]}</span>
							</button>
						))}
					</div>
					<SettingsPopup layerConfig={layerConfig} />
				</div>
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
	const [generatedLocationTag, setGeneratedLocationTag] = useMapSetting("generatedLocationTag");
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
								<select
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
								</select>
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
							Generation <span className="fieldset__divider" />
						</legend>
						<label className="settings-popup__item settings-popup__select">
							Tag generated locations:
							<input
								className="input"
								type="text"
								value={generatedLocationTag ?? ""}
								onChange={(e) => setGeneratedLocationTag(e.target.value || null)}
								placeholder="None"
							/>
						</label>
					</fieldset>
					<fieldset className="fieldset">
						<legend className="fieldset__header">
							Display <span className="fieldset__divider" />
						</legend>
						<label className="settings-popup__item settings-popup__select">
							Marker style:{" "}
							<select
								value={s.markerStyle}
								onChange={(e) => s.setMarkerStyle(e.target.value as MarkerStyle)}
							>
								<option value="pin">Pin</option>
								<option value="circle">Circle</option>
								<option value="arrow">Camera direction arrow</option>
							</select>
						</label>
						<label className="settings-popup__item">
							<input
								type="checkbox"
								checked={s.showPerfectScoreCircle}
								onChange={(e) => s.setShowPerfectScoreCircle(e.target.checked)}
							/>
							Display 5K radius
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
