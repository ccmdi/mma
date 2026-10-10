export type * from "@/bindings.consts";
export type * from "@/bindings.gen";
export type { ProcedureHost, ProcedureRequest, ProcedureResponse } from "@/lib/data/procedureHost";

import * as consts from "@/bindings.consts";
import * as store from "@/store/useMapStore";
import * as autosave from "@/store/autosave";
import * as edit from "@/store/edit";
import * as selectionOps from "@/store/selections";
import * as selectionActions from "@/store/selectionActions";
import * as savedSelections from "@/store/savedSelections";
import * as settings from "@/store/settings";
import * as importStaging from "@/store/importStaging";
import * as commitDiff from "@/store/commitDiff";
import * as picker from "@/store/selectorPick";
import * as mapList from "@/store/mapList";
import * as review from "@/lib/review/review";
import * as commands from "@/lib/commands";
import * as tauri from "@/lib/tauri";
import * as registry from "@/plugins/registry";
import * as pluginHost from "@/plugins/pluginHost";
import * as marketplace from "@/plugins/marketplace";
import * as pluginStorage from "@/plugins/pluginStorage";
import * as scope from "@/plugins/scope";
import * as pluginEvents from "@/plugins/pluginEvents";
import * as externals from "@/plugins/externals";
import * as sidecar from "@/plugins/sidecar";
import * as primitives from "@/components/primitives";
import * as fieldDefs from "@/lib/data/fieldDefs";
import * as fieldDefRegistry from "@/lib/data/fieldDefRegistry";
import * as fieldProjections from "@/lib/data/fieldProjections";
import * as procedures from "@/lib/data/procedures";
import * as seen from "@/lib/seen/seen";
import * as seenRecorder from "@/lib/seen/seenRecorder";
import * as panoSurface from "@/lib/sv/pano";
import * as enrich from "@/lib/sv/enrich";
import * as providers from "@/lib/sv/providers";
import * as pinPano from "@/lib/sv/pinPano";
import * as validate from "@/lib/sv/validate";
import * as validationCategories from "@/lib/sv/validationCategories";
import * as query from "@/lib/sv/query";
import * as mapState from "@/lib/map/mapState";
import * as sceneStore from "@/lib/render/sceneStore";
import * as scenePositions from "@/lib/render/scenePositions";
import * as colorUtils from "@/lib/util/color";
import * as toast from "@/lib/util/toast";
import * as jobs from "@/lib/jobs";
import * as useJob from "@/lib/hooks/useJob";
import * as legacy from "@/legacy";
import * as testSurface from "@/testSurface";
import * as types from "@/types";
import * as util from "@/lib/util/util";
import * as tags from "@/lib/data/tags";

type ConstsApi = typeof consts;
type StoreApi = typeof store;

