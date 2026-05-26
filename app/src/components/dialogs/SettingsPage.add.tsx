import { useState, useRef, useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { DatabaseManager } from "@/components/dialogs/DatabaseManager.add";
import { log } from "@/lib/util/log";
import {
	getAllBindings,
	useBinding,
	getBinding,
	setBinding,
	resetBinding,
	resetAllBindings,
	getConflicts,
	isCustomized,
	type HotkeyAction,
	type HotkeyGroup,
} from "@/lib/util/hotkeys.add";
import {
	useSettings,
	setSetting,
	type MovementMode,
	type ExactDateFormat,
	type DateTimezone,
	type SeenResolution,
	type MapListField,
	type GeocodeProvider,
	type TagViewMode,
} from "@/store/settings.add";

const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform);

function formatBinding(binding: string): string {
	return binding
		.replace(/Mod/g, IS_MAC ? "Cmd" : "Ctrl")
		.replace(/ArrowRight/g, "Right")
		.replace(/ArrowLeft/g, "Left")
		.replace(/ArrowUp/g, "Up")
		.replace(/ArrowDown/g, "Down");
}

function buildComboString(e: KeyboardEvent): string | null {
	const key = e.key;
	if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;

	const parts: string[] = [];
	if (e.ctrlKey && !IS_MAC) parts.push("Mod");
	if (e.metaKey && IS_MAC) parts.push("Mod");
	if (e.ctrlKey && IS_MAC) parts.push("Ctrl");
	if (e.metaKey && !IS_MAC) parts.push("Meta");
	if (e.altKey) parts.push("Alt");
	if (e.shiftKey) parts.push("Shift");

	let keyName = key;
	if (key === " ") keyName = "space";
	else if (key === "=" && !e.shiftKey) keyName = "+";
	else if (key.length === 1) keyName = key.toLowerCase();

	if (keyName === "+" && parts.length === 0) {
		parts.push("plus");
		return parts.join("+");
	}

	parts.push(keyName);
	return parts.join("+");
}

const BLOCKED_COMBOS = new Set(["Mod++", "Mod+-"]);

function getBlockedReason(e: KeyboardEvent): string | null {
	if (e.altKey) return "Alt is reserved as a slow modifier for map/pano navigation";
	const combo = buildComboString(e);
	if (combo && BLOCKED_COMBOS.has(combo)) return "Intercepted by the app window before shortcuts can reach it";
	return null;
}

