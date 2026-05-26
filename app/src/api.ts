// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/google-maps.d.ts" />

/**
 * Unified MMA API — the single public surface for plugins, tests, and app code.
 * Exposed as `window.MMA` (and the global `MMA`).
 *
 * Store functions are spread directly — new store exports appear on MMA automatically.
 */

import * as store from "@/store/useMapStore";
import { cmd as commands } from "@/lib/commands";
import { createLocation } from "@/types";
import type { Location } from "@/types";
import { registerPlugin } from "@/plugins/registry";
import {
	registerEnrichFields,
	registerEnrichmentProvider,
} from "@/lib/data/fieldDefs.add";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { getGoogleMap } from "@/lib/map/mapState";
import { subscribe, type EditorEvent } from "@/lib/events";
import { setSetting, getSettings } from "@/store/settings.add";
import {
	getSeenEntries,
	getSeenCount,
	clearSeen,
} from "@/lib/seen/seen.add";
import { loadSeenPano } from "@/components/editor/location/LocationPreview";
import { enrichAll, needsEnrichment } from "@/lib/sv/enrich.add";
import { bulkPinToPano } from "@/lib/sv/pinPano.add";
import { validateLocations } from "@/lib/sv/validate";

type Handler = (...args: unknown[]) => void;

const mma = {
	ready: false as boolean,

	// --- Store (map, locations, tags, selections, undo, review, import, etc.) ---
	...store,

	// --- Rust IPC commands ---
	cmd: commands,

	// --- Tauri primitives (for plugins) ---
	invoke,
	shell: { Command },
	dialog: { open: dialogOpen, save: dialogSave },

	// --- Bootstrap (for plugins) ---
	registerPlugin,
	registerEnrichFields,
	registerEnrichmentProvider,

	// --- Types ---
	createLocation,

	// --- Google Maps ---
	getGoogleMap: () => getGoogleMap(),

	// --- Settings ---
	setSetting,
	getSettings: () => ({ ...getSettings() }),

	// --- Events (for plugins) ---
	on(event: EditorEvent, handler: Handler) {
		return subscribe(event, handler);
	},

	// --- Seen ---
	getSeenEntries,
	getSeenCount,
	clearSeen,
	loadSeenPano,

	// --- Enrichment ---
	enrichAll: async (opts?: Record<string, unknown>) => enrichAll(await store.fetchAllLocations(), opts),
	bulkPinToPano: async (opts?: Record<string, unknown>) => bulkPinToPano(await store.fetchAllLocations(), opts),
	validateLocations,
	needsEnrichment: (loc: Pick<Location, "extra">) => needsEnrichment(loc as Location),
};

export type MMA = typeof mma;

declare global {
	interface Window {
		MMA: typeof mma;
	}
	const MMA: typeof mma;
}

window.MMA = mma;

export default mma;
