import {
	useState,
	useRef,
	useEffect,
	useCallback,
	type ComponentProps,
	type ReactNode,
} from "react";
import {
	ConfirmDialog,
	Dialog,
	DialogContent,
	type DialogProps,
} from "@/components/primitives/Dialog";
import { Hint, Notice } from "@/components/primitives/Hint";
import { Spinner } from "@/components/primitives/Spinner";
import { NSelect } from "@/components/primitives/NSelect";
import { Slider } from "@/components/primitives/Slider";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Button } from "@/components/primitives/Button";
import { Bar } from "@/components/primitives/Bar";
import { TextInput } from "@/components/primitives/TextInput";
import {
	SettingRow,
	SettingsGroup,
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
	hotkeyLabel,
	isCustomized,
	type HotkeyAction,
	type HotkeyDef,
	type HotkeyGroup,
} from "@/lib/util/hotkeys";
import { formatBytes } from "@/lib/util/format";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { DeviceCodeInfo, GhUser } from "@/bindings.gen";
import { collectDiagnostics } from "@/lib/diagnostics";
import { appVersion } from "@/lib/version";
import { refreshStoredReports } from "@/lib/feedback/submit";
import { markRepliesSeen, reportStatus, unreadReplyCount, useReports } from "@/store/feedback";
import { openDialog as openAppDialog } from "@/store/dialogBus";
import {
	mdiAlertCircleOutline,
	mdiApplicationOutline,
	mdiFlaskOutline,
	mdiGoogleStreetView,
	mdiKeyboardOutline,
	mdiMapOutline,
	mdiMessageAlertOutline,
	mdiPencilOutline,
	mdiPuzzleOutline,
	mdiRefresh,
	mdiWrenchOutline,
} from "@mdi/js";
import {
	useSettings,
	useSetting,
	setSetting,
	type AppSettings,
	type MapListField,
	type BorderDetail,
	type SubdivisionDetail,
	type Language,
	UNIT_SYSTEMS,
	LANGUAGES,
	MOVEMENT_MODES,
	SEEN_RESOLUTIONS,
	EXACT_DATE_FORMATS,
	DATE_TIMEZONES,
	MAP_LIST_FIELDS,
	GEOCODE_PROVIDERS,
	DISCORD_PRESENCE_MODES,
	TAG_VIEW_MODES,
	TAG_FOLDER_COLOR_MODES,
	POLYGON_COLOR_MODES,
	OPACITY_TOGGLE_MODES,
	TAG_SUGGESTION_LIMITS,
	BORDER_ARCHIVE_BYTES,
	BORDER_DETAILS,
	SUBDIVISION_DETAILS,
	PREVIEW_ASPECT_RATIOS,
	resetSettings,
} from "@/store/settings";
import { formatBinding, buildComboString } from "@/lib/hooks/useHotkey";
import { cmd } from "@/lib/commands";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import { useAsync } from "@/lib/hooks/useAsync";
import {
	useUpdateState,
	checkForUpdate,
	describeUpdate,
	relaunchApp,
} from "@/lib/util/updateCheck";
import { Markdown } from "@/lib/util/markdown";
import { Pill } from "@/components/primitives/Pill";
import { PrereleasePill } from "@/components/primitives/PrereleasePill";
import { ColorPicker } from "@/components/primitives/ColorPicker";
import type { RGB } from "@/lib/util/color";
import { t, msg } from "@/lib/i18n";
import { isPrereleaseVersion } from "@/lib/util/util";
import { errText } from "@/lib/util/format";
import { matches } from "@/lib/search";
import { Trans } from "@/components/primitives/Trans";
import { IconButton } from "@/components/primitives/IconButton";
import { Kbd } from "@/components/primitives/Kbd";
import { SearchInput } from "@/components/primitives/SearchInput";

/** The translated labels of a select's options, so a search for a value ("tree") finds
 *  the row that offers it. */
const optionLabels = (options: Record<string, string>) => Object.values(options).map((m) => t(m));

/** Non-row section content. Hidden during search unless the section title
 *  matched, or `match` (a keyword string for content with no SettingRows)
 *  contains the query. */
function Aux({ children, match }: { children: ReactNode; match?: string }) {
	const { query, auxVisible } = useSettingsSearch();
	if (!auxVisible && !(match && query && matches(query, match))) return null;
	return <div className="settings-aux">{children}</div>;
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
			compact
			value={value as string}
			onChange={(e) => setSetting(setting, e.target.value as AppSettings[K])}
		>
			{Object.entries(options).map(([v, label]) => (
				<option key={v} value={v}>
					{t(label as string)}
				</option>
			))}
		</NSelect>
	);
}

type SettingOfType<T> = {
	[K in keyof AppSettings]: AppSettings[K] extends T ? K : never;
}[keyof AppSettings];

