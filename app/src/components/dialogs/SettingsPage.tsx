import { useState, useRef, useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { DatabaseManager } from "@/components/dialogs/DatabaseManager";
import {
	getAllBindings,
	useBinding,
	getBinding,
	setBinding,
	resetBinding,
	resetAllBindings,
	reassignBinding,
	getConflicts,
	getAltSlowConflict,
	isCustomized,
	type HotkeyAction,
	type HotkeyDef,
	type HotkeyGroup,
} from "@/lib/util/hotkeys";
import { Icon } from "@/components/primitives/Icon";
import { mdiAlertCircleOutline } from "@mdi/js";
import {
	useSettings,
	useSetting,
	setSetting,
	type AppSettings,
	type MapListField,
	type BorderDetail,
	MOVEMENT_MODES,
	SEEN_RESOLUTIONS,
	EXACT_DATE_FORMATS,
	DATE_TIMEZONES,
	MAP_LIST_FIELDS,
	GEOCODE_PROVIDERS,
	TAG_VIEW_MODES,
	BORDER_DETAILS,
	PREVIEW_ASPECT_RATIOS,
} from "@/store/settings";
import { formatBinding, buildComboString } from "@/lib/hooks/useHotkey";
import { useUpdateState, checkForUpdate, installUpdate, relaunchApp } from "@/lib/util/updateCheck";
import { ColorPicker } from "@/components/primitives/ColorPicker";

function SettingSelect<K extends keyof AppSettings>({
	setting,
	options,
}: {
	setting: K;
	options: Record<AppSettings[K] & string, string>;
}) {
	const value = useSetting(setting);
	return (
		<select
			value={value as string}
			onChange={(e) => setSetting(setting, e.target.value as AppSettings[K])}
		>
			{Object.entries(options).map(([v, label]) => (
				<option key={v} value={v}>{label as string}</option>
			))}
		</select>
	);
}

const BLOCKED_COMBOS = new Set(["Mod++", "Mod+-"]);

function getBlockedReason(e: KeyboardEvent): string | null {
	const combo = buildComboString(e);
	if (!combo) return null;
	if (e.altKey) {
		const conflict = getAltSlowConflict(combo);
		if (conflict) {
			return `${formatBinding(combo)} conflicts with "${conflict.label}" (Alt is the slow modifier for navigation)`;
		}
	}
	if (BLOCKED_COMBOS.has(combo)) return "Intercepted by the app window before shortcuts can reach it";
	return null;
}

function HotkeyRow({
	action,
	label,
	flash,
	onJump,
}: {
	action: HotkeyAction;
	label: string;
	flash: boolean;
	onJump: (action: string) => void;
}) {
	const binding = useBinding(action);
	const [recording, setRecording] = useState(false);
	const [blocked, setBlocked] = useState<string | null>(null);
	const [pending, setPending] = useState<{ combo: string; conflicts: HotkeyDef[] } | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const custom = isCustomized(action);

	useEffect(() => {
		if (recording && !pending && inputRef.current) inputRef.current.focus();
	}, [recording, pending]);

	const cancel = useCallback(() => {
		setRecording(false);
		setBlocked(null);
		setPending(null);
	}, []);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === "Escape") {
				cancel();
				return;
			}

			if (e.key === "Backspace" || e.key === "Delete") {
				setBinding(action, "");
				cancel();
				return;
			}

			const reason = getBlockedReason(e.nativeEvent);
			if (reason) {
				setBlocked(reason);
				return;
			}

			const combo = buildComboString(e.nativeEvent);
			if (!combo) return;

			const collisions = getConflicts(action, combo);
			if (collisions.length > 0) {
				setBlocked(null);
				setPending({ combo, conflicts: collisions });
				return;
			}

			setBinding(action, combo);
			cancel();
		},
		[action, cancel],
	);

	const reassign = useCallback(() => {
		if (!pending) return;
		reassignBinding(action, pending.combo);
		cancel();
	}, [action, pending, cancel]);

	const conflicts = getConflicts(action, binding);
	const hasConflict = conflicts.length > 0;

	return (
		<tr
			id={`hotkey-row-${action}`}
			className={`${custom ? "hotkey-row--custom" : ""}${flash ? " hotkey-row--flash" : ""}${hasConflict ? " hotkey-row--conflict" : ""}`}
		>
			<td>{label}</td>
			<td>
				{recording ? (
					pending ? (
						<div className="hotkey-reassign" onKeyDown={(e) => e.key === "Escape" && cancel()}>
							<span className="hotkey-reassign__msg">
								<code>{formatBinding(pending.combo)}</code> is bound to{" "}
								<strong>{pending.conflicts.map((c) => c.label).join(", ")}</strong>
							</span>
							<button
								className="button button--primary hotkey-reset"
								autoFocus
								onClick={reassign}
							>
								Reassign
							</button>
							<button className="button hotkey-reset" onClick={cancel}>
								Cancel
							</button>
						</div>
					) : (
						<>
							<input
							ref={inputRef}
							className="hotkey-record"
							readOnly
							value={blocked ? "Try another key..." : "Press a key..."}
							onKeyDown={handleKeyDown}
							onBlur={() => { setRecording(false); setBlocked(null); }}
						/>
							{blocked && <span className="hotkey-blocked">{blocked}</span>}
						</>
					)
				) : (
					<code
						className={`hotkey-display${!binding ? " hotkey-display--empty" : ""}`}
						onClick={() => setRecording(true)}
						title="Click to rebind"
					>
						{binding ? formatBinding(binding) : " "}
					</code>
				)}
				{!recording &&
					conflicts.map((c) => (
						<button
							key={c.action}
							className="hotkey-conflict"
							onClick={() => onJump(c.action)}
							title={`Also bound to "${c.label}" — click to jump there`}
						>
							<Icon path={mdiAlertCircleOutline} className="hotkey-conflict__icon" />
							{c.label}
						</button>
					))}
			</td>
			<td>
				{custom && (
					<button
						className="button hotkey-reset"
						onClick={() => resetBinding(action)}
						title="Reset to default"
					>
						Reset
					</button>
				)}
			</td>
		</tr>
	);
}

