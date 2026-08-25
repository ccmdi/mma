// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/google-maps.d.ts" />

/**
 * Unified MMA API — the single public surface for plugins, tests, and app code.
 * Exposed as `window.MMA` (and the global `MMA`).
 */

import * as store from "@/store/useMapStore";
import * as importStaging from "@/store/importStaging";
import * as commitDiff from "@/store/commitDiff";
import * as scope from "@/store/scope";
import * as mapList from "@/store/mapList";
import * as review from "@/lib/review/review";
import { events } from "@/bindings.gen";
import { cmd as commands, type Cmd } from "@/lib/commands";
import { createLocation } from "@/types";
import { registerPlugin, createPluginStorage, usePluginState } from "@/plugins/registry";
import { trackDisposable } from "@/plugins/scope";
import * as ui from "@/components/primitives";
import { toast } from "@/lib/util/toast";
import { preloadModules, getAvailableExternals } from "@/plugins/externals";
import { registerEnrichFields, registerEnrichmentProvider } from "@/lib/data/fieldDefs";
import { getFieldDef, getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { subscribe, type EditorEvent, type EventHandler } from "@/lib/events";
import { setSetting, getSettings } from "@/store/settings";
import { getSavedSelections, savedToSelectionProps, describeRule } from "@/store/savedSelections";
import { getSeenEntries, getSeenCount, clearSeen } from "@/lib/seen/seen";
import { loadSeenPano } from "@/lib/sv/panoSingleton";
import { enrichAll, needsEnrichment } from "@/lib/sv/enrich";
import { bulkPinToPano } from "@/lib/sv/pinPano";
import { validateLocations } from "@/lib/sv/validate";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { mmaBufUrl } from "@/lib/util/util";
import { getMapHost, waitForMapHost } from "@/lib/map/mapState";
import { getScene } from "@/lib/render/sceneStore";
import * as legacy from "@/legacy";
import * as testApi from "@/testApi";

// --- Sidecar requests ---
// One set of listeners for every request, demultiplexed by request id. Events can
// land before `sidecarRequest` learns its id (a resident-served request finishes in
// a millisecond), so unclaimed events are buffered until their caller arrives.

type SidecarEvent =
	| { kind: "line"; line: string }
	| { kind: "log"; line: string }
	| { kind: "done"; error: string | null };

const sidecarHandlers = new Map<number, (ev: SidecarEvent) => void>();
const sidecarPending = new Map<number, SidecarEvent[]>();
let sidecarListeners: Promise<void> | null = null;

function routeSidecarEvent(reqId: number, ev: SidecarEvent) {
	const handler = sidecarHandlers.get(reqId);
	if (handler) {
		handler(ev);
		return;
	}
	const buffered = sidecarPending.get(reqId);
	if (buffered) buffered.push(ev);
	else sidecarPending.set(reqId, [ev]);
}

function listenForSidecarEvents(): Promise<void> {
	sidecarListeners ??= (async () => {
		await events.sidecarLine.listen((ev) =>
			routeSidecarEvent(ev.payload.reqId, { kind: "line", line: ev.payload.line }),
		);
		await events.sidecarLog.listen((ev) =>
			routeSidecarEvent(ev.payload.reqId, { kind: "log", line: ev.payload.line }),
		);
		await events.sidecarDone.listen((ev) =>
			routeSidecarEvent(ev.payload.reqId, { kind: "done", error: ev.payload.error }),
		);
	})();
	return sidecarListeners;
}

export interface SidecarOptions<T> {
	/** Fires once per JSON object the sidecar emits, in order. */
	onLine?(item: T): void;
	/** Sidecar diagnostics (stderr), one-shot runs only. Resident-served commands
	 *  write theirs to the app log instead. */
	onLog?(line: string): void;
	signal?: AbortSignal;
}

/** Run one unit of work on a plugin's sidecar and resolve with its last emitted
 *  object (null if it emitted none). The app owns the process: commands the manifest
 *  lists under `serve` are answered by the plugin's resident sidecar, the rest by a
 *  one-shot run. `payload` is handed to the sidecar as JSON. */
async function sidecarRequest<T>(
	pluginId: string,
	command: string,
	payload?: unknown,
	opts?: SidecarOptions<T>,
): Promise<T | null> {
	await listenForSidecarEvents();
	const reqId = await commands.sidecarRequest(
		pluginId,
		command,
		payload === undefined ? null : JSON.stringify(payload),
	);

	return new Promise<T | null>((resolve, reject) => {
		let last: T | null = null;
		// Abort kills the run but leaves the handler installed, so the `done` that
		// follows still cleans up. Resident-served work has no process to kill.
		const onAbort = () => {
			commands.sidecarCancel(reqId).catch(() => {});
			reject(new DOMException(`Sidecar ${command} aborted`, "AbortError"));
		};
		sidecarHandlers.set(reqId, (ev) => {
			if (ev.kind === "line") {
				let item: T;
				try {
					item = JSON.parse(ev.line) as T;
				} catch {
					return;
				}
				last = item;
				opts?.onLine?.(item);
			} else if (ev.kind === "log") {
				opts?.onLog?.(ev.line);
			} else {
				sidecarHandlers.delete(reqId);
				opts?.signal?.removeEventListener("abort", onAbort);
				if (ev.error) reject(new Error(ev.error));
				else resolve(last);
			}
		});

		const buffered = sidecarPending.get(reqId);
		if (buffered) {
			sidecarPending.delete(reqId);
			for (const ev of buffered) sidecarHandlers.get(reqId)?.(ev);
		}

		if (opts?.signal?.aborted) onAbort();
		else opts?.signal?.addEventListener("abort", onAbort);
	});
}

/** Explicitly exposed functions not in other APIs. */
const surface = {
	ready: false,

	// --- Rust IPC commands ---
	cmd: commands as Cmd,

	// --- Tauri primitives (for plugins) ---
	invoke,
	shell: { Command },
	dialog: { open: dialogOpen, save: dialogSave },

	// --- Sidecar binaries (distributed via GitHub Releases on install) ---
	sidecar: {
		installedVersion: (pluginId: string) => commands.sidecarInstalledVersion(pluginId),
		request: sidecarRequest,
	},

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

	// --- Field definitions ---
	getFieldDef,
	getAllFieldDefs,

	// --- Types ---
	createLocation,

	// --- Map host ---
	getMapHost,
	waitForMapHost,

	/** Snapshot of every rendered location: `ids` plus interleaved `[lng, lat, ...]`, read
	 *  from the render buffers the app already keeps current. The way for an overlay that
	 *  draws all locations to see the map without a store round trip; refresh on
	 *  `scene:changed`. */
	getScenePositions(): { ids: Uint32Array; positions: Float32Array } {
		const scene = getScene();
		const ids = new Uint32Array(scene.totalCount);
		const positions = new Float32Array(scene.totalCount * 2);
		let n = 0;
		scene.forEachPosition((id, lng, lat) => {
			ids[n] = id;
			positions[n * 2] = lng;
			positions[n * 2 + 1] = lat;
			n++;
		});
		return { ids, positions };
	},

	// --- Settings ---
	setSetting,
	getSettings: () => ({ ...getSettings() }),

	// --- Saved selections ---
	getSavedSelections,
	savedToSelectionProps,
	describeRule,

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
	fetchSvMetadata,

	// --- Util ---
	mmaBufUrl,

	// --- Test-only convenience ---
	_test: testApi,
};

type StoreApi = typeof store;
type ImportStagingApi = typeof importStaging;
type CommitDiffApi = typeof commitDiff;
type ScopeApi = typeof scope;
type MapListApi = typeof mapList;
type ReviewApi = typeof review;
type SurfaceApi = typeof surface;
type LegacyApi = typeof legacy;

export interface MMA
	extends
		StoreApi,
		ImportStagingApi,
		CommitDiffApi,
		ScopeApi,
		MapListApi,
		ReviewApi,
		SurfaceApi,
		LegacyApi {}

const mma: MMA = {
	...store,
	...importStaging,
	...commitDiff,
	...scope,
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