function HotkeyRow({ action, label }: { action: HotkeyAction; label: string }) {
	const binding = useBinding(action);
	const [recording, setRecording] = useState(false);
	const [blocked, setBlocked] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const custom = isCustomized(action);

	useEffect(() => {
		if (recording && inputRef.current) inputRef.current.focus();
	}, [recording]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === "Escape") {
				setRecording(false);
				setBlocked(null);
				return;
			}

			if (e.key === "Backspace" || e.key === "Delete") {
				setBinding(action, "");
				setRecording(false);
				setBlocked(null);
				return;
			}

			const reason = getBlockedReason(e.nativeEvent);
			if (reason) {
				setBlocked(reason);
				return;
			}

			const combo = buildComboString(e.nativeEvent);
			if (!combo) return;

			setBinding(action, combo);
			setRecording(false);
			setBlocked(null);
		},
		[action],
	);

	const conflicts = getConflicts(action, binding);

	return (
		<tr className={custom ? "hotkey-row--custom" : undefined}>
			<td>{label}</td>
			<td>
				{recording ? (
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
				) : (
					<code
						className={`hotkey-display${!binding ? " hotkey-display--empty" : ""}`}
						onClick={() => setRecording(true)}
						title="Click to rebind"
					>
						{binding ? formatBinding(binding) : " "}
					</code>
				)}
				{conflicts.length > 0 && (
					<span
						className="hotkey-conflict"
						title={`Conflicts with: ${conflicts.map((c) => c.label).join(", ")}`}
					>
						!
					</span>
				)}
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

const GROUPS: HotkeyGroup[] = ["Commands", "Global", "Map Navigation", "Location Editor", "Review"];

function KeyboardShortcutsSection() {
	const [filter, setFilter] = useState("");
	const lower = filter.toLowerCase();
	const allBindings = getAllBindings();

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Keyboard Shortcuts <span className="fieldset__divider" />
			</legend>
			<input
				className="input"
				type="text"
				placeholder="Filter shortcuts..."
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				style={{ width: "100%", marginBottom: ".5rem" }}
			/>
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
									<HotkeyRow key={d.action} action={d.action} label={d.label} />
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
		</fieldset>
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
				<select
					value={s.defaultMovementMode}
					onChange={(e) => setSetting("defaultMovementMode", e.target.value as MovementMode)}
				>
					<option value="moving">Moving</option>
					<option value="no-move">No Move</option>
					<option value="nmpz">NMPZ</option>
				</select>
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
				<input
					type="checkbox"
					checked={s.showExactDate}
					onChange={(e) => setSetting("showExactDate", e.target.checked)}
				/>
				Resolve exact capture date (newest panos only)
			</label>
			{s.showExactDate && (
				<>
					<label className="settings-popup__item">
						Format
						<select
							value={s.exactDateFormat}
							onChange={(e) => setSetting("exactDateFormat", e.target.value as ExactDateFormat)}
						>
							<option value="date">Date only</option>
							<option value="datetime">Date + time</option>
						</select>
					</label>
					<label className="settings-popup__item">
						Timezone
						<select
							value={s.dateTimezone}
							onChange={(e) => setSetting("dateTimezone", e.target.value as DateTimezone)}
						>
							<option value="location">Location timezone</option>
							<option value="utc">UTC</option>
						</select>
					</label>
				</>
			)}
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
							<select
								value={s.seenResolution}
								onChange={(e) => setSetting("seenResolution", e.target.value as SeenResolution)}
							>
								<option value="low">Low (160x90)</option>
								<option value="medium">Medium (320x180)</option>
								<option value="high">High (640x360)</option>
							</select>
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

const MAP_LIST_FIELD_OPTIONS: { value: MapListField; label: string }[] = [
	{ value: "locationCount", label: "Location count" },
	{ value: "lastOpened", label: "Last opened" },
	{ value: "created", label: "Date created" },
];

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
			{MAP_LIST_FIELD_OPTIONS.map(({ value, label }) => (
				<label key={value} className="settings-popup__item">
					<input type="checkbox" checked={fields.includes(value)} onChange={() => toggle(value)} />
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

type SettingsTab = "controls" | "streetview" | "advanced";

const TABS: { id: SettingsTab; label: string }[] = [
	{ id: "controls", label: "Controls" },
	{ id: "streetview", label: "Street View" },
	{ id: "advanced", label: "Advanced" },
];

function ControlsTab() {
	return (
		<>
			<KeyboardShortcutsSection />
			<MapNavigationSection />
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
				<select
					value={s.geocodeProvider}
					onChange={(e) => setSetting("geocodeProvider", e.target.value as GeocodeProvider)}
				>
					<option value="local">Local (offline)</option>
					<option value="nominatim">Nominatim (online)</option>
				</select>
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
	const s = useSettings();
	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Tags <span className="fieldset__divider" />
			</legend>
			<label className="settings-popup__item">
				View mode
				<select
					value={s.tagViewMode}
					onChange={(e) => setSetting("tagViewMode", e.target.value as TagViewMode)}
				>
					<option value="flat">Flat</option>
					<option value="tree">Tree</option>
				</select>
			</label>
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
		</>
	);
}

declare const __APP_VERSION__: string;

type UpdateStatus =
	| { state: "idle" }
	| { state: "checking" }
	| { state: "up-to-date" }
	| { state: "available"; version: string; notes: string }
	| { state: "downloading"; percent: number }
	| { state: "ready" }
	| { state: "error"; message: string };

function UpdateSection() {
	const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
	const updateRef = useRef<Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>> | null>(null);
	const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

	const handleCheck = async () => {
		setStatus({ state: "checking" });
		try {
			const { check } = await import("@tauri-apps/plugin-updater");
			const update = await check();
			if (update) {
				updateRef.current = update;
				setStatus({
					state: "available",
					version: update.version,
					notes: update.body ?? "",
				});
			} else {
				setStatus({ state: "up-to-date" });
			}
		} catch (e) {
			log.error("[updater] check failed:", e);
			setStatus({ state: "error", message: e instanceof Error ? e.message : String(e) });
		}
	};

	const handleInstall = async () => {
		const update = updateRef.current;
		if (!update) return;
		setStatus({ state: "downloading", percent: 0 });
		try {
			let totalBytes = 0;
			let downloadedBytes = 0;
			await update.downloadAndInstall((event) => {
				if (event.event === "Started" && event.data.contentLength) {
					totalBytes = event.data.contentLength;
				} else if (event.event === "Progress") {
					downloadedBytes += event.data.chunkLength;
					if (totalBytes > 0) {
						setStatus({ state: "downloading", percent: Math.round((downloadedBytes / totalBytes) * 100) });
					}
				} else if (event.event === "Finished") {
					setStatus({ state: "ready" });
				}
			});
			setStatus({ state: "ready" });
		} catch (e) {
			log.error("[updater] install failed:", e);
			setStatus({ state: "error", message: e instanceof Error ? e.message : String(e) });
		}
	};

	const handleRelaunch = async () => {
		const { relaunch } = await import("@tauri-apps/plugin-process");
		await relaunch();
	};

	return (
		<fieldset className="fieldset">
			<legend className="fieldset__header">
				Updates <span className="fieldset__divider" />
			</legend>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span>Current version: {version}</span>
					{status.state === "idle" && (
						<button className="button" onClick={handleCheck}>
							Check for updates
						</button>
					)}
					{status.state === "checking" && <span>Checking...</span>}
					{status.state === "up-to-date" && (
						<>
							<span>Up to date</span>
							<button className="button" onClick={handleCheck}>
								Check again
							</button>
						</>
					)}
					{status.state === "error" && (
						<>
							<span style={{ color: "var(--color-error, #e53935)" }}>
								{status.message}
							</span>
							<button className="button" onClick={handleCheck}>
								Retry
							</button>
						</>
					)}
				</div>
				{status.state === "available" && (
					<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
						<span>
							Version {status.version} is available
						</span>
						{status.notes && (
							<pre style={{ maxHeight: 120, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>
								{status.notes}
							</pre>
						)}
						<button className="button button--primary" onClick={handleInstall}>
							Download and install
						</button>
					</div>
				)}
				{status.state === "downloading" && (
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<progress value={status.percent} max={100} style={{ flex: 1 }} />
						<span>{status.percent}%</span>
					</div>
				)}
				{status.state === "ready" && (
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<span>Update installed. Restart to apply.</span>
						<button className="button button--primary" onClick={handleRelaunch}>
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
				{tab === "streetview" && <StreetViewTab />}
				{tab === "advanced" && <AdvancedTab />}
			</DialogContent>
		</Dialog>
	);
}
