/** The global `MMA` object (also `window.MMA`). */

export type * from "@/bindings.consts";
export type * from "@/bindings.gen";
export type { ProcedureHost, ProcedureRequest, ProcedureResponse } from "@/lib/data/procedureHost";

import * as consts from "@/bindings.consts";
import * as store from "@/store/useMapStore";
import * as selectionOps from "@/store/selections";
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
import * as uiSurface from "@/components/primitives/ui";
import * as fieldDefs from "@/lib/data/fieldDefs";
import * as fieldDefRegistry from "@/lib/data/fieldDefRegistry";
import * as procedures from "@/lib/data/procedures";
import * as seen from "@/lib/seen/seen";
import * as panoSurface from "@/lib/sv/pano";
import * as enrich from "@/lib/sv/enrich";
import * as pinPano from "@/lib/sv/pinPano";
import * as validate from "@/lib/sv/validate";
import * as query from "@/lib/sv/query";
import * as mapState from "@/lib/map/mapState";
import * as sceneStore from "@/lib/render/sceneStore";
import * as colorUtils from "@/lib/util/color";
import * as toast from "@/lib/util/toast";
import * as jobs from "@/lib/jobs";
import * as useJob from "@/lib/hooks/useJob";
import * as legacy from "@/legacy";
import * as testSurface from "@/testSurface";
import * as types from "@/types";
import * as util from "@/lib/util/util";

type ConstsApi = typeof consts;
type StoreApi = typeof store;
/** Pure transforms over the selection list behind the sidebar. @unstable */
type SelectionOpsApi = typeof selectionOps;
/** Saved selection rules. @unstable */
type SavedSelectionsApi = typeof savedSelections;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
type SettingsApi = typeof settings;
/** Stage, preview, and confirm an import into the open map. @unstable */
type ImportStagingApi = typeof importStaging;
/** Uncommitted changes and their preview on the map. @unstable */
type CommitDiffApi = typeof commitDiff;
type SelectorPickApi = typeof picker;
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
type UiApi = typeof uiSurface;
type FieldDefsApi = typeof fieldDefs;
type FieldDefRegistryApi = typeof fieldDefRegistry;
/** Running procedures directly, outside a registered provider. @unstable */
type ProceduresApi = typeof procedures;
type SeenApi = typeof seen;
/** The shared panorama viewer. @unstable */
type PanoApi = typeof panoSurface;
type EnrichApi = typeof enrich;
type PinPanoApi = typeof pinPano;
type ValidateApi = typeof validate;
type QueryApi = typeof query;
type MapStateApi = typeof mapState;
type SceneStoreApi = typeof sceneStore;
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

export interface MMA
	extends
		ConstsApi,
		StoreApi,
		SelectionOpsApi,
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
		UiApi,
		FieldDefsApi,
		FieldDefRegistryApi,
		ProceduresApi,
		SeenApi,
		PanoApi,
		EnrichApi,
		PinPanoApi,
		ValidateApi,
		QueryApi,
		MapStateApi,
		SceneStoreApi,
		ColorApi,
		ToastApi,
		JobsApi,
		UseJobApi,
		TestApi,
		TypesApi,
		UtilApi,
		LegacyApi {}

export type { MMA as MMAApi };

const mma: MMA = {
	...consts,
	...store,
	...selectionOps,
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
	...uiSurface,
	...fieldDefs,
	...fieldDefRegistry,
	...procedures,
	...seen,
	...panoSurface,
	...enrich,
	...pinPano,
	...validate,
	...query,
	...mapState,
	...sceneStore,
	...colorUtils,
	...toast,
	...jobs,
	...useJob,
	...testSurface,
	...types,
	...util,
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