function SettingSlider({
	setting,
	...props
}: { setting: SettingOfType<number> } & Omit<ComponentProps<typeof Slider>, "value" | "onChange">) {
	const value = useSetting(setting);
	return (
		<Slider
			{...props}
			value={value}
			onChange={(e) => setSetting(setting, Number(e.target.value))}
		/>
	);
}

function SettingColor({ setting, ariaLabel }: { setting: SettingOfType<RGB>; ariaLabel: string }) {
	const color = useSetting(setting);
	return (
		<ColorPicker color={color} onChange={(c) => setSetting(setting, c)} ariaLabel={ariaLabel} />
	);
}

const BLOCKED_COMBOS = new Set(["Mod++", "Mod+-"]);

function getBlockedReason(e: KeyboardEvent): string | null {
	const combo = buildComboString(e);
	if (!combo) return null;
	if (e.altKey) {
		const conflict = getAltSlowConflict(combo);
		if (conflict) {
			return t('{combo} conflicts with "{label}" (Alt is the slow modifier for navigation)', {
				combo: formatBinding(combo),
				label: hotkeyLabel(conflict),
			});
		}
	}
	if (BLOCKED_COMBOS.has(combo))
		return t("Intercepted by the app window before shortcuts can reach it");
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
								<Trans
									msg="{combo} is bound to {labels}"
									combo={<Kbd binding={pending.combo} />}
									labels={<strong>{pending.conflicts.map(hotkeyLabel).join(", ")}</strong>}
								/>
							</span>
							<Button variant="primary" className="hotkey-reset" autoFocus onClick={reassign}>
								{t("Reassign")}
							</Button>
							<Button className="hotkey-reset" onClick={cancel}>
								{t("Cancel")}
							</Button>
						</div>
					) : (
						<>
							<input
								ref={inputRef}
								className="hotkey-record"
								readOnly
								value={blocked ? t("Try another key...") : t("Press a key...")}
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
					<span
						className={`hotkey-display${!binding ? " hotkey-display--empty" : ""}`}
						onClick={() => setRecording(true)}
						title={t("Click to rebind")}
					>
						{binding && <Kbd binding={binding} />}
					</span>
				)}
				{!recording &&
					conflicts.map((c) => (
						<button
							key={c.action}
							className="hotkey-conflict"
							onClick={() => onJump(c.action)}
							title={t('Also bound to "{label}" - click to jump there', { label: hotkeyLabel(c) })}
						>
							<Pill tone="destructive">
								<Icon path={mdiAlertCircleOutline} className="hotkey-conflict__icon" />
								{hotkeyLabel(c)}
							</Pill>
						</button>
					))}
			</td>
			<td>
				{custom && (
					<Button
						className="hotkey-reset"
						onClick={() => resetBinding(action)}
						title={t("Reset to default")}
					>
						{t("Reset")}
					</Button>
				)}
			</td>
		</tr>
	);
}

const GROUPS: HotkeyGroup[] = [
	msg("Commands"),
	msg("Global"),
	msg("Map Navigation"),
	msg("Location Editor"),
	msg("Quicktag"),
	msg("Review"),
];

/** The dialog-wide search drives the same filter as the local one, so shortcuts are reachable
 *  from the rail search rather than only from this section's own box. */
function KeyboardBody() {
	const { query, searching, sectionMatched } = useSettingsSearch();
	const [filter, setFilter] = useState("");
	const [flash, setFlash] = useState<string | null>(null);
	const needle = searching && !sectionMatched ? query : filter;
	const allBindings = getAllBindings();

	const jumpTo = useCallback((action: string) => {
		document
			.getElementById(`hotkey-row-${action}`)
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		setFlash(action);
		window.setTimeout(() => setFlash((cur) => (cur === action ? null : cur)), 1500);
	}, []);

	return (
		<>
			<Aux>
				<div className="settings-hotkey-filter">
					<SearchInput
						placeholder={t("Filter shortcuts...")}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						style={{ width: "100%" }}
					/>
				</div>
			</Aux>
			{GROUPS.map((group) => {
				const defs = allBindings.filter(
					(d) => d.group === group && matches(needle, hotkeyLabel(d), getBinding(d.action)),
				);
				if (defs.length === 0) return null;
				return (
					<div key={group}>
						<h3 className="settings-group eyebrow">{t(group)}</h3>
						<table className="data-table">
							<thead>
								<tr>
									<th>{t("Action")}</th>
									<th>{t("Binding")}</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{defs.map((d) => (
									<HotkeyRow
										key={d.action}
										action={d.action}
										label={hotkeyLabel(d)}
										flash={flash === d.action}
										onJump={jumpTo}
									/>
								))}
							</tbody>
						</table>
					</div>
				);
			})}
			<Aux>
				<div style={{ marginTop: ".5rem" }}>
					<Button onClick={resetAllBindings}>{t("Reset all to defaults")}</Button>
				</div>
			</Aux>
		</>
	);
}

