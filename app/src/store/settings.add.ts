import { useSyncExternalStore } from "react";

export type MovementMode = "moving" | "no-move" | "nmpz";
export type ExactDateFormat = "date" | "datetime";
export type DateTimezone = "location" | "utc";
export type SeenResolution = "low" | "medium" | "high";

export type MapListField = "locationCount" | "lastOpened" | "created";
export type GeocodeProvider = "local" | "nominatim";
export type TagViewMode = "flat" | "tree";

import type { SavedSelection } from "./savedSelections.add";

export interface AppSettings {
	showCameraBadges: boolean;
	showLinksControl: boolean;
	clickToGo: boolean;
	showRoadLabels: boolean;
	defaultMovementMode: MovementMode;
	showCar: boolean;
	showCrosshair: boolean;
	showCompass: boolean;
	showCompassTape: boolean;
	showZoom: boolean;
	showReturnToSpawn: boolean;
	showJumpButtons: boolean;
	showMapLinks: boolean;
	showCoordinateDisplay: boolean;
	showFullscreenButton: boolean;
	showPanoMetadata: boolean;
	showExactDate: boolean;
	exactDateFormat: ExactDateFormat;
	dateTimezone: DateTimezone;
	showNavArrow: boolean;
	showGroundArrow: boolean;
	hidePanoUI: boolean;
	fullscreenMap: boolean;
	showFullscreenMinimap: boolean;
	showFullscreenTagbar: boolean;
	customCss: string;
	enableSeen: boolean;
	enableSeenThumbnails: boolean;
	seenResolution: SeenResolution;
	mapPanSpeed: number;
	panoLookSpeed: number;
	slowModifier: number;
	showFps: boolean;
	mapListFields: MapListField[];
	geocodeProvider: GeocodeProvider;
	nominatimApiKey: string;
	tagViewMode: TagViewMode;
	savedSelections: SavedSelection[];
}

const DEFAULTS: AppSettings = {
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
	showExactDate: false,
	exactDateFormat: "date" as ExactDateFormat,
	dateTimezone: "location" as DateTimezone,
	showNavArrow: true,
	showGroundArrow: true,
	hidePanoUI: false,
	fullscreenMap: false,
	showFullscreenMinimap: true,
	showFullscreenTagbar: true,
	customCss: "",
	enableSeen: true,
	enableSeenThumbnails: true,
	seenResolution: "medium" as SeenResolution,
	mapPanSpeed: 6,
	panoLookSpeed: 3,
	slowModifier: 4,
	showFps: false,
	mapListFields: ["locationCount"],
	geocodeProvider: "local" as GeocodeProvider,
	nominatimApiKey: "",
	tagViewMode: "flat" as TagViewMode,
	savedSelections: [] as SavedSelection[],
};

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

let listeners: (() => void)[] = [];
let version = 0;

function subscribe(fn: () => void) {
	listeners.push(fn);
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

function notify() {
	version++;
	for (const fn of listeners) fn();
}

function getSnapshot() {
	return version;
}

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
