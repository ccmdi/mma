// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/google-maps.d.ts" />

/**
 * Unified MMA API -- the single public surface for plugins, tests, and app code.
 * Exposed as `window.MMA` (and the global `MMA`).
 */

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
import * as scope from "@/plugins/scope";
import * as externals from "@/plugins/externals";
import * as sidecar from "@/plugins/sidecar";
import * as uiSurface from "@/components/primitives/ui";
import * as fieldDefs from "@/lib/data/fieldDefs";
import * as fieldDefRegistry from "@/lib/data/fieldDefRegistry";
import * as procedures from "@/lib/data/procedures";
import * as seen from "@/lib/seen/seen";
import * as panoSingleton from "@/lib/sv/panoSingleton";
import * as enrich from "@/lib/sv/enrich";
import * as pinPano from "@/lib/sv/pinPano";
import * as validate from "@/lib/sv/validate";
import * as query from "@/lib/sv/query";
import * as mapState from "@/lib/map/mapState";
import * as sceneStore from "@/lib/render/sceneStore";
import * as colorUtils from "@/lib/util/color";
import * as toast from "@/lib/util/toast";
import * as useJob from "@/lib/hooks/useJob";
import * as legacy from "@/legacy";
import * as testSurface from "@/testSurface";
import * as types from "@/types";
import * as util from "@/lib/util/util";

type ConstsApi = typeof consts;
type StoreApi = typeof store;
type SelectionOpsApi = typeof selectionOps;
type SavedSelectionsApi = typeof savedSelections;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
type SettingsApi = typeof settings;
/** Import dialog internals. @unstable */
type ImportStagingApi = typeof importStaging;
/** Commit diff internals. @unstable */
type CommitDiffApi = typeof commitDiff;
type SelectorPickApi = typeof picker;
type MapListApi = typeof mapList;
/** Review screen internals. @unstable */
type ReviewApi = typeof review;
/** The raw Rust command boundary; any of them can change in a release. @unstable */
type CommandsApi = typeof commands;
type TauriApi = typeof tauri;
type RegistryApi = typeof registry;
type ScopeApi = typeof scope;
type ExternalsApi = typeof externals;
type SidecarApi = typeof sidecar;
type UiApi = typeof uiSurface;
type FieldDefsApi = typeof fieldDefs;
type FieldDefRegistryApi = typeof fieldDefRegistry;
type ProceduresApi = typeof procedures;
type SeenApi = typeof seen;
/** The shared panorama viewer's internals. @unstable */
type PanoSingletonApi = typeof panoSingleton;
type EnrichApi = typeof enrich;
type PinPanoApi = typeof pinPano;
type ValidateApi = typeof validate;
type QueryApi = typeof query;
type MapStateApi = typeof mapState;
type SceneStoreApi = typeof sceneStore;
type ColorApi = typeof colorUtils;
type ToastApi = typeof toast;
type UseJobApi = typeof useJob;
/** Shims for removed APIs. @unstable */
type LegacyApi = typeof legacy;
/** @unstable */
type TestApi = typeof testSurface;
type TypesApi = typeof types;
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
		ScopeApi,
		ExternalsApi,
		SidecarApi,
		UiApi,
		FieldDefsApi,
		FieldDefRegistryApi,
		ProceduresApi,
		SeenApi,
		PanoSingletonApi,
		EnrichApi,
		PinPanoApi,
		ValidateApi,
		QueryApi,
		MapStateApi,
		SceneStoreApi,
		ColorApi,
		ToastApi,
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
	...scope,
	...externals,
	...sidecar,
	...uiSurface,
	...fieldDefs,
	...fieldDefRegistry,
	...procedures,
	...seen,
	...panoSingleton,
	...enrich,
	...pinPano,
	...validate,
	...query,
	...mapState,
	...sceneStore,
	...colorUtils,
	...toast,
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