/** Pure transforms over the selection list behind the sidebar. @unstable */
type SelectionOpsApi = typeof selectionOps;
/** Editing the selection list the way the sidebar does. @unstable */
type SelectionActionsApi = typeof selectionActions;
/** Saved selection rules. @unstable */
type SavedSelectionsApi = typeof savedSelections;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
type SettingsApi = typeof settings;
/** Stage, preview, and confirm an import into the open map. @unstable */
type ImportStagingApi = typeof importStaging;
/** Uncommitted changes and their preview on the map. @unstable */
type CommitDiffApi = typeof commitDiff;
/** The selector picker the pick dialogs share; its choices move with the UI. @unstable */
type SelectorPickApi = typeof picker;
/** The cached map list and its refresh. @unstable */
type MapListApi = typeof mapList;
/** Review sessions and their history. @unstable */
type ReviewApi = typeof review;
/** The raw command layer under the app-level API; any of them can change in a release. @unstable */
type CommandsApi = typeof commands;
/** Raw command, shell, and file dialog access. @unstable */
type TauriApi = typeof tauri;
type RegistryApi = typeof registry;
/** Enabling plugins and their activation lifecycle. @unstable */
type PluginHostApi = typeof pluginHost;
/** The plugin marketplace and its update checks. @unstable */
type MarketplaceApi = typeof marketplace;
type PluginStorageApi = typeof pluginStorage;
/** Which plugin owns a registration, and its teardown. @unstable */
type ScopeApi = typeof scope;
type PluginEventsApi = typeof pluginEvents;
type ExternalsApi = typeof externals;
type SidecarApi = typeof sidecar;
type FieldDefsApi = typeof fieldDefs;
type FieldDefRegistryApi = typeof fieldDefRegistry;
/** The keys a field can be grouped by. @unstable */
type FieldProjectionsApi = typeof fieldProjections;
/** Running procedures directly, outside a registered provider. @unstable */
type ProceduresApi = typeof procedures;
/** The seen-location history. @unstable */
type SeenApi = typeof seen;
/** How the app records panorama visits into the seen history. @unstable */
type SeenRecorderApi = typeof seenRecorder;
/** The shared panorama viewer. @unstable */
type PanoApi = typeof panoSurface;
/** Enrichment passes over the open map. @unstable */
type EnrichApi = typeof enrich;
/** The providers the app registers for enrichment. @unstable */
type ProvidersApi = typeof providers;
/** Bulk pinning locations to their panoramas. @unstable */
type PinPanoApi = typeof pinPano;
/** Coverage validation passes. @unstable */
type ValidateApi = typeof validate;
/** The validation categories users pick from, over the flags a check answers. @unstable */
type ValidationCategoriesApi = typeof validationCategories;
type QueryApi = typeof query;
/** The embedded map host, its preferences, and click interceptors. @unstable */
type MapStateApi = typeof mapState;
/** The marker scene the map surfaces render from, and its load lifecycle. @unstable */
type SceneStoreApi = typeof sceneStore;
/** Screen positions of the rendered markers. @unstable */
type ScenePositionsApi = typeof scenePositions;
/** Color conversion helpers. @unstable */
type ColorApi = typeof colorUtils;
type ToastApi = typeof toast;
/** The global job tray. @unstable */
type JobsApi = typeof jobs;
type UseJobApi = typeof useJob;
/** Shims for removed APIs. @unstable */
type LegacyApi = typeof legacy;
/** @unstable */
type TestApi = typeof testSurface;
type TypesApi = typeof types;
/** General-purpose helpers. @unstable */
type UtilApi = typeof util;
type TagsApi = typeof tags;

/** The global `MMA` object (also `window.MMA`). */
export interface MMA
	extends
		ConstsApi,
		StoreApi,
		SelectionOpsApi,
		SelectionActionsApi,
		SavedSelectionsApi,
		SettingsApi,
		ImportStagingApi,
		CommitDiffApi,
		SelectorPickApi,
		MapListApi,
		ReviewApi,
		CommandsApi,
		TauriApi,
		RegistryApi,
		PluginHostApi,
		MarketplaceApi,
		PluginStorageApi,
		ScopeApi,
		PluginEventsApi,
		ExternalsApi,
		SidecarApi,
		FieldDefsApi,
		FieldDefRegistryApi,
		FieldProjectionsApi,
		ProceduresApi,
		SeenApi,
		SeenRecorderApi,
		PanoApi,
		EnrichApi,
		ProvidersApi,
		PinPanoApi,
		ValidateApi,
		ValidationCategoriesApi,
		QueryApi,
		MapStateApi,
		SceneStoreApi,
		ScenePositionsApi,
		ColorApi,
		ToastApi,
		JobsApi,
		UseJobApi,
		TestApi,
		TypesApi,
		UtilApi,
		TagsApi,
		LegacyApi {
	/** Shared UI primitives for plugin sidebars and dialogs. */
	ui: typeof primitives;
	/** Debounced persistence of the open map: schedule, hold, cancel, or flush it. */
	autosave: typeof autosave;
	/** Edit map locations, metadata, value records, and selections. */
	edit: typeof edit;
}

export type { MMA as MMAApi };

const mma: MMA = {
	...consts,
	...store,
	...selectionOps,
	...selectionActions,
	...savedSelections,
	...settings,
	...importStaging,
	...commitDiff,
	...picker,
	...mapList,
	...review,
	...commands,
	...tauri,
	...registry,
	...pluginHost,
	...marketplace,
	...pluginStorage,
	...scope,
	...pluginEvents,
	...externals,
	...sidecar,
	ui: primitives,
	...fieldDefs,
	...fieldDefRegistry,
	...fieldProjections,
	...procedures,
	...seen,
	...seenRecorder,
	...panoSurface,
	...enrich,
	...providers,
	...pinPano,
	...validate,
	...validationCategories,
	...query,
	...mapState,
	...sceneStore,
	...scenePositions,
	...colorUtils,
	...toast,
	...jobs,
	...useJob,
	...testSurface,
	...types,
	...util,
	...tags,
	...legacy,
	autosave,
	edit,
};

declare global {
	interface Window {
		MMA: MMA;
	}
	const MMA: MMA;
}

window.MMA = mma;

export default mma;
