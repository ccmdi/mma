import { useSyncExternalStore } from "react";
import { getCommands, getCommand } from "@/store/commands";
import { createSyncStore } from "@/lib/util/syncStore";

const QUICKTAG_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
type QuicktagSlot = (typeof QUICKTAG_SLOTS)[number];

/** Derived from the def table: the raw UI defs below plus the generated
 *  quicktag slots. Command-level bindings are keyed by registry id (string). */
export type HotkeyAction =
	| (typeof STATIC_HOTKEY_DEFS)[number]["action"]
	| `quicktag${QuicktagSlot}`;

export type HotkeyGroup =
	| "Commands"
	| "Global"
	| "Map Navigation"
	| "Location Editor"
	| "Quicktag"
	| "Review";

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
		label: "Open command palette",
		group: "Global",
		defaultBinding: "Mod+k",
	},
	{
		action: "openManualSearch",
		label: "Search the manual",
		group: "Global",
		defaultBinding: "Mod+?",
	},
	{
		action: "toggleStats",
		label: "Toggle stats for nerds",
		group: "Global",
		defaultBinding: "Mod+Shift+d",
	},
	{
		action: "closeMap",
		label: "Close map",
		group: "Global",
		defaultBinding: "Mod+Shift+w",
	},
	{
		action: "locationSave",
		label: "Save location",
		group: "Location Editor",
		defaultBinding: "enter",
	},
	{
		action: "locationClose",
		label: "Close location",
		group: "Location Editor",
		defaultBinding: "escape",
	},
	{
		action: "locationDelete",
		label: "Delete location",
		group: "Location Editor",
		defaultBinding: "delete",
	},
	{
		action: "toggleFullscreen",
		label: "Toggle fullscreen",
		group: "Location Editor",
		defaultBinding: "f",
	},
	{
		action: "returnToSpawn",
		label: "Return to spawn",
		group: "Location Editor",
		defaultBinding: "r",
	},
	{ action: "pointNorth", label: "Point north", group: "Location Editor", defaultBinding: "n" },
	{
		action: "centerRoad",
		label: "Center toward nearest road direction",
		group: "Location Editor",
		defaultBinding: "b",
	},
	{ action: "zoomIn", label: "Zoom in", group: "Location Editor", defaultBinding: "+" },
	{ action: "zoomOut", label: "Zoom out", group: "Location Editor", defaultBinding: "-" },
	{
		action: "panoZoomReset",
		label: "Zoom all the way out",
		group: "Location Editor",
		defaultBinding: "0",
	},
	{
		action: "copyLink",
		label: "Copy Street View link",
		group: "Location Editor",
		defaultBinding: "Mod+c",
	},
	{
		action: "toggleCrosshair",
		label: "Toggle crosshair",
		group: "Location Editor",
		defaultBinding: "x",
	},
	{
		action: "toggleHideCar",
		label: "Toggle hide car",
		group: "Location Editor",
		defaultBinding: "Mod+h",
	},
	{
		action: "togglePanoUI",
		label: "Toggle pano UI",
		group: "Location Editor",
		defaultBinding: "h",
	},
	{
		action: "duplicateLocation",
		label: "Duplicate location",
		group: "Location Editor",
		defaultBinding: "c",
	},
	{
		action: "followRoad",
		label: "Follow linked panos along road",
		group: "Location Editor",
		defaultBinding: "g",
	},
	{
		action: "downloadPanoTile",
		label: "Download panorama",
		group: "Location Editor",
		defaultBinding: "Mod+Shift+s",
	},
	{
		action: "toggleFullscreenMap",
		label: "Toggle fullscreen map",
		group: "Global",
		defaultBinding: "Mod+\\",
	},
	{
		action: "nextPanoDate",
		label: "Next date cycle",
		group: "Location Editor",
		defaultBinding: "]",
	},
	{
		action: "prevPanoDate",
		label: "Previous date cycle",
		group: "Location Editor",
		defaultBinding: "[",
	},
	{ action: "spin180", label: "Spin 180°", group: "Location Editor", defaultBinding: "t" },
	{
		action: "refreshPano",
		label: "Refresh panorama",
		group: "Location Editor",
		defaultBinding: "Shift+r",
	},
	{
		action: "reviewNext",
		label: "Next location",
		group: "Review",
		defaultBinding: "Mod+ArrowRight",
	},
	{
		action: "reviewPrev",
		label: "Previous location",
		group: "Review",
		defaultBinding: "Mod+ArrowLeft",
	},
	{
		action: "panLeft",
		label: "Pan left",
		group: "Map Navigation",
		defaultBinding: "a",
		altSlow: true,
	},
	{
		action: "panRight",
		label: "Pan right",
		group: "Map Navigation",
		defaultBinding: "d",
		altSlow: true,
	},
	{ action: "panUp", label: "Pan up", group: "Map Navigation", defaultBinding: "w", altSlow: true },
	{
		action: "panDown",
		label: "Pan down",
		group: "Map Navigation",
		defaultBinding: "s",
		altSlow: true,
	},
	{
		action: "mapZoomIn",
		label: "Zoom in",
		group: "Map Navigation",
		defaultBinding: "Shift+w",
		altSlow: true,
	},
	{
		action: "mapZoomOut",
		label: "Zoom out",
		group: "Map Navigation",
		defaultBinding: "Shift+s",
		altSlow: true,
	},
	{
		action: "mapZoomBounds",
		label: "Zoom to bounds",
		group: "Map Navigation",
		defaultBinding: "Shift+b",
	},
	{
		action: "mapZoomReset",
		label: "Zoom all the way out",
		group: "Map Navigation",
		defaultBinding: "Shift+0",
	},
	{
		action: "panoLookLeft",
		label: "Look left",
		group: "Location Editor",
		defaultBinding: "ArrowLeft",
		altSlow: true,
	},
	{
		action: "panoLookRight",
		label: "Look right",
		group: "Location Editor",
		defaultBinding: "ArrowRight",
		altSlow: true,
	},
	{
		action: "panoLookUp",
		label: "Look up",
		group: "Location Editor",
		defaultBinding: "ArrowUp",
		altSlow: true,
	},
	{
		action: "panoLookDown",
		label: "Look down",
		group: "Location Editor",
		defaultBinding: "ArrowDown",
		altSlow: true,
	},
	{
		action: "panoMoveForward",
		label: "Move forward",
		group: "Location Editor",
		defaultBinding: "Shift+ArrowUp",
		altSlow: true,
	},
	{
		action: "panoMoveBackward",
		label: "Move backward",
		group: "Location Editor",
		defaultBinding: "Shift+ArrowDown",
		altSlow: true,
	},
	{
		action: "jumpForward",
		label: "Jump forward 100m",
		group: "Location Editor",
		defaultBinding: "}",
	},
	{
		action: "jumpBackward",
		label: "Jump backward 100m",
		group: "Location Editor",
		defaultBinding: "{",
	},
	{
		action: "panToLocation",
		label: "Pan map to location",
		group: "Location Editor",
		defaultBinding: "l",
	},
	{
		action: "viewportLock",
		label: "Lock viewport direction",
		group: "Location Editor",
		defaultBinding: "v",
	},
	{
		action: "countrySelect",
		label: "Hold + click for country (+Shift for subdivision)",
		group: "Global",
		defaultBinding: "q",
	},
	{
		action: "deletePolygon",
		label: "Hold + click to delete polygon",
		group: "Global",
		defaultBinding: "e",
	},
	{
		action: "mapZoomSelection",
		label: "Zoom to selection bounds",
		group: "Map Navigation",
		defaultBinding: "Shift+e",
	},
	{
		action: "toggleSelectOnly",
		label: "Toggle select-only mode",
		group: "Map Navigation",
		defaultBinding: "o",
	},
] as const satisfies readonly (Omit<HotkeyDef, "action"> & { action: string })[];

