import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { NSelect } from "@/components/primitives/NSelect";
import { Slider } from "@/components/primitives/Slider";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Button } from "@/components/primitives/Button";
import { TextInput } from "@/components/primitives/TextInput";
import {
	SettingRow,
	SettingsSearchContext,
	useSettingsSearch,
} from "@/components/primitives/SettingRow";
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
import { mdiAlertCircleOutline, mdiRefresh } from "@mdi/js";
import {
	useSettings,
	useSetting,
	setSetting,
	type AppSettings,
	type MapListField,
	type BorderDetail,
	type SubdivisionDetail,
	MOVEMENT_MODES,
	SEEN_RESOLUTIONS,
	EXACT_DATE_FORMATS,
	DATE_TIMEZONES,
	MAP_LIST_FIELDS,
	GEOCODE_PROVIDERS,
	DISCORD_PRESENCE_MODES,
	TAG_VIEW_MODES,
	TAG_FOLDER_COLOR_MODES,
	TAG_SUGGESTION_LIMITS,
	BORDER_DETAILS,
	SUBDIVISION_DETAILS,
	PREVIEW_ASPECT_RATIOS,
} from "@/store/settings";
import { formatBinding, buildComboString } from "@/lib/hooks/useHotkey";
import { cmd } from "@/lib/commands";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import type { DataLocation } from "@/bindings.gen";
import { useUpdateState, checkForUpdate, installUpdate, relaunchApp } from "@/lib/util/updateCheck";
import { ColorPicker } from "@/components/primitives/ColorPicker";

/** Non-row section content. Hidden during search unless the section title
 *  matched, or `match` (a keyword string for content with no SettingRows)
 *  contains the query. */
function Aux({ children, match }: { children: ReactNode; match?: string }) {
	const { query, auxVisible } = useSettingsSearch();
	if (!auxVisible && !(match && query && match.toLowerCase().includes(query))) return null;
	return <div className="settings-aux">{children}</div>;
}

/** A sub-group heading inside a section. Visible only when the section is fully
 *  shown (not searching, or section title matched) so search results collapse
 *  cleanly under the section breadcrumb. */
function GroupHeading({ children }: { children: ReactNode }) {
	const { auxVisible } = useSettingsSearch();
	if (!auxVisible) return null;
	return <h3 className="settings-group">{children}</h3>;
}

function SettingSlider({
	value,
	min,
	max,
	step,
	onChange,
	format,
	disabled,
}: {
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (v: number) => void;
	format?: (v: number) => string;
	disabled?: boolean;
}) {
	return (
		<>
			<Slider
				className="setting-slider"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(Number(e.target.value))}
			/>
			<span className="mono setting-slider__value">{format ? format(value) : value}</span>
		</>
	);
}

