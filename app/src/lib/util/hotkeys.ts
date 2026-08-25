import { getCommands, getCommand } from "@/store/commands";
import { bridgeAcrossWindows, emit as emitEvent, useEventValue } from "@/lib/events";
import { getLocal, setLocal, reloadLocal } from "@/lib/hooks/useLocalStorage";
import { msg } from "@/lib/i18n";

const QUICKTAG_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
type QuicktagSlot = (typeof QUICKTAG_SLOTS)[number];

/** Derived from the def table: the raw UI defs below plus the generated
 *  quicktag slots. Command-level bindings are keyed by registry id (string). */
export type HotkeyAction =
	(typeof STATIC_HOTKEY_DEFS)[number]["action"] | `quicktag${QuicktagSlot}`;

export type HotkeyGroup =
	"Commands" | "Global" | "Map Navigation" | "Location Editor" | "Quicktag" | "Review";

export interface HotkeyDef {
	action: HotkeyAction;
	label: string;
	group: HotkeyGroup;
	defaultBinding: string;
	altSlow?: boolean;
}

// Raw input bindings only. Command-level bindings are derived from the command registry.
const STATIC_HOTKEY_DEFS = [
	{
		action: "openCommandPalette",
		label: msg("Open command palette"),
		group: msg("Global"),
		defaultBinding: "Mod+k",
	},
	{
		action: "openManualSearch",
		label: msg("Search the manual"),
		group: msg("Global"),
		defaultBinding: "Mod+?",
	},
	{
		action: "toggleStats",
		label: msg("Toggle stats for nerds"),
		group: msg("Global"),
		defaultBinding: "Mod+Shift+d",
	},
	{
		action: "closeMap",
		label: msg("Close map"),
		group: msg("Global"),
		defaultBinding: "Mod+Shift+w",
	},
	{
		action: "locationSave",
		label: msg("Save location"),
		group: msg("Location Editor"),
		defaultBinding: "enter",
	},
	{
		action: "locationClose",
		label: msg("Close location"),
		group: msg("Location Editor"),
		defaultBinding: "escape",
	},
	{
		action: "locationDelete",
		label: msg("Delete location"),
		group: msg("Location Editor"),
		defaultBinding: "delete",
	},
	{
		action: "toggleFullscreen",
		label: msg("Toggle fullscreen"),
		group: msg("Location Editor"),
		defaultBinding: "f",
	},
	{
		action: "returnToSpawn",
		label: msg("Return to spawn"),
		group: msg("Location Editor"),
		defaultBinding: "r",
	},
	{
		action: "pointNorth",
		label: msg("Point north"),
		group: msg("Location Editor"),
		defaultBinding: "n",
	},
	{
		action: "centerRoad",
		label: msg("Center toward nearest road direction"),
		group: msg("Location Editor"),
		defaultBinding: "b",
	},
	{ action: "zoomIn", label: msg("Zoom in"), group: msg("Location Editor"), defaultBinding: "+" },
	{ action: "zoomOut", label: msg("Zoom out"), group: msg("Location Editor"), defaultBinding: "-" },
	{
		action: "panoZoomReset",
		label: msg("Zoom all the way out"),
		group: msg("Location Editor"),
		defaultBinding: "0",
	},
	{
		action: "copyLink",
		label: msg("Copy Street View link"),
		group: msg("Location Editor"),
		defaultBinding: "Mod+c",
	},
	{
		action: "toggleCrosshair",
		label: msg("Toggle crosshair"),
		group: msg("Location Editor"),
		defaultBinding: "x",
	},
	{
		action: "toggleHideCar",
		label: msg("Toggle hide car"),
		group: msg("Location Editor"),
		defaultBinding: "Mod+h",
	},
	{
		action: "togglePanoUI",
		label: msg("Toggle pano UI"),
		group: msg("Location Editor"),
		defaultBinding: "h",
	},
	{
		action: "cycleMovementMode",
		label: msg("Cycle movement mode"),
		group: msg("Location Editor"),
		defaultBinding: "Shift+m",
	},
	{
		action: "duplicateLocation",
		label: msg("Duplicate location"),
		group: msg("Location Editor"),
		defaultBinding: "c",
	},
	{
		action: "followRoad",
		label: msg("Follow linked panos along road"),
		group: msg("Location Editor"),
		defaultBinding: "g",
	},
	{
		action: "downloadPanoTile",
		label: msg("Download panorama"),
		group: msg("Location Editor"),
		defaultBinding: "Mod+Shift+s",
	},
	{
		action: "toggleFullscreenMap",
		label: msg("Toggle fullscreen map"),
		group: msg("Global"),
		defaultBinding: "Mod+\\",
	},
	{
		action: "nextPanoDate",
		label: msg("Next date cycle"),
		group: msg("Location Editor"),
		defaultBinding: "]",
	},
	{
		action: "prevPanoDate",
		label: msg("Previous date cycle"),
		group: msg("Location Editor"),
		defaultBinding: "[",
	},
	{
		action: "spin180",
		label: msg("Spin 180°"),
		group: msg("Location Editor"),
		defaultBinding: "t",
	},
	{
		action: "refreshPano",
		label: msg("Refresh panorama"),
		group: msg("Location Editor"),
		defaultBinding: "Shift+r",
	},
	{
		action: "reviewNext",
		label: msg("Next location"),
		group: msg("Review"),
		defaultBinding: "Mod+ArrowRight",
	},
	{
		action: "reviewPrev",
		label: msg("Previous location"),
		group: msg("Review"),
		defaultBinding: "Mod+ArrowLeft",
	},
	{
		action: "panLeft",
		label: msg("Pan left"),
		group: msg("Map Navigation"),
		defaultBinding: "a",
		altSlow: true,
	},
	{
		action: "panRight",
		label: msg("Pan right"),
		group: msg("Map Navigation"),
		defaultBinding: "d",
		altSlow: true,
	},
	{
		action: "panUp",
		label: msg("Pan up"),
		group: msg("Map Navigation"),
		defaultBinding: "w",
		altSlow: true,
	},
	{
		action: "panDown",
		label: msg("Pan down"),
		group: msg("Map Navigation"),
		defaultBinding: "s",
		altSlow: true,
	},
	{
		action: "mapZoomIn",
		label: msg("Zoom in"),
		group: msg("Map Navigation"),
		defaultBinding: "Shift+w",
		altSlow: true,
	},
	{
		action: "mapZoomOut",
		label: msg("Zoom out"),
		group: msg("Map Navigation"),
		defaultBinding: "Shift+s",
		altSlow: true,
	},
	{
		action: "mapZoomBounds",
		label: msg("Zoom to bounds"),
		group: msg("Map Navigation"),
		defaultBinding: "Shift+b",
	},
	{
		action: "mapZoomReset",
		label: msg("Zoom all the way out"),
		group: msg("Map Navigation"),
		defaultBinding: "Shift+0",
	},
	{
		action: "panoLookLeft",
		label: msg("Look left"),
		group: msg("Location Editor"),
		defaultBinding: "ArrowLeft",
		altSlow: true,
	},
	{
		action: "panoLookRight",
		label: msg("Look right"),
		group: msg("Location Editor"),
		defaultBinding: "ArrowRight",
		altSlow: true,
	},
	{
		action: "panoLookUp",
		label: msg("Look up"),
		group: msg("Location Editor"),
		defaultBinding: "ArrowUp",
		altSlow: true,
	},
	{
		action: "panoLookDown",
		label: msg("Look down"),
		group: msg("Location Editor"),
		defaultBinding: "ArrowDown",
		altSlow: true,
	},
	{
		action: "panoMoveForward",
		label: msg("Move forward"),
		group: msg("Location Editor"),
		defaultBinding: "Shift+ArrowUp",
		altSlow: true,
	},
	{
		action: "panoMoveBackward",
		label: msg("Move backward"),
		group: msg("Location Editor"),
		defaultBinding: "Shift+ArrowDown",
		altSlow: true,
	},
	{
		action: "jumpForward",
		label: msg("Jump forward 100m"),
		group: msg("Location Editor"),
		defaultBinding: "}",
	},
	{
		action: "jumpBackward",
		label: msg("Jump backward 100m"),
		group: msg("Location Editor"),
		defaultBinding: "{",
	},
	{
		action: "panToLocation",
		label: msg("Pan map to location"),
		group: msg("Location Editor"),
		defaultBinding: "l",
	},
	{
		action: "viewportLock",
		label: msg("Lock viewport direction"),
		group: msg("Location Editor"),
		defaultBinding: "v",
	},
	{
		action: "countrySelect",
		label: msg("Hold + click for country (+Shift for subdivision)"),
		group: msg("Global"),
		defaultBinding: "q",
	},
	{
		action: "deletePolygon",
		label: msg("Hold + click to delete polygon"),
		group: msg("Global"),
		defaultBinding: "e",
	},
	{
		action: "mapZoomSelection",
		label: msg("Zoom to selected locations"),
		group: msg("Map Navigation"),
		defaultBinding: "Shift+e",
	},
	{
		action: "toggleSelectOnly",
		label: msg("Toggle select-only mode"),
		group: msg("Map Navigation"),
		defaultBinding: "o",
	},
	{
		action: "toggleSvOpacity",
		label: msg("Toggle Street View layer opacity"),
		group: msg("Map Navigation"),
		defaultBinding: "p",
	},
	{
		action: "toggleMarkerOpacity",
		label: msg("Toggle marker layer opacity"),
		group: msg("Map Navigation"),
		defaultBinding: "m",
	},
] as const satisfies readonly (Omit<HotkeyDef, "action"> & { action: string })[];

