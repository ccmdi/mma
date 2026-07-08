import { useSyncExternalStore } from "react";
import { createSyncStore } from "@/lib/util/syncStore";
import type { SavedSelection } from "./savedSelections";
import type { TagSortMode } from "@/types";
import type { PinnedEntry } from "./commandDefs";
import type { RGB } from "@/lib/util/color";

export const MOVEMENT_MODES = {
	moving: "Moving",
	"no-move": "No Move",
	nmpz: "NMPZ",
} as const;
export const SEEN_RESOLUTIONS = {
	low: "Low (160x90)",
	medium: "Medium (320x180)",
	high: "High (640x360)",
} as const;
export const EXACT_DATE_FORMATS = {
	date: "Date only",
	datetime: "Date + time",
} as const;
export const DATE_TIMEZONES = {
	location: "Location timezone",
	utc: "UTC",
} as const;
export const MAP_LIST_FIELDS = {
	locationCount: "Location count",
	lastOpened: "Last opened",
	created: "Date created",
} as const;
export const GEOCODE_PROVIDERS = {
	local: "Local (offline)",
	nominatim: "Nominatim",
	google: "Google (from panorama)",
} as const;
export const GEOCODE_PROVIDER_LABELS: Record<keyof typeof GEOCODE_PROVIDERS, string> = {
	local: "Local reverse geocode",
	nominatim: "OpenStreetMap (Nominatim)",
	google: "Google Street View",
};
export const TAG_VIEW_MODES = {
	flat: "Flat",
	tree: "Tree",
} as const;
export const BORDER_DETAILS = {
	light: "Standard (bundled)",
	medium: "High (~10MB)",
	heavy: "Ultra (~46MB)",
} as const;
export const SUBDIVISION_DETAILS = {
	off: "Off",
	adm1: "States / provinces",
} as const;
/** Tag-suggestion list cap stops (slider indices); 0 = unlimited ("All"). */
export const TAG_SUGGESTION_LIMITS = [5, 10, 25, 50, 0] as const;
export const PREVIEW_ASPECT_RATIOS = {
	"4 / 3": "4:3",
	"16 / 10": "16:10",
	"16 / 9": "16:9",
	"21 / 9": "21:9",
	"32 / 9": "32:9",
	free: "Free",
} as const;

export type MovementMode = keyof typeof MOVEMENT_MODES;
export type ExactDateFormat = keyof typeof EXACT_DATE_FORMATS;
export type DateTimezone = keyof typeof DATE_TIMEZONES;
export type SeenResolution = keyof typeof SEEN_RESOLUTIONS;

export type MapListField = keyof typeof MAP_LIST_FIELDS;
export type GeocodeProvider = keyof typeof GEOCODE_PROVIDERS;
export type TagViewMode = keyof typeof TAG_VIEW_MODES;
export type BorderDetail = keyof typeof BORDER_DETAILS;
export type SubdivisionDetail = keyof typeof SUBDIVISION_DETAILS;
export type PreviewAspectRatio = keyof typeof PREVIEW_ASPECT_RATIOS;

const DEFAULTS = {
	showCameraBadges: true,
	showLinksControl: true,
	clickToGo: true,
	showRoadLabels: false,
	defaultMovementMode: "moving" as MovementMode,
	showCar: true,
	showCrosshair: false,
	showCompass: true,
	showCompassTape: false,
	showZoom: true,
	showReturnToSpawn: true,
	showJumpButtons: true,
	showMapLinks: true,
	showCoordinateDisplay: true,
	showFullscreenButton: true,
	showPanoMetadata: false,
	exactDateFormat: "date" as ExactDateFormat,
	dateTimezone: "location" as DateTimezone,
	showNavArrow: true,
	showGroundArrow: true,
	hidePanoUI: false,
	fullscreenMap: false,
	showFullscreenMinimap: true,
	fullscreenMinimapScale: 1,
	showFullscreenTagbar: true,
	showFullscreenDatePicker: true,
	customCss: "",
	enableSeen: true,
	enableSeenThumbnails: true,
	seenResolution: "medium" as SeenResolution,
	mapPanSpeed: 6,
	panoLookSpeed: 3,
	slowModifier: 4,
	showFps: false,
	mapListFields: ["locationCount"] as MapListField[],
	/** Reopen the maps that were open when the session last ended (main window closed). */
	restoreSession: true,
	/** Per-label color overrides (hex), keyed by lowercased label name. Shared across all maps. */
	labelColors: {} as Record<string, string>,
	geocodeProvider: "local" as GeocodeProvider,
	nominatimApiKey: "",
	panToImported: true,
	followActiveInReview: true,
	markerColor: { r: 42, g: 42, b: 42 } as RGB,
	activeLocationColor: { r: 200, g: 0, b: 0 } as RGB,
	importPreviewColor: { r: 217, g: 70, b: 239 } as RGB,
	panoDotColor: { r: 255, g: 0, b: 0 } as RGB,
	panoDotScaled: false,
	tagViewMode: "flat" as TagViewMode,
	/** Tree view only: render each tag as the shortest path suffix that's still unique. */
	truncateTagPaths: true,
	tagSortMode: "default" as TagSortMode,
	/** Gap between tag pills (px), shared by flat and tree views via `--tag-gap`. */
	tagGap: 6 as number,
	borderDetail: "light" as BorderDetail,
	subdivisionDetail: "off" as SubdivisionDetail,
	previewAspectRatio: "16 / 9" as PreviewAspectRatio,
	tagSuggestionLimit: 0 as number,
	savedSelections: [] as SavedSelection[],
	pinnedCommands: [
		"deselectAll",
		"selection-delete-locations",
		"review-selected",
		"review-sessions",
		"---",
		"select-unpanned",
		"select-untagged",
		"---",
		"find-duplicates",
		"filter-by-metadata",
		"---",
		"bulk-enrich",
	] as PinnedEntry[],
	hasSeenWelcome: false,
};
export type AppSettings = typeof DEFAULTS;

/** App settings mirrored to CSS custom properties on `:root`. Add an entry to expose a
 *  setting to CSS; `useCssVarSettings` (App.tsx) keeps them in sync reactively. */
export const CSS_VAR_SETTINGS: ReadonlyArray<
	readonly [cssVar: string, value: (s: AppSettings) => string]
> = [["--tag-gap", (s) => `${s.tagGap}px`]];

const STORAGE_KEY = "appSettings";

let settings: AppSettings = { ...DEFAULTS };
try {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		settings = { ...DEFAULTS, ...JSON.parse(stored) };
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	}
} catch {
	// ignored
}

const { subscribe, getSnapshot, notify } = createSyncStore();

export function getSettings(): AppSettings {
	return settings;
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
	settings = { ...settings, [key]: value };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	notify();
}

export function useSettings(): AppSettings {
	useSyncExternalStore(subscribe, getSnapshot);
	return settings;
}

export function useSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
	useSyncExternalStore(subscribe, getSnapshot);
	return settings[key];
}