const RAW_HOTKEY_DEFS: HotkeyDef[] = [
	...STATIC_HOTKEY_DEFS,
	...QUICKTAG_SLOTS.map(
		(n): HotkeyDef => ({
			action: `quicktag${n}`,
			label: `Quick-tag slot ${n}`,
			group: "Quicktag",
			defaultBinding: String(n),
		}),
	),
];

// Unified view: raw defs + command-derived defs. This is what the shortcuts UI iterates.
export function getAllBindings(): HotkeyDef[] {
	const commandDefs: HotkeyDef[] = getCommands().map((cmd) => ({
		action: cmd.id as HotkeyAction,
		label: cmd.label,
		group: "Commands",
		defaultBinding: cmd.defaultBinding ?? "",
	}));
	return [...commandDefs, ...RAW_HOTKEY_DEFS];
}

const STORAGE_KEY = "hotkeyOverrides";

type HotkeyOverrides = Partial<Record<string, string>>;

let overrides: HotkeyOverrides = {};
try {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) overrides = JSON.parse(stored);
} catch {
	// ignored
}

function getDefaultBinding(action: string): string {
	for (const d of RAW_HOTKEY_DEFS) {
		if (d.action === action) return d.defaultBinding;
	}
	const cmd = getCommand(action);
	return cmd?.defaultBinding ?? "";
}

const { subscribe, getSnapshot, notify } = createSyncStore();

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
	localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
	notify();
}

// Assign `binding` to `action`, clearing it from any other actions that currently
// hold it so the binding becomes unique. Returns the actions that were cleared.
export function reassignBinding(action: HotkeyAction, binding: string): string[] {
	const cleared = getConflicts(action, binding).map((d) => d.action);
	for (const a of cleared) overrides[a] = "";
	overrides[action] = binding;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
	notify();
	return cleared;
}

export function resetBinding(action: HotkeyAction): void {
	delete overrides[action];
	localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
	notify();
}

export function resetAllBindings(): void {
	overrides = {};
	localStorage.removeItem(STORAGE_KEY);
	notify();
}

export function useBinding(action: HotkeyAction): string {
	useSyncExternalStore(subscribe, getSnapshot);
	return getBinding(action);
}