// Spelled out rather than built from a template: the extractor only sees plain literals, so an
// interpolated `msg(\`Quick-tag slot ${n}\`)` would silently contribute nothing to the catalog.
const QUICKTAG_LABELS: Record<QuicktagSlot, string> = {
	1: msg("Quick-tag slot 1"),
	2: msg("Quick-tag slot 2"),
	3: msg("Quick-tag slot 3"),
	4: msg("Quick-tag slot 4"),
	5: msg("Quick-tag slot 5"),
	6: msg("Quick-tag slot 6"),
	7: msg("Quick-tag slot 7"),
	8: msg("Quick-tag slot 8"),
	9: msg("Quick-tag slot 9"),
};

const RAW_HOTKEY_DEFS: HotkeyDef[] = [
	...STATIC_HOTKEY_DEFS,
	...QUICKTAG_SLOTS.map((n): HotkeyDef => ({
		action: `quicktag${n}`,
		label: QUICKTAG_LABELS[n],
		group: msg("Quicktag"),
		defaultBinding: String(n),
	})),
];

// Unified view: raw defs + command-derived defs. This is what the shortcuts UI iterates.
export function getAllBindings(): HotkeyDef[] {
	const commandDefs: HotkeyDef[] = getCommands().map((cmd) => ({
		action: cmd.id as HotkeyAction,
		label: cmd.label,
		group: msg("Commands"),
		defaultBinding: cmd.defaultBinding ?? "",
	}));
	return [...commandDefs, ...RAW_HOTKEY_DEFS];
}