function SettingSelect<K extends keyof AppSettings>({
	setting,
	options,
}: {
	setting: K;
	options: Record<AppSettings[K] & string, string>;
}) {
	const value = useSetting(setting);
	return (
		<NSelect
			className="nselect--compact"
			value={value as string}
			onChange={(e) => setSetting(setting, e.target.value as AppSettings[K])}
		>
			{Object.entries(options).map(([v, label]) => (
				<option key={v} value={v}>
					{label as string}
				</option>
			))}
		</NSelect>
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
	if (BLOCKED_COMBOS.has(combo))
		return "Intercepted by the app window before shortcuts can reach it";
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
								<code className="mono">{formatBinding(pending.combo)}</code> is bound to{" "}
								<strong>{pending.conflicts.map((c) => c.label).join(", ")}</strong>
							</span>
							<Button variant="primary" className="hotkey-reset" autoFocus onClick={reassign}>
								Reassign
							</Button>
							<Button className="hotkey-reset" onClick={cancel}>
								Cancel
							</Button>
						</div>
					) : (
						<>
							<input
								ref={inputRef}
								className="hotkey-record"
								readOnly
								value={blocked ? "Try another key..." : "Press a key..."}
								onKeyDown={handleKeyDown}
								onBlur={() => {
									setRecording(false);
									setBlocked(null);
								}}
							/>
							{blocked && <span className="hotkey-blocked">{blocked}</span>}
						</>
					)
				) : (
					<code
						className={`hotkey-display mono${!binding ? " hotkey-display--empty" : ""}`}
						onClick={() => setRecording(true)}
						title="Click to rebind"
					>
						{binding ? formatBinding(binding) : " "}
					</code>
				)}
				{!recording &&
					conflicts.map((c) => (
						<button
							key={c.action}
							className="hotkey-conflict"
							onClick={() => onJump(c.action)}
							title={`Also bound to "${c.label}" - click to jump there`}
						>
							<Icon path={mdiAlertCircleOutline} className="hotkey-conflict__icon" />
							{c.label}
						</button>
					))}
			</td>
			<td>
				{custom && (
					<Button
						className="hotkey-reset"
						onClick={() => resetBinding(action)}
						title="Reset to default"
					>
						Reset
					</Button>
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

function KeyboardBody() {
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
		<Aux>
			<div className="settings-hotkey-filter">
				<TextInput
					type="text"
					placeholder="Filter shortcuts..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					style={{ width: "100%" }}
				/>
			</div>
			{GROUPS.map((group) => {
				const defs = allBindings.filter(
					(d) =>
						d.group === group &&
						(!lower ||
							d.label.toLowerCase().includes(lower) ||
							getBinding(d.action).toLowerCase().includes(lower)),
				);
				if (defs.length === 0) return null;
				return (
					<div key={group}>
						<h3 className="settings-group">{group}</h3>
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
				<Button onClick={resetAllBindings}>Reset all to defaults</Button>
			</div>
		</Aux>
	);
}

function StreetViewBody() {
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
	];

	return (
		<>
			<GroupHeading>Navigation</GroupHeading>
			<SettingRow
				checked={s.showLinksControl}
				onChange={(v) => setSetting("showLinksControl", v)}
				label="Show link arrows (ground navigation)"
			/>
			<SettingRow
				checked={s.clickToGo}
				onChange={(v) => setSetting("clickToGo", v)}
				label="Show click-to-go navigation"
			/>
			{s.clickToGo && (
				<>
					<SettingRow
						sub
						checked={s.showNavArrow}
						onChange={(v) => setSetting("showNavArrow", v)}
						label="Show navigation X"
					/>
					<SettingRow
						sub
						checked={s.showGroundArrow}
						onChange={(v) => setSetting("showGroundArrow", v)}
						label="Show ground arrow"
					/>
				</>
			)}
			<SettingRow
				checked={s.showRoadLabels}
				onChange={(v) => setSetting("showRoadLabels", v)}
				label="Show road labels"
			/>
			<SettingRow checked={s.showCar} onChange={(v) => setSetting("showCar", v)} label="Show car" />
			<SettingRow
				checked={s.showCrosshair}
				onChange={(v) => setSetting("showCrosshair", v)}
				label="Show crosshair"
			/>
			<SettingRow
				label="Default movement mode"
				control={<SettingSelect setting="defaultMovementMode" options={MOVEMENT_MODES} />}
			/>
			<SettingRow
				label="Pano look speed"
				control={
					<SettingSlider
						value={s.panoLookSpeed}
						min={1}
						max={10}
						step={1}
						onChange={(v) => setSetting("panoLookSpeed", v)}
					/>
				}
			/>
			<SettingRow
				label="Preview aspect ratio"
				control={<SettingSelect setting="previewAspectRatio" options={PREVIEW_ASPECT_RATIOS} />}
			/>

			<GroupHeading>Viewer controls</GroupHeading>
			{controls.map(({ key, label }) => (
				<SettingRow
					key={key}
					checked={s[key] as boolean}
					onChange={(v) => setSetting(key, v)}
					label={label}
				/>
			))}

			<GroupHeading>Fullscreen</GroupHeading>
			<SettingRow
				checked={s.showFullscreenMinimap}
				onChange={(v) => setSetting("showFullscreenMinimap", v)}
				label="Show minimap in fullscreen"
			/>
			<SettingRow
				checked={s.showFullscreenTagbar}
				onChange={(v) => setSetting("showFullscreenTagbar", v)}
				label="Show tag bar in fullscreen"
			/>
			<SettingRow
				checked={s.showFullscreenDatePicker}
				onChange={(v) => setSetting("showFullscreenDatePicker", v)}
				label="Show date picker in fullscreen"
			/>

			<GroupHeading>Date picker</GroupHeading>
			<SettingRow
				checked={s.showCameraBadges}
				onChange={(v) => setSetting("showCameraBadges", v)}
				label="Show camera type badges (Gen1, Gen2, etc.)"
			/>
			<SettingRow
				label="Exact date format"
				control={<SettingSelect setting="exactDateFormat" options={EXACT_DATE_FORMATS} />}
			/>
			<SettingRow
				label="Exact date timezone"
				control={<SettingSelect setting="dateTimezone" options={DATE_TIMEZONES} />}
			/>
		</>
	);
}

function MarkersBody() {
	const s = useSettings();
	return (
		<>
			<GroupHeading>Fullscreen</GroupHeading>
			<SettingRow
				checked={s.showFullscreenMapMeta}
				onChange={(v) => setSetting("showFullscreenMapMeta", v)}
				label="Show map meta bar in fullscreen"
			/>
			<SettingRow
				checked={s.showFullscreenMiniLocationPreview}
				onChange={(v) => setSetting("showFullscreenMiniLocationPreview", v)}
				label="Show mini location preview in fullscreen"
			/>

			<GroupHeading>Navigation</GroupHeading>
			<SettingRow
				label="Pan speed"
				control={
					<SettingSlider
						value={s.mapPanSpeed}
						min={1}
						max={20}
						step={1}
						onChange={(v) => setSetting("mapPanSpeed", v)}
					/>
				}
			/>
			<SettingRow
				checked={s.panToImported}
				onChange={(v) => setSetting("panToImported", v)}
				label="Pan to imported locations"
			/>
			<SettingRow
				sub
				disabled={!s.panToImported}
				label="Paste zoom padding"
				control={
					<SettingSlider
						value={s.pastePadding}
						min={0.001}
						max={0.05}
						step={0.001}
						disabled={!s.panToImported}
						onChange={(v) => setSetting("pastePadding", v)}
						format={(v) => `${v.toFixed(3)}°`}
					/>
				}
			/>
			<SettingRow
				label="Alt slow-down"
				description="Hold Alt to slow down map panning and pano look."
				control={
					<SettingSlider
						value={s.slowModifier}
						min={2}
						max={10}
						step={1}
						onChange={(v) => setSetting("slowModifier", v)}
						format={(v) => `${v}x`}
					/>
				}
			/>

			<GroupHeading>Markers</GroupHeading>
			<SettingRow
				label="Default marker color"
				control={
					<ColorPicker
						color={s.markerColor}
						onChange={(color) => setSetting("markerColor", color)}
						ariaLabel="Default marker color"
					/>
				}
			/>
			<SettingRow
				label="Active marker color"
				control={
					<ColorPicker
						color={s.activeLocationColor}
						onChange={(color) => setSetting("activeLocationColor", color)}
						ariaLabel="Active location marker color"
					/>
				}
			/>
			<SettingRow
				label="Staged marker color"
				control={
					<ColorPicker
						color={s.importPreviewColor}
						onChange={(color) => setSetting("importPreviewColor", color)}
						ariaLabel="Staged import marker color"
					/>
				}
			/>
			<SettingRow
				checked={s.followActiveInReview}
				onChange={(v) => setSetting("followActiveInReview", v)}
				label="Center map on active location during review"
			/>

			<GroupHeading>Panorama dots</GroupHeading>
			<SettingRow
				label="Dot color"
				control={
					<ColorPicker
						color={s.panoDotColor}
						onChange={(color) => setSetting("panoDotColor", color)}
						ariaLabel="Panorama dot color"
					/>
				}
			/>
			<SettingRow
				label="Dot size"
				control={
					<NSelect
						value={s.panoDotScaled ? "scaled" : "constant"}
						onChange={(e) => setSetting("panoDotScaled", e.target.value === "scaled")}
					>
						<option value="constant">Constant on screen</option>
						<option value="scaled">Grow when zoomed in</option>
					</NSelect>
				}
			/>

			<BorderDetailGroup />
		</>
	);
}

function BorderDetailGroup() {
	const s = useSettings();
	const [mediumReady, setMediumReady] = useState<boolean | null>(null);
	const [heavyReady, setHeavyReady] = useState<boolean | null>(null);
	const [adm1Ready, setAdm1Ready] = useState<boolean | null>(null);
	const [downloading, setDownloading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const [m, h, a] = await Promise.all([
				cmd.checkBorderFile("medium").catch(() => false),
				cmd.checkBorderFile("heavy").catch(() => false),
				cmd.checkBorderFile("adm1").catch(() => false),
			]);
			if (!cancelled) {
				setMediumReady(m);
				setHeavyReady(h);
				setAdm1Ready(a);
			}
		})();
		return () => {
			cancelled = true;
		};
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

	const handleSubdivisionChange = async (level: SubdivisionDetail) => {
		setError(null);
		if (level === "off" || adm1Ready) {
			setSetting("subdivisionDetail", level);
			return;
		}
		setDownloading(level);
		try {
			await cmd.downloadBorderFile(level);
			setAdm1Ready(true);
			setSetting("subdivisionDetail", level);
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

	const subdivisionStatus = () => {
		if (downloading === "adm1") return " (downloading...)";
		if (adm1Ready === null) return "";
		return adm1Ready ? "" : " (~45MB, will download)";
	};

	return (
		<>
			<GroupHeading>Borders</GroupHeading>
			<SettingRow
				label="Country data"
				control={
					<NSelect
						className="nselect--compact"
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
					</NSelect>
				}
			/>
			<SettingRow
				label="Subdivision data"
				control={
					<NSelect
						className="nselect--compact"
						value={s.subdivisionDetail}
						onChange={(e) => handleSubdivisionChange(e.target.value as SubdivisionDetail)}
						disabled={downloading !== null}
					>
						{Object.entries(SUBDIVISION_DETAILS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
								{value !== "off" && subdivisionStatus()}
							</option>
						))}
					</NSelect>
				}
			/>
			{(downloading || error) && (
				<Aux>
					{downloading && (
						<p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", opacity: 0.7 }}>
							Downloading border data...
						</p>
					)}
					{error && <p className="settings-popup__warning">{error}</p>}
				</Aux>
			)}
		</>
	);
}

function EditingBody() {
	const s = useSettings();
	const limitIndex = Math.max(
		0,
		(TAG_SUGGESTION_LIMITS as readonly number[]).indexOf(s.tagSuggestionLimit),
	);
	return (
		<>
			<GroupHeading>Tags</GroupHeading>
			<SettingRow
				label="View mode"
				control={<SettingSelect setting="tagViewMode" options={TAG_VIEW_MODES} />}
			/>
			{s.tagViewMode === "tree" && (
				<>
					<SettingRow
						sub
						label="Folder color"
						control={
							<span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
								<SettingSelect setting="tagFolderColorMode" options={TAG_FOLDER_COLOR_MODES} />
								{s.tagFolderColorMode === "direct" && (
									<ColorPicker
										color={s.tagFolderColor}
										onChange={(color) => setSetting("tagFolderColor", color)}
										ariaLabel="Default folder color"
									/>
								)}
							</span>
						}
					/>
					<SettingRow
						sub
						checked={s.truncateTagPaths}
						onChange={(v) => setSetting("truncateTagPaths", v)}
						label="Truncate tag names to shortest unique path"
					/>
				</>
			)}
			<SettingRow
				checked={s.animateTagReorder}
				onChange={(v) => setSetting("animateTagReorder", v)}
				label="Animate tags during drag reorder"
			/>
			<SettingRow
				label="Tag gap"
				control={
					<SettingSlider
						value={s.tagGap}
						min={0}
						max={16}
						step={1}
						onChange={(v) => setSetting("tagGap", v)}
						format={(v) => `${v}px`}
					/>
				}
			/>
			<SettingRow
				label="Suggestions shown"
				control={
					<SettingSlider
						value={limitIndex}
						min={0}
						max={TAG_SUGGESTION_LIMITS.length - 1}
						step={1}
						onChange={(v) => setSetting("tagSuggestionLimit", TAG_SUGGESTION_LIMITS[v])}
						format={() => (s.tagSuggestionLimit === 0 ? "All" : String(s.tagSuggestionLimit))}
					/>
				}
			/>

			<GroupHeading>Seen</GroupHeading>
			<SettingRow
				checked={s.enableSeen}
				onChange={(v) => setSetting("enableSeen", v)}
				label="Log viewed panos"
			/>
			{s.enableSeen && (
				<>
					<SettingRow
						sub
						checked={s.enableSeenThumbnails}
						onChange={(v) => setSetting("enableSeenThumbnails", v)}
						label="Save thumbnails"
					/>
					{s.enableSeenThumbnails && (
						<SettingRow
							sub
							label="Thumbnail resolution"
							control={<SettingSelect setting="seenResolution" options={SEEN_RESOLUTIONS} />}
						/>
					)}
				</>
			)}

			<GroupHeading>Geocoding</GroupHeading>
			<SettingRow
				label="Provider"
				control={<SettingSelect setting="geocodeProvider" options={GEOCODE_PROVIDERS} />}
			/>
			{s.geocodeProvider === "nominatim" && (
				<>
					<Aux>
						<p className="settings-popup__warning">
							Without an API key, requests may be rate-limited by Nominatim's usage policy.
						</p>
					</Aux>
					<SettingRow
						sub
						label="API key (optional)"
						control={
							<TextInput
								type="text"
								value={s.nominatimApiKey}
								onChange={(e) => setSetting("nominatimApiKey", e.target.value)}
							/>
						}
					/>
				</>
			)}
		</>
	);
}

function MapListBlock() {
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
		<Aux match="map list fields columns row">
			<p className="text-muted" style={{ margin: "0.25rem 0", fontSize: "0.85rem" }}>
				Fields shown on each map row (labels are always shown)
			</p>
			{Object.entries(MAP_LIST_FIELDS).map(([value, label]) => (
				<label key={value} className="settings-checkbox-item">
					<Checkbox
						checked={fields.includes(value as MapListField)}
						onChange={() => toggle(value as MapListField)}
					/>
					{label}
				</label>
			))}
		</Aux>
	);
}

declare const __APP_VERSION__: string;

const UPDATE_STATUS: Record<string, string> = {
	idle: "Updates haven't been checked yet.",
	checking: "Checking for updates...",
	"up-to-date": "You're on the latest version.",
	downloading: "Downloading update...",
	ready: "Update installed. Restart to apply.",
};

function UpdateBlock() {
	const update = useUpdateState();
	const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
	const checking = update.phase === "checking";
	const badgeMod = update.phase === "up-to-date" ? " settings-updates__version--latest" : "";
	const status =
		update.phase === "available"
			? `Version ${update.version} is available.`
			: update.phase === "error"
				? (update.error ?? "Update check failed.")
				: UPDATE_STATUS[update.phase];

	return (
		<Aux match="update version check release restart install">
			<div className="settings-aux__col">
				<div className="settings-aux__row">
					<span
						className={`settings-updates__version${badgeMod}`}
						title={status}
						aria-label={status}
					>
						v{version}
					</span>
					<button
						className="icon-button settings-updates__check"
						onClick={checkForUpdate}
						disabled={checking || update.phase === "downloading"}
						title="Check for updates"
						aria-label="Check for updates"
					>
						<Icon
							path={mdiRefresh}
							size={18}
							className={checking ? "settings-updates__spin" : undefined}
						/>
					</button>
					{(update.phase === "error" || update.phase === "up-to-date") && (
						<span className="text-muted" style={{ fontSize: "0.8rem" }}>
							{status}
						</span>
					)}
				</div>
				{update.phase === "available" && (
					<div className="settings-aux__col">
						<span>Version {update.version} is available</span>
						{update.notes && (
							<pre
								style={{
									maxHeight: 120,
									overflow: "auto",
									fontSize: 12,
									whiteSpace: "pre-wrap",
									margin: 0,
								}}
							>
								{update.notes}
							</pre>
						)}
						<Button variant="primary" onClick={installUpdate}>
							Download and install
						</Button>
					</div>
				)}
				{update.phase === "downloading" && (
					<div className="settings-aux__row">
						<progress value={update.percent} max={100} style={{ flex: 1 }} />
						<span>{update.percent}%</span>
					</div>
				)}
				{update.phase === "ready" && (
					<div className="settings-aux__row">
						<span>Update installed. Restart to apply.</span>
						<Button variant="primary" onClick={relaunchApp}>
							Restart now
						</Button>
					</div>
				)}
			</div>
		</Aux>
	);
}

function ApplicationBody() {
	const restoreSession = useSetting("restoreSession");
	return (
		<>
			<GroupHeading>Startup</GroupHeading>
			<SettingRow
				checked={restoreSession}
				onChange={(v) => setSetting("restoreSession", v)}
				label="Restore open maps on startup"
			/>

			<GroupHeading>Map list</GroupHeading>
			<MapListBlock />

			<GroupHeading>Updates</GroupHeading>
			<UpdateBlock />

			<GroupHeading>Data</GroupHeading>
			<DataBody />
		</>
	);
}

function CustomCssBlock() {
	const s = useSettings();
	return (
		<Aux match="custom css stylesheet style theme">
			<textarea
				className="settings-css-editor"
				value={s.customCss}
				onChange={(e) => setSetting("customCss", e.target.value)}
				placeholder="/* Your custom CSS here */
.location-preview__panorama { border: 2px solid red; }"
				spellCheck={false}
			/>
		</Aux>
	);
}

function generateApiKey(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function IntegrationsBody() {
	const enabled = useSetting("remoteApi");
	const key = useSetting("remoteApiKey");
	return (
		<>
			<GroupHeading>Discord</GroupHeading>
			<SettingRow
				label="Rich Presence"
				control={<SettingSelect setting="discordPresence" options={DISCORD_PRESENCE_MODES} />}
			/>

			<GroupHeading>Remote API</GroupHeading>
			<SettingRow
				checked={enabled}
				onChange={(v) => {
					if (v && !key) setSetting("remoteApiKey", generateApiKey());
					setSetting("remoteApi", v);
				}}
				label="Enable local REST API"
			/>
			{enabled && (
				<Aux match="api key regenerate remote token">
					<div className="settings-aux__row">
						<TextInput
							type="text"
							readOnly
							className="mono"
							value={key}
							style={{ flex: 1 }}
							onFocus={(e) => e.target.select()}
						/>
						<Button onClick={() => setSetting("remoteApiKey", generateApiKey())}>Regenerate</Button>
					</div>
				</Aux>
			)}
		</>
	);
}

function DataBody() {
	const [loc, setLoc] = useState<DataLocation | null>(null);
	// undefined = no dialog; string = chosen folder; null = reset to default.
	const [pending, setPending] = useState<string | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		cmd
			.getDataLocation()
			.then(setLoc)
			.catch(() => {});
	}, []);

	const pick = useCallback(async () => {
		const picked = await openDialog({ directory: true, title: "Choose data folder" });
		if (typeof picked === "string") setPending(picked);
	}, []);

	const apply = useCallback(async () => {
		setBusy(true);
		try {
			await cmd.setDataLocation(pending ?? null);
			await relaunchApp();
		} catch (e) {
			log.error("data folder relaunch failed", e);
			toast("Couldn't relaunch automatically -- restart the app to apply.");
			setBusy(false);
		}
	}, [pending]);

	const target = pending ?? loc?.default_path ?? "";

	return (
		<Aux match="data location folder storage">
			<code style={{ display: "block", wordBreak: "break-all", marginBottom: 8 }}>
				{loc?.path ?? "..."}
			</code>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
				<Button onClick={pick}>Change folder...</Button>
				<Button onClick={() => cmd.openDataFolder()}>Open data folder</Button>
				{loc?.is_custom && <Button onClick={() => setPending(null)}>Reset to default</Button>}
			</div>

			<Dialog open={pending !== undefined} onOpenChange={(o) => !o && setPending(undefined)}>
				<DialogContent title="Change data folder">
					<p>Map data will be stored in:</p>
					<code style={{ display: "block", wordBreak: "break-all", margin: "8px 0" }}>
						{target}
					</code>
					<p className="text-muted">
						Existing maps are not moved automatically. Copy them from the current folder if you want
						to keep them. The app must relaunch to apply.
					</p>
					<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
						<Button onClick={() => setPending(undefined)} disabled={busy}>
							Cancel
						</Button>
						<Button variant="primary" onClick={apply} disabled={busy}>
							Relaunch now
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</Aux>
	);
}

function AdvancedBody() {
	const showFps = useSetting("showFps");
	return (
		<>
			<GroupHeading>Custom CSS</GroupHeading>
			<CustomCssBlock />

			<GroupHeading>Debug</GroupHeading>
			<SettingRow
				checked={showFps}
				onChange={(v) => setSetting("showFps", v)}
				label="Show FPS counter"
			/>
			<Aux match="log file logs diagnostics">
				<div style={{ display: "flex", gap: 8 }}>
					<Button onClick={() => cmd.openLogFile()}>Open log file</Button>
				</div>
			</Aux>
		</>
	);
}

type Section = {
	id: string;
	title: string;
	Body: () => ReactNode;
};

const SECTIONS: Section[] = [
	{ id: "keyboard", title: "Keyboard", Body: KeyboardBody },
	{ id: "streetview", title: "Street View", Body: StreetViewBody },
	{ id: "map", title: "Map", Body: MarkersBody },
	{ id: "editing", title: "Editing", Body: EditingBody },
	{ id: "application", title: "Application", Body: ApplicationBody },
	{ id: "integrations", title: "Integrations", Body: IntegrationsBody },
	{ id: "advanced", title: "Advanced", Body: AdvancedBody },
];

function SectionShell({
	section,
	mode,
	query,
	hidden,
}: {
	section: Section;
	mode: "single" | "search";
	query: string;
	hidden?: boolean;
}) {
	const sectionMatched =
		mode === "single" || query === "" || section.title.toLowerCase().includes(query);
	const Body = section.Body;
	return (
		<SettingsSearchContext.Provider value={{ query, searching: mode === "search", sectionMatched }}>
			<section
				className={`settings-section${mode === "search" ? " settings-section--search" : ""}`}
				data-qa={`settings-section-${section.id}`}
				style={hidden ? { display: "none" } : undefined}
			>
				<div className="settings-section__head">
					<h2 className="settings-section__title">{section.title}</h2>
				</div>
				<Body />
			</section>
		</SettingsSearchContext.Provider>
	);
}

export function SettingsPage({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [selected, setSelected] = useState<string>(SECTIONS[0].id);
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const searching = q !== "";

	useEffect(() => {
		if (open) setQuery("");
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent title="Settings" className="settings-page">
				<nav className="settings-rail">
					<TextInput
						type="text"
						className="settings-rail__search"
						placeholder="Search settings..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape" && query) {
								e.stopPropagation();
								setQuery("");
							}
						}}
					/>
					<div className="settings-nav-list">
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								data-qa={`settings-nav-${s.id}`}
								className={`settings-nav-item${!searching && s.id === selected ? " settings-nav-item--active" : ""}`}
								onClick={() => {
									setSelected(s.id);
									setQuery("");
								}}
							>
								{s.title}
							</button>
						))}
					</div>
				</nav>
				<div className={`settings-content${searching ? " settings-content--search" : ""}`}>
					{/* All sections stay mounted so search-mode transitions and section
					    switches never reset body state (hotkey recording, IPC-backed status). */}
					{SECTIONS.map((s) => (
						<SectionShell
							key={s.id}
							section={s}
							mode={searching ? "search" : "single"}
							query={searching ? q : ""}
							hidden={!searching && s.id !== selected}
						/>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
