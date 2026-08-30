// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/google-maps.d.ts" />

/**
 * Unified MMA API — the single public surface for plugins, tests, and app code.
 * Exposed as `window.MMA` (and the global `MMA`).
 */

import * as store from "@/store/useMapStore";
import * as importStaging from "@/store/importStaging";
import * as commitDiff from "@/store/commitDiff";
import * as picker from "@/store/selectorPick";
import * as mapList from "@/store/mapList";
import * as review from "@/lib/review/review";
import { cmd as commands, type Cmd } from "@/lib/commands";
import { createLocation } from "@/types";
import { registerPlugin, createPluginStorage, usePluginState } from "@/plugins/registry";
import { useJob } from "@/lib/hooks/useJob";
import { trackDisposable } from "@/plugins/scope";
import * as ui from "@/components/primitives";
import { toast } from "@/lib/util/toast";
import { preloadModules, getAvailableExternals } from "@/plugins/externals";
import { registerEnrichFields, registerEnrichmentProvider } from "@/lib/data/fieldDefs";
import { getFieldDef, getAllFieldDefs, getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { subscribe, type EditorEvent, type EventHandler } from "@/lib/events";
import { setSetting, getSettings } from "@/store/settings";
import {
	getSavedSelectionIndex,
	loadSavedSelections,
	savedParts,
	savedSelector,
} from "@/store/savedSelections";
import { getSeenEntries, getSeenCount, clearSeen } from "@/lib/seen/seen";
import { loadSeenPano } from "@/lib/sv/panoSingleton";
import { enrichAll, needsEnrichment } from "@/lib/sv/enrich";
import { bulkPinToPano } from "@/lib/sv/pinPano";
import { validateLocations } from "@/lib/sv/validate";
import { svMetadata } from "@/lib/sv/query";
import { mmaBufUrl } from "@/lib/util/util";
import { getMapHost, waitForMapHost } from "@/lib/map/mapState";
import { getScenePositions } from "@/lib/render/sceneStore";
import * as sidecar from "@/plugins/sidecar";
import * as legacy from "@/legacy";
import * as testApi from "@/testApi";

/** Explicitly exposed functions not in other APIs. */
const surface = {
	ready: false,

	/** Every Rust command, typed. Generated from the backend, so it tracks the app rather
	 *  than this API: a command can change or disappear in any release. Anything worth
	 *  relying on is exposed as a function here instead. @unstable */
	cmd: commands as Cmd,

	// --- Tauri primitives (for plugins) ---
	invoke,
	shell: { Command },
	dialog: { open: dialogOpen, save: dialogSave },

	/** Run work on the plugin's own sidecar binary, downloaded from GitHub Releases on
	 *  install. `request` streams the sidecar's JSON output and resolves with its last
	 *  object. */
	sidecar,

	// --- Bootstrap (for plugins) ---
	registerPlugin,
	registerEnrichFields,
	registerEnrichmentProvider,
	preloadModules,
	getAvailableExternals,

	// --- UI primitives (for plugins) ---
	ui,

	// --- Notifications ---
	toast,

	// --- Namespaced per-plugin storage ---
	storage: createPluginStorage,
	usePluginState,
	useJob,

	// --- Field definitions ---
	getFieldDef,
	getAllFieldDefs,
	getKnownFieldKeys,

	// --- Types ---
	createLocation,

	// --- Map host ---
	getMapHost,
	waitForMapHost,

	// --- Render ---
	getScenePositions,

	// --- Settings ---
	setSetting,
	getSettings: () => ({ ...getSettings() }),

	// --- Saved selections ---
	getSavedSelectionIndex,
	loadSavedSelections,
	savedParts,
	savedSelector,

	// --- Events (for plugins) ---
	on<E extends EditorEvent>(event: E, handler: EventHandler<E>) {
		const unsub = subscribe(event, handler);
		trackDisposable(unsub); // auto-removed on plugin deactivation
		return unsub;
	},

	// --- Seen ---
	getSeenEntries,
	getSeenCount,
	clearSeen,
	loadSeenPano,

	// --- Enrichment ---
	enrichAll,
	bulkPinToPano,
	validateLocations,
	needsEnrichment,

	// --- SV metadata ---
	svMetadata,

	// --- Util ---
	mmaBufUrl,

	// --- Test-only convenience ---
	/** @unstable */
	_test: testApi,
};

type StoreApi = typeof store;
/** One dialog's own state machine, exposed only because the surface is flat. @unstable */
type ImportStagingApi = typeof importStaging;
/** One dialog's own state machine, exposed only because the surface is flat. @unstable */
type CommitDiffApi = typeof commitDiff;
type SelectorPickApi = typeof picker;
type MapListApi = typeof mapList;
/** The review screen driving itself. @unstable */
type ReviewApi = typeof review;
type SurfaceApi = typeof surface;
type LegacyApi = typeof legacy;

export interface MMA
	extends
		StoreApi,
		ImportStagingApi,
		CommitDiffApi,
		SelectorPickApi,
		MapListApi,
		ReviewApi,
		SurfaceApi,
		LegacyApi {}

const mma: MMA = {
	...store,
	...importStaging,
	...commitDiff,
	...picker,
	...mapList,
	...review,
	...surface,
	...legacy,
};

declare global {
	interface Window {
		MMA: MMA;
	}
	const MMA: MMA;
}

window.MMA = mma;

export default mma;