function StreetViewBody() {
	const s = useSettings();
	const controls: { key: keyof typeof s; label: string }[] = [
		{ key: "showFullscreenButton", label: t("Fullscreen button") },
		{ key: "showScreenshotButton", label: t("Screenshot button") },
		{ key: "showJumpButtons", label: t("Jump forward/backward buttons") },
		{ key: "showCompass", label: t("Compass (wind rose)") },
		{ key: "showCompassTape", label: t("Compass (heading tape)") },
		{ key: "showZoom", label: t("Zoom controls") },
		{ key: "showReturnToSpawn", label: t("Return to spawn button") },
		{ key: "showMapLinks", label: t("Map links (open in maps, copy link)") },
		{ key: "showCoordinateDisplay", label: t("Coordinate / zoom display") },
		{ key: "showPanoMetadata", label: t("Show pano metadata") },
	];

	return (
		<>
			<SettingsGroup title={t("Navigation")}>
				<SettingRow setting="showLinksControl" label={t("Show link arrows (ground navigation)")} />
				<SettingRow setting="clickToGo" label={t("Show click-to-go navigation")} />
				{s.clickToGo && (
					<>
						<SettingRow sub setting="showNavArrow" label={t("Show navigation X")} />
						<SettingRow sub setting="showGroundArrow" label={t("Show ground arrow")} />
					</>
				)}
				<SettingRow
					setting="hideNavWithUI"
					label={t("Hide navigation with pano UI")}
					description={t(
						"The pano UI toggle also hides link arrows, the ground arrow, and the navigation X.",
					)}
				/>
				<SettingRow
					label={t("Default movement mode")}
					keywords={optionLabels(MOVEMENT_MODES)}
					control={<SettingSelect setting="defaultMovementMode" options={MOVEMENT_MODES} />}
				/>
				<SettingRow
					label={t("Pano look speed")}
					control={
						<SettingSlider setting="panoLookSpeed" min={1} max={20} step={1} format={(v) => v} />
					}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Display")}>
				<SettingRow setting="showRoadLabels" label={t("Show road labels")} />
				<SettingRow setting="showCar" label={t("Show car")} />
				<SettingRow setting="showCrosshair" label={t("Show crosshair")} />
				<SettingRow
					label={t("Preview aspect ratio")}
					keywords={optionLabels(PREVIEW_ASPECT_RATIOS)}
					control={<SettingSelect setting="previewAspectRatio" options={PREVIEW_ASPECT_RATIOS} />}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Viewer controls")}>
				{controls.map(({ key, label }) => (
					<SettingRow key={key} setting={key} label={label} />
				))}
			</SettingsGroup>

			<SettingsGroup title={t("Fullscreen panorama")}>
				<SettingRow setting="showFullscreenMinimap" label={t("Show minimap in fullscreen")} />
				<SettingRow
					sub
					disabled={!s.showFullscreenMinimap}
					label={t("Minimap close delay")}
					description={t("How long the minimap stays expanded after the pointer leaves it.")}
					control={
						<SettingSlider
							setting="fullscreenMinimapCloseDelay"
							min={0}
							max={1000}
							step={50}
							disabled={!s.showFullscreenMinimap}
							format={(v) => `${v}ms`}
						/>
					}
				/>
				<SettingRow setting="showFullscreenTagbar" label={t("Show tag bar in fullscreen")} />
				<SettingRow
					setting="showFullscreenDatePicker"
					label={t("Show date picker in fullscreen")}
				/>
				<SettingRow setting="showFullscreenReviewBar" label={t("Show review bar in fullscreen")} />
				<SettingRow
					setting="showFullscreenGeocode"
					label={t("Show geocoding info in fullscreen")}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Date picker")}>
				<SettingRow
					setting="showCameraBadges"
					label={t("Show camera type badges (Gen1, Gen2, etc.)")}
				/>
				<SettingRow
					label={t("Exact date format")}
					keywords={optionLabels(EXACT_DATE_FORMATS)}
					control={<SettingSelect setting="exactDateFormat" options={EXACT_DATE_FORMATS} />}
				/>
				<SettingRow
					label={t("Exact date timezone")}
					keywords={optionLabels(DATE_TIMEZONES)}
					control={<SettingSelect setting="dateTimezone" options={DATE_TIMEZONES} />}
				/>
			</SettingsGroup>
		</>
	);
}