const GROUPS: HotkeyGroup[] = [
	"Commands",
	"Global",
	"Map Navigation",
	"Location Editor",
	"Quicktag",
	"Review",
];

function KeyboardShortcutsSection() {
	const [filter, setFilter] = useState("");
	const [flash, setFlash] = useState<string | null>(null);
	const lower = filter.toLowerCase();
	const allBindings = getAllBindings();

	const jumpTo = useCallback((action: string) => {
		document
			.getElementById(`hotkey-row-${action}`)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		setFlash(action);
		window.setTimeout(() => setFlash((cur) => (cur === action ? null : cur)), 1500);
	}, []);

	return (
		// div, not fieldset: Chromium ignores position:sticky inside <fieldset>
		<div className="fieldset">
			<div className="fieldset__header">
				Keyboard Shortcuts <span className="fieldset__divider" />
			</div>
			<div className="settings-hotkey-filter">
				<input
					className="input"
					type="text"
					placeholder="Filter shortcuts..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					style={{ width: "100%" }}
				/>
			</div>
			{GROUPS.map((group) => {
				const defs = allBindings.filter(
					(d) => d.group === group && (!lower || d.label.toLowerCase().includes(lower) || getBinding(d.action).toLowerCase().includes(lower)),
				);
				if (defs.length === 0) return null;
				return (
					<div key={group}>
						<h3 style={{ margin: ".5rem 0 .25rem", fontSize: ".85rem", color: "#888" }}>{group}</h3>
						<table className="settings-hotkey-table">
							<thead>
								<tr>
									<th>Action</th>
									<th>Binding</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{defs.map((d) => (
									<HotkeyRow
										key={d.action}
										action={d.action}
										label={d.label}
										flash={flash === d.action}
										onJump={jumpTo}
									/>
								))}
							</tbody>
						</table>
					</div>
				);
			})}
			<div style={{ marginTop: ".5rem" }}>
				<button className="button" onClick={resetAllBindings}>
					Reset all to defaults
				</button>
			</div>
		</div>
	);
}

function StreetViewSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Street View <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showLinksControl}
					onChange={(e) => setSetting("showLinksControl", e.target.checked)}
				/>
				Show link arrows (ground navigation)
			</label>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.clickToGo}
					onChange={(e) => setSetting("clickToGo", e.target.checked)}
				/>
				Show click-to-go navigation
			</label>
			{s.clickToGo && (
				<div className="settings-popup__sub">
					<label className="settings-popup__item">
						<input
							type="checkbox"
							checked={s.showNavArrow}
							onChange={(e) => setSetting("showNavArrow", e.target.checked)}
						/>
						Show navigation X
					</label>
					<label className="settings-popup__item">
						<input
							type="checkbox"
							checked={s.showGroundArrow}
							onChange={(e) => setSetting("showGroundArrow", e.target.checked)}
						/>
						Show ground arrow
					</label>
				</div>
			)}
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showRoadLabels}
					onChange={(e) => setSetting("showRoadLabels", e.target.checked)}
				/>
				Show road labels
			</label>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showCar}
					onChange={(e) => setSetting("showCar", e.target.checked)}
				/>
				Show car
			</label>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showCrosshair}
					onChange={(e) => setSetting("showCrosshair", e.target.checked)}
				/>
				Show crosshair
			</label>
			<label className="settings-popup__item">
				Default movement mode
				<SettingSelect setting="defaultMovementMode" options={MOVEMENT_MODES} />
			</label>
			<label
				className="settings-popup__item"
				style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
			>
				Pano look speed
				<input
					type="range"
					min={1}
					max={10}
					step={1}
					value={s.panoLookSpeed}
					onChange={(e) => setSetting("panoLookSpeed", Number(e.target.value))}
					style={{ flex: 1 }}
				/>
				<span style={{ minWidth: "1.5rem", textAlign: "right", fontSize: "0.85rem" }}>
					{s.panoLookSpeed}
				</span>
			</label>
			<label className="settings-popup__item">
				Preview aspect ratio
				<SettingSelect setting="previewAspectRatio" options={PREVIEW_ASPECT_RATIOS} />
			</label>
		</fieldset>
	);
}

function ViewerControlsSection() {
	const s = useSettings();
	const controls: { key: keyof typeof s; label: string }[] = [
		{ key: "showFullscreenButton", label: "Fullscreen button" },
		{ key: "showJumpButtons", label: "Jump forward/backward buttons" },
		{ key: "showCompass", label: "Compass (wind rose)" },
		{ key: "showCompassTape", label: "Compass (heading tape)" },
		{ key: "showZoom", label: "Zoom controls" },
		{ key: "showReturnToSpawn", label: "Return to spawn button" },
		{ key: "showMapLinks", label: "Map links (open in maps, copy link)" },
		{ key: "showCoordinateDisplay", label: "Coordinate / zoom display" },
		{ key: "showPanoMetadata", label: "Show pano metadata" },
		{ key: "showFps", label: "Show FPS counter" },
	];

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Viewer Controls <span className="fieldset__divider" />
			</legend>
			{controls.map(({ key, label }) => (
				<label key={key} className="settings-popup__item">
					<input
						type="checkbox"
						checked={s[key] as boolean}
						onChange={(e) => setSetting(key, e.target.checked)}
					/>
					{label}
				</label>
			))}
		</fieldset>
	);
}

function FullscreenSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Fullscreen <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showFullscreenMinimap}
					onChange={(e) => setSetting("showFullscreenMinimap", e.target.checked)}
				/>
				Show minimap in fullscreen
			</label>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showFullscreenTagbar}
					onChange={(e) => setSetting("showFullscreenTagbar", e.target.checked)}
				/>
				Show tag bar in fullscreen
			</label>
		</fieldset>
	);
}

function DatePickerSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Date Picker <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.showCameraBadges}
					onChange={(e) => setSetting("showCameraBadges", e.target.checked)}
				/>
				Show camera type badges (Gen1, Gen2, etc.)
			</label>
			<label className="settings-popup__item">
				Exact date format
				<SettingSelect setting="exactDateFormat" options={EXACT_DATE_FORMATS} />
			</label>
			<label className="settings-popup__item">
				Exact date timezone
				<SettingSelect setting="dateTimezone" options={DATE_TIMEZONES} />
			</label>
		</fieldset>
	);
}

function SeenSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Seen <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.enableSeen}
					onChange={(e) => setSetting("enableSeen", e.target.checked)}
				/>
				Log viewed panos
			</label>
			{s.enableSeen && (
				<>
					<label className="settings-popup__item">
						<input
							type="checkbox"
							checked={s.enableSeenThumbnails}
							onChange={(e) => setSetting("enableSeenThumbnails", e.target.checked)}
						/>
						Save thumbnails
					</label>
					{s.enableSeenThumbnails && (
						<label className="settings-popup__item">
							Thumbnail resolution
							<SettingSelect setting="seenResolution" options={SEEN_RESOLUTIONS} />
						</label>
					)}
				</>
			)}
		</fieldset>
	);
}

function MapNavigationSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Map Navigation <span className="fieldset__divider" />
			</legend>
			<label
				className="settings-popup__item"
				style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
			>
				Pan speed
				<input
					type="range"
					min={1}
					max={20}
					step={1}
					value={s.mapPanSpeed}
					onChange={(e) => setSetting("mapPanSpeed", Number(e.target.value))}
					style={{ flex: 1 }}
				/>
				<span style={{ minWidth: "1.5rem", textAlign: "right", fontSize: "0.85rem" }}>
					{s.mapPanSpeed}
				</span>
			</label>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.panToImported}
					onChange={(e) => setSetting("panToImported", e.target.checked)}
				/>
				Pan to imported locations
			</label>
		</fieldset>
	);
}

function NavigationSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Navigation <span className="fieldset__divider" />
			</legend>
			<p style={{ margin: "0 0 0.25rem", fontSize: "0.85rem", color: "#888" }}>
				Hold Alt to slow down map panning and pano look.
			</p>
			<label
				className="settings-popup__item"
				style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
			>
				Alt slow-down
				<input
					type="range"
					min={2}
					max={10}
					step={1}
					value={s.slowModifier}
					onChange={(e) => setSetting("slowModifier", Number(e.target.value))}
					style={{ flex: 1 }}
				/>
				<span style={{ minWidth: "1.5rem", textAlign: "right", fontSize: "0.85rem" }}>
					{s.slowModifier}x
				</span>
			</label>
		</fieldset>
	);
}

function ActiveLocationSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Active location <span className="fieldset__divider" />
			</legend>
			<div className="settings-popup__item">
				Marker color
				<ColorPicker
					color={s.activeLocationColor}
					onChange={(color) => setSetting("activeLocationColor", color)}
					ariaLabel="Active location marker color"
				/>
			</div>
			<label className="settings-popup__item">
				<input
					type="checkbox"
					checked={s.followActiveInReview}
					onChange={(e) => setSetting("followActiveInReview", e.target.checked)}
				/>
				Center map on active location during review
			</label>
		</fieldset>
	);
}

function ImportSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Import <span className="fieldset__divider" />
			</legend>
			<div className="settings-popup__item">
				Staged marker color
				<ColorPicker
					color={s.importPreviewColor}
					onChange={(color) => setSetting("importPreviewColor", color)}
					ariaLabel="Staged import marker color"
				/>
			</div>
		</fieldset>
	);
}

