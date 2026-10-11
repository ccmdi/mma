export type * from "@/bindings.consts";
export type * from "@/bindings.gen";
export type { ProcedureHost, ProcedureRequest, ProcedureResponse } from "@/lib/data/procedureHost";
import { Store } from "@/store/store";
import { Maps } from "@/store/maps";
import { Query } from "@/store/query";
import { Mutation } from "@/store/mutation";
import { SelectionList } from "@/store/selectionList";
import { Autosave } from "@/store/autosave";
import { Edit } from "@/store/edit";
import { Tag } from "@/store/tag";
import { Location } from "@/store/location";
import { Editor } from "@/store/editor";
import { History } from "@/store/history";
import { Commit } from "@/store/commit";
import { Field } from "@/store/field";
import { CommitDiff } from "@/store/commitDiff";
import { Import } from "@/store/import";
import { SavedSelection } from "@/store/savedSelection";
import { Scene } from "@/lib/render/scene";
import { MapHost } from "@/lib/map/host";
import * as consts from "@/bindings.consts";
import * as selectionOps from "@/store/selections";
import * as settings from "@/store/settings";
import * as picker from "@/store/selectorPick";
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

/** Pure transforms over the selection list behind the sidebar. @unstable */
type SelectionOpsApi = typeof selectionOps;
/** App settings and their option tables; the shape moves with every setting added. @unstable */
type SettingsApi = typeof settings;
/** The selector picker the pick dialogs share; its choices move with the UI. @unstable */
type SelectorPickApi = typeof picker;
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
/** Screen positions of the rendered markers. @unstable */
type ScenePositionsApi = typeof scenePositions;
/** Color conversion helpers. @unstable */
type ColorApi = typeof colorUtils;
type ToastApi = typeof toast;
/** The global job tray. @unstable */
type JobsApi = typeof jobs;
type UseJobApi = typeof useJob;
/** Compatibility bindings for flat plugin calls. */
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
		SelectionOpsApi,
		SettingsApi,
		SelectorPickApi,
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
	Autosave: typeof Autosave;
	/** Edit map locations, metadata, value records, and selections. */
	Edit: typeof Edit;
	/** Add, update, remove, and inspect map locations. */
	Location: typeof Location;
	/** Manage tag records and their assignment to locations. */
	Tag: typeof Tag;
	/** Open locations and change the editor pane. */
	Editor: typeof Editor;
	/** Navigate undo and redo history. */
	History: typeof History;
	/** Save and restore map versions. */
	Commit: typeof Commit;
	/** Rename or remove metadata fields across the map. */
	Field: typeof Field;
	/** Read the open map state and update its selection and metadata. */
	Store: Omit<typeof Store, "patch" | "merge" | "resetDerived">;
	/** Create, list, open, close, and organize maps. */
	Maps: typeof Maps;
	/** Read locations and summaries for a selector. */
	Query: typeof Query;
	/** Run mutations and wait for their state and display updates. */
	Mutation: typeof Mutation;
	/** Change the listed selections and inspect their active members. @unstable */
	SelectionList: typeof SelectionList;
	/** Uncommitted changes and their preview on the map. @unstable */
	CommitDiff: typeof CommitDiff;
	/** Stage, preview, and confirm an import into the open map. @unstable */
	Import: typeof Import;
	/** Saved selection rules. @unstable */
	SavedSelection: typeof SavedSelection;
	/** The marker scene the map surfaces render from, and its load lifecycle. @unstable */
	Scene: typeof Scene;
	/** The embedded map host, its preferences, and click interceptors. @unstable */
	MapHost: typeof MapHost;
}

export type { MMA as MMAApi };

const mma: MMA = {
	...consts,
	...selectionOps,
	...settings,
	...picker,
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
	Autosave,
	Edit,
	Location,
	Tag,
	Editor,
	History,
	Commit,
	Field,
	Store,
	Maps,
	Query,
	Mutation,
	SelectionList,
	CommitDiff,
	Import,
	SavedSelection,
	Scene,
	MapHost,
};

declare global {
	interface Window {
		MMA: MMA;
	}
	const MMA: MMA;
}

window.MMA = mma;

export default mma;