function MapBody() {
	const s = useSettings();
	return (
		<>
			<SettingsGroup title={t("Navigation")}>
				<SettingRow
					label={t("Pan speed")}
					control={
						<SettingSlider setting="mapPanSpeed" min={1} max={20} step={1} format={(v) => v} />
					}
				/>
				<SettingRow setting="panToImported" label={t("Pan to imported locations")} />
				<SettingRow
					sub
					disabled={!s.panToImported}
					label={t("Paste zoom padding")}
					control={
						<SettingSlider
							setting="pastePadding"
							min={0.001}
							max={0.05}
							step={0.001}
							disabled={!s.panToImported}
							format={(v) => `${v.toFixed(3)}°`}
						/>
					}
				/>
				<SettingRow
					label={t("Alt slow-down")}
					description={t("Hold Alt to slow down map panning and pano look.")}
					control={
						<SettingSlider
							setting="slowModifier"
							min={2}
							max={10}
							step={1}
							format={(v) => `${v}x`}
						/>
					}
				/>
				<SettingRow
					setting="followActiveInReview"
					label={t("Center map on active location during review")}
				/>
				<SettingRow
					setting="enterOpensCenter"
					label={t("Enter opens location at map center")}
					description={t(
						"With no location open, Enter opens the location at the center of the map.",
					)}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Markers")}>
				<SettingRow
					label={t("Default marker color")}
					control={<SettingColor setting="markerColor" ariaLabel={t("Default marker color")} />}
				/>
				<SettingRow
					label={t("Active marker color")}
					control={
						<SettingColor
							setting="activeLocationColor"
							ariaLabel={t("Active location marker color")}
						/>
					}
				/>
				<SettingRow
					label={t("Staged marker color")}
					control={
						<SettingColor
							setting="importPreviewColor"
							ariaLabel={t("Staged import marker color")}
						/>
					}
				/>
				<SettingRow
					label={t("Layer opacity toggle")}
					keywords={optionLabels(OPACITY_TOGGLE_MODES)}
					description={t(
						"What the Street View and marker opacity hotkeys restore a hidden layer to.",
					)}
					control={<SettingSelect setting="opacityToggleMode" options={OPACITY_TOGGLE_MODES} />}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Panorama dots")}>
				<SettingRow
					label={t("Dot color")}
					control={<SettingColor setting="panoDotColor" ariaLabel={t("Panorama dot color")} />}
				/>
				<SettingRow
					label={t("Dot size")}
					control={
						<NSelect
							value={s.panoDotScaled ? "scaled" : "constant"}
							onChange={(e) => setSetting("panoDotScaled", e.target.value === "scaled")}
						>
							<option value="constant">{t("Constant on screen")}</option>
							<option value="scaled">{t("Grow when zoomed in")}</option>
						</NSelect>
					}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Street View trail")}>
				<SettingRow setting="svTrail" label={t("Show navigation trail")} />
				{s.svTrail && (
					<>
						<SettingRow
							sub
							label={t("Trail color")}
							control={
								<SettingColor setting="svTrailColor" ariaLabel={t("Street View trail color")} />
							}
						/>
						<SettingRow sub setting="svTrailPosition" label={t("Show position indicator")} />
					</>
				)}
			</SettingsGroup>

			<SettingsGroup title={t("Selections")}>
				<SettingRow
					label={t("Polygon color")}
					keywords={optionLabels(POLYGON_COLOR_MODES)}
					control={
						<span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
							<SettingSelect setting="polygonColorMode" options={POLYGON_COLOR_MODES} />
							{s.polygonColorMode === "fixed" && (
								<SettingColor setting="polygonColor" ariaLabel={t("Default polygon color")} />
							)}
						</span>
					}
				/>

				<BorderDetailGroup />
			</SettingsGroup>

			<SettingsGroup title={t("Fullscreen map")}>
				<SettingRow setting="showFullscreenMapMeta" label={t("Show map meta bar in fullscreen")} />
				<SettingRow
					setting="showFullscreenMiniLocationPreview"
					label={t("Show mini location preview in fullscreen")}
				/>
			</SettingsGroup>
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
		void (async () => {
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
			setError(t("Download failed: {error}", { error: errText(e) }));
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
			setError(t("Download failed: {error}", { error: errText(e) }));
		} finally {
			setDownloading(null);
		}
	};

	const statusLabel = (level: "medium" | "heavy") => {
		if (downloading === level) return ` ${t("(downloading...)")}`;
		const ready = level === "medium" ? mediumReady : heavyReady;
		if (ready === null) return "";
		return ready ? "" : ` ${t("(will download)")}`;
	};

	const subdivisionStatus = () => {
		if (downloading === "adm1") return ` ${t("(downloading...)")}`;
		if (adm1Ready === null) return "";
		return adm1Ready
			? ""
			: ` ${t("({size}, will download)", { size: formatBytes(BORDER_ARCHIVE_BYTES.adm1) })}`;
	};

	return (
		<>
			<SettingsGroup title={t("Borders")}>
				<SettingRow
					label={t("Country data")}
					control={
						<NSelect
							compact
							value={s.borderDetail}
							onChange={(e) => void handleChange(e.target.value as BorderDetail)}
							disabled={downloading !== null}
						>
							{Object.entries(BORDER_DETAILS).map(([value, label]) => {
								const level = value as BorderDetail;
								return (
									<option key={level} value={level}>
										{level === "light"
											? t(label)
											: t(label, { size: formatBytes(BORDER_ARCHIVE_BYTES[level]) }) +
												statusLabel(level)}
									</option>
								);
							})}
						</NSelect>
					}
				/>
				<SettingRow
					label={t("Subdivision data")}
					control={
						<NSelect
							compact
							value={s.subdivisionDetail}
							onChange={(e) => void handleSubdivisionChange(e.target.value as SubdivisionDetail)}
							disabled={downloading !== null}
						>
							{Object.entries(SUBDIVISION_DETAILS).map(([value, label]) => (
								<option key={value} value={value}>
									{t(label)}
									{value !== "off" && subdivisionStatus()}
								</option>
							))}
						</NSelect>
					}
				/>
				{(downloading || error) && (
					<Aux>
						{downloading && <Hint>{t("Downloading border data...")}</Hint>}
						{error && <Notice tone="error">{error}</Notice>}
					</Aux>
				)}
			</SettingsGroup>
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
			<SettingsGroup title={t("Tags")}>
				<SettingRow
					label={t("View mode")}
					keywords={optionLabels(TAG_VIEW_MODES)}
					control={<SettingSelect setting="tagViewMode" options={TAG_VIEW_MODES} />}
				/>
				{s.tagViewMode === "tree" && (
					<>
						<SettingRow
							sub
							label={t("Folder color")}
							keywords={optionLabels(TAG_FOLDER_COLOR_MODES)}
							control={
								<span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
									<SettingSelect setting="tagFolderColorMode" options={TAG_FOLDER_COLOR_MODES} />
									{s.tagFolderColorMode === "direct" && (
										<SettingColor setting="tagFolderColor" ariaLabel={t("Default folder color")} />
									)}
								</span>
							}
						/>
						<SettingRow
							sub
							setting="truncateTagPaths"
							label={t("Truncate tag names to shortest unique path")}
						/>
					</>
				)}
				<SettingRow setting="animateTagReorder" label={t("Animate tags during drag reorder")} />
				<SettingRow
					label={t("Tag gap")}
					control={
						<SettingSlider setting="tagGap" min={0} max={16} step={1} format={(v) => `${v}px`} />
					}
				/>
				<SettingRow
					label={t("Suggestions shown")}
					control={
						<Slider
							value={limitIndex}
							min={0}
							max={TAG_SUGGESTION_LIMITS.length - 1}
							step={1}
							onChange={(e) =>
								setSetting("tagSuggestionLimit", TAG_SUGGESTION_LIMITS[Number(e.target.value)])
							}
							format={() => (s.tagSuggestionLimit === 0 ? t("All") : String(s.tagSuggestionLimit))}
						/>
					}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Seen")}>
				<SettingRow setting="enableSeen" label={t("Log viewed panos")} />
				{s.enableSeen && (
					<>
						<SettingRow sub setting="enableSeenThumbnails" label={t("Save thumbnails")} />
						{s.enableSeenThumbnails && (
							<SettingRow
								sub
								label={t("Thumbnail resolution")}
								keywords={optionLabels(SEEN_RESOLUTIONS)}
								control={<SettingSelect setting="seenResolution" options={SEEN_RESOLUTIONS} />}
							/>
						)}
					</>
				)}
			</SettingsGroup>

			<SettingsGroup title={t("Geocoding")}>
				<SettingRow
					label={t("Provider")}
					keywords={optionLabels(GEOCODE_PROVIDERS)}
					control={<SettingSelect setting="geocodeProvider" options={GEOCODE_PROVIDERS} />}
				/>
				{s.geocodeProvider === "nominatim" && (
					<>
						<Aux>
							<Notice tone="warning">
								{t("Without an API key, requests may be rate-limited by Nominatim's usage policy.")}
							</Notice>
						</Aux>
						<SettingRow
							sub
							label={t("API key (optional)")}
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
			</SettingsGroup>
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
			<Hint>{t("Fields shown on each map row (labels are always shown)")}</Hint>
			{Object.entries(MAP_LIST_FIELDS).map(([value, label]) => (
				<Checkbox
					key={value}
					checked={fields.includes(value as MapListField)}
					onChange={() => toggle(value as MapListField)}
				>
					{t(label)}
				</Checkbox>
			))}
		</Aux>
	);
}

function UpdateBlock() {
	const update = useUpdateState();
	const { status, action, pending } = describeUpdate(update);
	const version = appVersion() ?? "dev";
	const checking = update.phase === "checking";

	return (
		<Aux match="update version check release restart install">
			<div className="settings-aux__col">
				<div className="settings-aux__row">
					<Pill tone={pending ? "accent" : "neutral"} title={status} aria-label={status}>
						v{version}
					</Pill>
					{isPrereleaseVersion(version) && <PrereleasePill />}
					<IconButton
						className="settings-updates__check"
						icon={<Icon path={mdiRefresh} size={18} className={checking ? "spin" : undefined} />}
						label={t("Check for updates")}
						onClick={() => void checkForUpdate(true)}
						disabled={checking || update.phase === "downloading"}
					/>
					{!pending && <span className="settings-updates__status">{status}</span>}
				</div>
				{update.phase === "available" && (
					<span>
						{status}
						{update.prerelease && <PrereleasePill />}
					</span>
				)}
				{update.phase === "available" && update.notes && (
					<Markdown source={update.notes} className="settings-updates__notes" />
				)}
				{update.phase === "downloading" && (
					<div className="settings-aux__row">
						<Bar value={update.percent / 100} size="md" />
						<span className="mono">{update.percent}%</span>
					</div>
				)}
				{update.phase === "ready" && <span>{status}</span>}
				{action && (
					<div className="settings-aux__row">
						<Button variant="primary" onClick={() => void action.run()}>
							{action.label}
						</Button>
					</div>
				)}
			</div>
		</Aux>
	);
}

/** Changing the channel re-checks straight away, so the block above answers the question the
 *  toggle just raised instead of waiting for the next launch. */
function PrereleaseRow() {
	return (
		<SettingRow
			label={t("Update to pre-releases")}
			description={t("Get new versions early, before they are marked stable.")}
			checked={useSetting("prereleaseUpdates")}
			onChange={(v) => {
				setSetting("prereleaseUpdates", v);
				void checkForUpdate(true);
			}}
		/>
	);
}

/** Selecting a language relaunches: the catalog is read once at boot, so nothing needs to
 *  re-render, and the restart restores the maps that were open. */
function LanguageRow() {
	const value = useSetting("language");
	const codes = (Object.keys(LANGUAGES) as Language[]).filter(
		(code) => import.meta.env.DEV || code !== "en-XA",
	);
	return (
		<SettingRow
			label={t("Language")}
			badge={
				<Tooltip
					content={t(
						"Translations are machine-generated and were not written by native speakers. Wording may be imperfect.",
					)}
				>
					<span
						className="setting-row__badge"
						aria-label={t(
							"Translations are machine-generated and were not written by native speakers. Wording may be imperfect.",
						)}
					>
						<Icon path={mdiFlaskOutline} size={14} />
					</span>
				</Tooltip>
			}
			description={t("Restarts the app")}
			control={
				<NSelect
					compact
					value={value}
					onChange={(e) => {
						setSetting("language", e.target.value as Language);
						void relaunchApp();
					}}
				>
					{codes.map((code) => (
						<option key={code} value={code}>
							{t(LANGUAGES[code])}
						</option>
					))}
				</NSelect>
			}
		/>
	);
}

function ApplicationBody() {
	return (
		<>
			<SettingsGroup title={t("Language")}>
				<LanguageRow />
			</SettingsGroup>

			<SettingsGroup title={t("Units")}>
				<SettingRow
					label={t("Distance")}
					description={t("Automatic follows the system locale")}
					keywords={optionLabels(UNIT_SYSTEMS)}
					control={<SettingSelect setting="units" options={UNIT_SYSTEMS} />}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Startup")}>
				<SettingRow setting="restoreSession" label={t("Restore open maps on startup")} />
			</SettingsGroup>

			<SettingsGroup title={t("Map list")}>
				<MapListBlock />
			</SettingsGroup>

			<SettingsGroup title={t("Updates")}>
				<UpdateBlock />
				<PrereleaseRow />
			</SettingsGroup>

			<SettingsGroup title={t("Data")}>
				<DataBody />
			</SettingsGroup>
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
			<SettingsGroup title={t("Discord")}>
				<SettingRow
					label={t("Rich Presence")}
					keywords={optionLabels(DISCORD_PRESENCE_MODES)}
					control={<SettingSelect setting="discordPresence" options={DISCORD_PRESENCE_MODES} />}
				/>
			</SettingsGroup>

			<SettingsGroup title={t("Remote API")}>
				<SettingRow
					checked={enabled}
					onChange={(v) => {
						if (v && !key) setSetting("remoteApiKey", generateApiKey());
						setSetting("remoteApi", v);
					}}
					label={t("Enable local REST API")}
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
							<Button onClick={() => setSetting("remoteApiKey", generateApiKey())}>
								{t("Regenerate")}
							</Button>
						</div>
					</Aux>
				)}
			</SettingsGroup>
		</>
	);
}

function DataBody() {
	// undefined = no dialog; string = chosen folder; null = reset to default.
	const [pending, setPending] = useState<string | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const { data: loc } = useAsync(() => cmd.getDataLocation().catch(() => null), []);

	const pick = useCallback(async () => {
		const picked = await openDialog({ directory: true, title: t("Choose data folder") });
		if (typeof picked === "string") setPending(picked);
	}, []);

	const apply = useCallback(async () => {
		setBusy(true);
		try {
			await cmd.setDataLocation(pending ?? null);
			await relaunchApp();
		} catch (e) {
			log.error("data folder relaunch failed", e);
			toast(t("Couldn't relaunch automatically. Restart the app to apply."));
			setBusy(false);
		}
	}, [pending]);

	const target = pending ?? loc?.default_path ?? "";

	return (
		<Aux match="data location folder storage">
			<div className="settings-aux__col">
				<code className="code-block">{loc?.path ?? <Spinner />}</code>
				<div className="settings-aux__row">
					<Button onClick={() => void pick()}>{t("Change folder...")}</Button>
					<Button onClick={() => void cmd.openDataFolder()}>{t("Open data folder")}</Button>
					{loc?.is_custom && (
						<Button onClick={() => setPending(null)}>{t("Reset to default")}</Button>
					)}
				</div>
			</div>

			<ConfirmDialog
				open={pending !== undefined}
				onOpenChange={(open) => !open && setPending(undefined)}
				title={t("Change data folder")}
				size="md"
				message={t("Map data will be stored in:")}
				confirmLabel={t("Relaunch now")}
				busy={busy}
				onConfirm={() => void apply()}
			>
				<code className="code-block">{target}</code>
				<Hint>
					{t(
						"Existing maps are not moved automatically. Copy them from the current folder if you want\n\t\t\t\t\t\tto keep them. The app must relaunch to apply.",
					)}
				</Hint>
			</ConfirmDialog>
		</Aux>
	);
}

function AdvancedBody() {
	return (
		<>
			<SettingsGroup title={t("Custom CSS")}>
				<CustomCssBlock />
			</SettingsGroup>

			<SettingsGroup title={t("Debug")}>
				<SettingRow setting="showFps" label={t("Show FPS counter")} />
				<Aux match="log file logs diagnostics">
					<div className="settings-aux__row">
						<Button onClick={() => void cmd.openLogFile()}>{t("Open log file")}</Button>
						<CopyDiagnosticsButton />
					</div>
				</Aux>
			</SettingsGroup>

			<SettingsGroup title={t("Reset")}>
				<Aux match="reset defaults restore">
					<ResetSettingsButton />
				</Aux>
			</SettingsGroup>
		</>
	);
}

function ResetSettingsButton() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>{t("Reset all settings")}</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title={t("Reset all settings")}
				message={t("Reset every app setting to its default? Key bindings are kept.")}
				confirmLabel={t("Reset")}
				tone="destructive"
				onConfirm={() => {
					resetSettings();
					setOpen(false);
				}}
			/>
		</>
	);
}