function MapListSection() {
	const s = useSettings();
	const fields = s.mapListFields;

	const toggle = (field: MapListField) => {
		if (fields.includes(field)) {
			setSetting(
				"mapListFields",
				fields.filter((f) => f !== field),
			);
		} else {
			setSetting("mapListFields", [...fields, field]);
		}
	};

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Map List <span className="fieldset__divider" />
			</legend>
			<p style={{ margin: "0 0 0.25rem", fontSize: "0.85rem", color: "#888" }}>
				Fields shown on each map row (labels are always shown)
			</p>
			{Object.entries(MAP_LIST_FIELDS).map(([value, label]) => (
				<label key={value} className="settings-popup__item">
					<input
						type="checkbox"
						checked={fields.includes(value as MapListField)}
						onChange={() => toggle(value as MapListField)}
					/>
					{label}
				</label>
			))}
		</fieldset>
	);
}

function CustomCssSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Custom CSS <span className="fieldset__divider" />
			</legend>
			<textarea
				className="settings-css-editor"
				value={s.customCss}
				onChange={(e) => setSetting("customCss", e.target.value)}
				placeholder="/* Your custom CSS here */
.location-preview__panorama { border: 2px solid red; }"
				spellCheck={false}
			/>
		</fieldset>
	);
}

type SettingsTab = "controls" | "map" | "streetview" | "advanced";

const TABS: { id: SettingsTab; label: string }[] = [
	{ id: "controls", label: "Controls" },
	{ id: "map", label: "Map" },
	{ id: "streetview", label: "Street View" },
	{ id: "advanced", label: "Advanced" },
];

function ControlsTab() {
	return (
		<>
			<KeyboardShortcutsSection />
			<NavigationSection />
		</>
	);
}

function MapTab() {
	return (
		<>
			<MapNavigationSection />
			<ActiveLocationSection />
			<ImportSection />
		</>
	);
}

function GeocodingSection() {
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Geocoding <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				Provider
				<SettingSelect setting="geocodeProvider" options={GEOCODE_PROVIDERS} />
			</label>
			{s.geocodeProvider === "nominatim" && (
				<>
					<p className="settings-popup__warning">
						Without an API key, requests may be rate-limited by Nominatim's usage policy.
					</p>
					<label className="settings-popup__item">
						API key (optional)
						<input
							type="text"
							className="input"
							value={s.nominatimApiKey}
							onChange={(e) => setSetting("nominatimApiKey", e.target.value)}
							placeholder="Leave blank for keyless access"
						/>
					</label>
				</>
			)}
		</fieldset>
	);
}

function TagsSection() {
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Tags <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				View mode
				<SettingSelect setting="tagViewMode" options={TAG_VIEW_MODES} />
			</label>
		</fieldset>
	);
}

function BorderDetailSection() {
	const s = useSettings();
	const [mediumReady, setMediumReady] = useState<boolean | null>(null);
	const [heavyReady, setHeavyReady] = useState<boolean | null>(null);
	const [downloading, setDownloading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const { cmd } = await import("@/lib/commands");
			const [m, h] = await Promise.all([
				cmd.checkBorderFile("medium").catch(() => false),
				cmd.checkBorderFile("heavy").catch(() => false),
			]);
			if (!cancelled) {
				setMediumReady(m);
				setHeavyReady(h);
			}
		})();
		return () => { cancelled = true; };
	}, []);

	const handleChange = async (level: BorderDetail) => {
		setError(null);
		if (level === "light") {
			setSetting("borderDetail", level);
			return;
		}
		const isReady = level === "medium" ? mediumReady : heavyReady;
		if (isReady) {
			setSetting("borderDetail", level);
			return;
		}
		setDownloading(level);
		try {
			const { cmd } = await import("@/lib/commands");
			await cmd.downloadBorderFile(level);
			if (level === "medium") setMediumReady(true);
			else setHeavyReady(true);
			setSetting("borderDetail", level);
		} catch (e) {
			setError(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setDownloading(null);
		}
	};

	const statusLabel = (level: "medium" | "heavy") => {
		if (downloading === level) return " (downloading...)";
		const ready = level === "medium" ? mediumReady : heavyReady;
		if (ready === null) return "";
		return ready ? "" : " (will download)";
	};

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Country Select <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				Border accuracy
				<select
					value={s.borderDetail}
					onChange={(e) => handleChange(e.target.value as BorderDetail)}
					disabled={downloading !== null}
				>
					{Object.entries(BORDER_DETAILS).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
							{value !== "light" && statusLabel(value as "medium" | "heavy")}
						</option>
					))}
				</select>
			</label>
			{downloading && (
				<p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", opacity: 0.7 }}>
					Downloading border data...
				</p>
			)}
			{error && <p className="settings-popup__warning">{error}</p>}
		</fieldset>
	);
}