const STORAGE_KEY = "hotkeyOverrides";

type HotkeyOverrides = Partial<Record<string, string>>;

let overrides: HotkeyOverrides = getLocal<HotkeyOverrides>(STORAGE_KEY, {});

// Another window changed bindings: reread the shared localStorage before re-emitting.
bridgeAcrossWindows("hotkeys:changed", () => {
	overrides = reloadLocal<HotkeyOverrides>(STORAGE_KEY, {});
});

function getDefaultBinding(action: string): string {
	for (const d of RAW_HOTKEY_DEFS) {
		if (d.action === action) return d.defaultBinding;
	}
	const cmd = getCommand(action);
	return cmd?.defaultBinding ?? "";
}

export function getBinding(action: HotkeyAction | string): string {
	return overrides[action] ?? getDefaultBinding(action);
}

export function isCustomized(action: HotkeyAction): boolean {
	return action in overrides;
}

// A recorded combo using Alt is unusable for any altSlow action: Alt is the slow
// navigation modifier, ignored when matching, so the combo would also fire the nav
// action. Strip Alt and look up the altSlow binding it would shadow. `combo` must be
// in canonical buildComboString form (the same format bindings are stored in).
export function getAltSlowConflict(combo: string): HotkeyDef | undefined {
	const parts = combo.split("+");
	const altIdx = parts.indexOf("Alt");
	if (altIdx === -1) return undefined;
	parts.splice(altIdx, 1);
	const stripped = parts.join("+");
	if (!stripped) return undefined;
	return RAW_HOTKEY_DEFS.find((d) => d.altSlow && getBinding(d.action) === stripped);
}

export function getConflicts(action: string, binding: string): HotkeyDef[] {
	if (!binding) return [];
	return getAllBindings().filter((d) => d.action !== action && getBinding(d.action) === binding);
}

export function setBinding(action: HotkeyAction, binding: string): void {
	overrides[action] = binding;
	setLocal(STORAGE_KEY, overrides);
	emitEvent("hotkeys:changed");
}

// Assign `binding` to `action`, clearing it from any other actions that currently
// hold it so the binding becomes unique. Returns the actions that were cleared.
export function reassignBinding(action: HotkeyAction, binding: string): string[] {
	const cleared = getConflicts(action, binding).map((d) => d.action);
	for (const a of cleared) overrides[a] = "";
	overrides[action] = binding;
	setLocal(STORAGE_KEY, overrides);
	emitEvent("hotkeys:changed");
	return cleared;
}

export function resetBinding(action: HotkeyAction): void {
	delete overrides[action];
	setLocal(STORAGE_KEY, overrides);
	emitEvent("hotkeys:changed");
}

export function resetAllBindings(): void {
	overrides = {};
	setLocal(STORAGE_KEY, overrides);
	emitEvent("hotkeys:changed");
}

export function useBinding(action: HotkeyAction): string {
	return useEventValue("hotkeys:changed", () => getBinding(action));
}