function CopyDiagnosticsButton() {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		const diagnostics = await collectDiagnostics();
		await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};
	return (
		<Button onClick={() => void copy()}>{copied ? t("Copied") : t("Copy diagnostics")}</Button>
	);
}

function FeedbackBody() {
	const [user, setUser] = useState<GhUser | null>(null);
	const [checking, setChecking] = useState(true);
	const [code, setCode] = useState<DeviceCodeInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [reports] = useReports();

	useEffect(() => {
		void cmd
			.githubMe()
			.then(setUser)
			.catch(() => setUser(null))
			.finally(() => setChecking(false));
	}, []);

	// Also refreshed at startup; opening the section re-checks for anything since.
	useEffect(() => {
		void refreshStoredReports();
	}, []);

	const signIn = async () => {
		setError(null);
		try {
			const info = await cmd.githubStartLogin();
			setCode(info);
			await openExternal(info.verificationUri);
			setUser(await cmd.githubPollLogin());
		} catch (e) {
			setError(String(e));
		} finally {
			setCode(null);
		}
	};

	return (
		<>
			<SettingsGroup title={t("Account")}>
				<Aux match="github sign in account anonymous">
					<div className="feedback-account">
						{checking ? (
							<span className="text-muted">{t("Checking sign-in...")}</span>
						) : user ? (
							<>
								{user.avatarUrl && (
									<img className="feedback-account__avatar" src={user.avatarUrl} alt="" />
								)}
								<span>{user.login}</span>
								<Button
									onClick={() => {
										void cmd.githubLogout().then(() => setUser(null));
									}}
								>
									{t("Sign out")}
								</Button>
							</>
						) : (
							<>
								<span className="text-muted">
									{t("Not signed in. Reports are filed anonymously and replies arrive here.")}
								</span>
								<Button onClick={() => void signIn()}>{t("Sign in with GitHub")}</Button>
							</>
						)}
					</div>
					{code && (
						<p className="text-muted">
							{t("Enter code {code} in your browser to finish signing in.", {
								code: code.userCode,
							})}
						</p>
					)}
					{error && <Notice tone="error">{error}</Notice>}
				</Aux>
			</SettingsGroup>

			<SettingsGroup title={t("Reports")}>
				<Aux match="report bug feedback issue replies">
					<div className="settings-aux__row">
						<Button variant="primary" onClick={() => openAppDialog("feedback")}>
							{t("Send feedback")}
						</Button>
					</div>
					{reports.length === 0 ? (
						<p className="text-muted">{t("Nothing sent yet.")}</p>
					) : (
						<ul className="feedback-reports">
							{reports.map((r) => {
								const status = reportStatus(r);
								return (
									<li key={r.number} className="feedback-reports__item">
										{status && (
											<span
												className={`feedback-reports__status feedback-reports__status--${status.tone}`}
												title={t(status.label)}
											>
												<Icon path={status.icon} size={16} />
											</span>
										)}
										<button
											type="button"
											className="link-button"
											onClick={() => {
												markRepliesSeen(r.number);
												void openExternal(r.url);
											}}
										>
											{r.title}
										</button>
										{r.replies > r.seenReplies && (
											<span className="feedback-reports__badge">{r.replies - r.seenReplies}</span>
										)}
										<span className="text-muted">
											{new Date(r.submittedAt).toLocaleDateString()}
										</span>
									</li>
								);
							})}
						</ul>
					)}
				</Aux>
			</SettingsGroup>
		</>
	);
}