function StreetViewTab() {
	return (
		<>
			<StreetViewSection />
			<ViewerControlsSection />
			<FullscreenSection />
			<TagsSection />
			<DatePickerSection />
			<GeocodingSection />
			<BorderDetailSection />
		</>
	);
}

declare const __APP_VERSION__: string;

function UpdateSection() {
	const update = useUpdateState();
	const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Updates <span className="fieldset__divider" />
			</legend>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span>Current version: {version}</span>
					{(update.phase === "idle" || update.phase === "up-to-date") && (
						<button className="button" onClick={checkForUpdate}>
							{update.phase === "up-to-date" ? "Check again" : "Check for updates"}
						</button>
					)}
					{update.phase === "checking" && <span>Checking...</span>}
					{update.phase === "up-to-date" && <span>Up to date</span>}
					{update.phase === "error" && (
						<>
							<span style={{ color: "var(--color-error, #e53935)" }}>{update.error}</span>
							<button className="button" onClick={checkForUpdate}>
								Retry
							</button>
						</>
					)}
				</div>
				{update.phase === "available" && (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<span>Version {update.version} is available</span>
						{update.notes && (
							<pre style={{ maxHeight: 120, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>
								{update.notes}
							</pre>
						)}
						<button className="button button--primary" onClick={installUpdate}>
							Download and install
						</button>
					</div>
				)}
				{update.phase === "downloading" && (
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<progress value={update.percent} max={100} style={{ flex: 1 }} />
						<span>{update.percent}%</span>
					</div>
				)}
				{update.phase === "ready" && (
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<span>Update installed. Restart to apply.</span>
						<button className="button button--primary" onClick={relaunchApp}>
							Restart now
						</button>
					</div>
				)}
			</div>
		</fieldset>
	);
}

function AdvancedTab() {
	const [showDbManager, setShowDbManager] = useState(false);
	return (
		<>
			<MapListSection />
			<SeenSection />
			<CustomCssSection />
			<UpdateSection />
			<fieldset className="fieldset">
				<legend className="fieldset__header">
					Database <span className="fieldset__divider" />
				</legend>
				<div style={{ display: "flex", gap: 8 }}>
					<button className="button" onClick={() => setShowDbManager(true)}>
						Database management
					</button>
					<button
						className="button"
						onClick={async () => {
							const { cmd } = await import("@/lib/commands");
							await cmd.openDataFolder();
						}}
					>
						Open data folder
					</button>
				</div>
			</fieldset>
			<DatabaseManager open={showDbManager} onOpenChange={setShowDbManager} />
		</>
	);
}

export function SettingsPage({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [tab, setTab] = useState<SettingsTab>("controls");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="Settings" className="settings-page">
				<div className="settings-tabs">
					{TABS.map((t) => (
						<button
							key={t.id}
							className={`settings-tabs__tab${tab === t.id ? " settings-tabs__tab--active" : ""}`}
							onClick={() => setTab(t.id)}
						>
							{t.label}
						</button>
					))}
				</div>
				{tab === "controls" && <ControlsTab />}
				{tab === "map" && <MapTab />}
				{tab === "streetview" && <StreetViewTab />}
				{tab === "advanced" && <AdvancedTab />}
			</DialogContent>
		</Dialog>
	);
}
