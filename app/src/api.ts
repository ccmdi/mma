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
import { createFieldDef, createLocation } from "@/types";
import { registerPlugin, createPluginStorage, usePluginState } from "@/plugins/registry";
import { useJob } from "@/lib/hooks/useJob";
import { trackDisposable } from "@/plugins/scope";
import * as ui from "@/components/primitives";
import { toast } from "@/lib/util/toast";
import { preloadModules, getAvailableExternals } from "@/plugins/externals";
import { registerEnrichFields, registerProvider } from "@/lib/data/fieldDefs";
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

/** Tauri primitives, handed to plugins as-is. */
const tauri = {
	invoke,
	shell: { Command },
	dialog: { open: dialogOpen, save: dialogSave },
};

/** Registering a plugin and the per-plugin runtime it gets. */
const plugin = {
	registerPlugin,
	storage: createPluginStorage,
	usePluginState,
	useJob,
	preloadModules,
	getAvailableExternals,
};

/** Field definitions: what a location can carry beyond its columns. */
const fields = {
	getFieldDef,
	getAllFieldDefs,
	getKnownFieldKeys,
	createFieldDef,
	registerEnrichFields,
	registerProvider,
};

/** Panoramas the user has already seen. */
const seen = {
	getSeenEntries,
	getSeenCount,
	clearSeen,
	loadSeenPano,
};

/** Street View: filling locations in from Google, and checking them against it. */
const sv = {
	enrichAll,
	bulkPinToPano,
	validateLocations,
	needsEnrichment,
	svMetadata,
};

/** The live map and what it is currently drawing. */
const map = {
	getMapHost,
	waitForMapHost,
	getScenePositions,
};

/** Selections saved on the map, and the rules behind them. */
const saved = {
	getSavedSelectionIndex,
	loadSavedSelections,
	savedParts,
	savedSelector,
};

/** App settings. Per-map settings live on `MapMeta.settings`. */
const settings = {
	setSetting,
	getSettings: () => ({ ...getSettings() }),
};

/** What belongs to no single domain. */
const surface = {
	ready: false,

	/** Every Rust command, typed. Any of them can change in a release. @unstable */
	cmd: commands as Cmd,

	/** Run work on the plugin's own sidecar binary. */
	sidecar,

	/** React components the editor is built from. */
	ui,

	toast,
	createLocation,
	mmaBufUrl,

	/** Subscribe to an editor event. The returned unsubscribe also runs when the plugin
	 *  deactivates. */
	on<E extends EditorEvent>(event: E, handler: EventHandler<E>) {
		const unsub = subscribe(event, handler);
		trackDisposable(unsub);
		return unsub;
	},

	/** @unstable */
	_test: testApi,
};

type StoreApi = typeof store;
/** Import dialog internals. @unstable */
type ImportStagingApi = typeof importStaging;
/** Commit diff internals. @unstable */
type CommitDiffApi = typeof commitDiff;
type SelectorPickApi = typeof picker;
type MapListApi = typeof mapList;
/** Review screen internals. @unstable */
type ReviewApi = typeof review;
type TauriApi = typeof tauri;
type PluginApi = typeof plugin;
type FieldsApi = typeof fields;
type SeenApi = typeof seen;
type SvApi = typeof sv;
type MapApi = typeof map;
type SavedSelectionsApi = typeof saved;
type SettingsApi = typeof settings;
type SurfaceApi = typeof surface;
/** Shims for removed APIs: they serve plugins built before the support floor and are
 *  never a promise to newer ones -- each dies when the floor passes its removal. @unstable */
type LegacyApi = typeof legacy;

export interface MMA
	extends
		StoreApi,
		ImportStagingApi,
		CommitDiffApi,
		SelectorPickApi,
		MapListApi,
		ReviewApi,
		TauriApi,
		PluginApi,
		FieldsApi,
		SeenApi,
		SvApi,
		MapApi,
		SavedSelectionsApi,
		SettingsApi,
		SurfaceApi,
		LegacyApi {}

const mma: MMA = {
	...store,
	...importStaging,
	...commitDiff,
	...picker,
	...mapList,
	...review,
	...tauri,
	...plugin,
	...fields,
	...seen,
	...sv,
	...map,
	...saved,
	...settings,
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