/** Presence-only marker for replies the user has not read, for the entry points that lead
 *  here from the app chrome. The count itself belongs on the Feedback section. */
export function UnreadReplyDot() {
	const [reports] = useReports();
	if (unreadReplyCount(reports) === 0) return null;
	return <span className="feedback-dot" />;
}

type Section = {
	id: string;
	title: string;
	icon: string;
	Body: () => ReactNode;
};

/** Editing surfaces first, then input, then app-level concerns. Section 0 is the landing section. */
const SECTIONS: Section[] = [
	{ id: "streetview", title: msg("Street View"), icon: mdiGoogleStreetView, Body: StreetViewBody },
	{ id: "map", title: msg("Map"), icon: mdiMapOutline, Body: MapBody },
	{ id: "editing", title: msg("Editing"), icon: mdiPencilOutline, Body: EditingBody },
	{ id: "keyboard", title: msg("Keyboard"), icon: mdiKeyboardOutline, Body: KeyboardBody },
	{
		id: "application",
		title: msg("Application"),
		icon: mdiApplicationOutline,
		Body: ApplicationBody,
	},
	{
		id: "integrations",
		title: msg("Integrations"),
		icon: mdiPuzzleOutline,
		Body: IntegrationsBody,
	},
	{ id: "feedback", title: msg("Feedback"), icon: mdiMessageAlertOutline, Body: FeedbackBody },
	{ id: "advanced", title: msg("Advanced"), icon: mdiWrenchOutline, Body: AdvancedBody },
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
	const sectionMatched = mode === "single" || query === "" || matches(query, t(section.title));
	const Body = section.Body;
	return (
		<SettingsSearchContext.Provider
			value={{
				query,
				searching: mode === "search",
				sectionMatched,
				sectionTitle: t(section.title),
			}}
		>
			<section
				className={`settings-section${mode === "search" ? " settings-section--search" : ""}`}
				data-qa={`settings-section-${section.id}`}
				style={hidden ? { display: "none" } : undefined}
			>
				<div className="settings-section__head">
					<h2 className={`settings-section__title${mode === "search" ? " eyebrow" : ""}`}>
						{t(section.title)}
					</h2>
				</div>
				<Body />
			</section>
		</SettingsSearchContext.Provider>
	);
}

export function SettingsPage({ open, onOpenChange }: DialogProps) {
	const [selected, setSelected] = useState<string>(SECTIONS[0].id);
	const [reports] = useReports();
	const unread = unreadReplyCount(reports);
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const q = query.trim();
	const searching = q !== "";

	useEffect(() => {
		if (open) setQuery("");
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				title={t("Settings")}
				className="settings-page"
				size="xl"
				initialFocus={searchRef}
			>
				<nav className="settings-rail">
					<SearchInput
						ref={searchRef}
						className="settings-rail__search"
						placeholder={t("Search settings...")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<div className="settings-nav-list">
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								data-qa={`settings-nav-${s.id}`}
								className={`nav-item${!searching && s.id === selected ? " nav-item--active" : ""}`}
								onClick={() => {
									setSelected(s.id);
									setQuery("");
								}}
							>
								<Icon path={s.icon} size={16} className="nav-item__icon" />
								{t(s.title)}
								{s.id === "feedback" && unread > 0 && (
									<Pill tone="action" className="nav-item__badge" count={unread} />
								)}
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
