// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types/google-maps.d.ts" />

/**
 * Unified MMA API — the single public surface for plugins, tests, and app code.
 * Exposed as `window.MMA` (and the global `MMA`).
 *
 * Store functions are spread directly — new store exports appear on MMA automatically.
 */

import * as store from "@/store/useMapStore";
import * as review from "@/lib/review/review";
import type { Scope, Location } from "@/bindings.gen";
import { cmd as commands } from "@/lib/commands";
import { goToMap, goToList } from "@/store/router";
import { createLocation } from "@/types";
import { registerPlugin, createPluginStorage, usePluginState } from "@/plugins/registry";
import { trackDisposable } from "@/plugins/scope";
import {
	Sidebar,
	Section,
	Field,
	EmptyState,
	SegmentedControl,
} from "@/components/primitives/Sidebar";
import { ScopeSelector } from "@/components/primitives/ScopeSelector";
import { toast } from "@/lib/util/toast";
import { preloadModules, getAvailableExternals } from "@/plugins/externals";
import { registerEnrichFields, registerEnrichmentProvider } from "@/lib/data/fieldDefs";
import { getFieldDef, getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Command } from "@tauri-apps/plugin-shell";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { getGoogleMap, waitForGoogleMap } from "@/lib/map/mapState";
import { subscribe, type EditorEvent, type EventHandler } from "@/lib/events";
import { setSetting, getSettings } from "@/store/settings";
import { getSeenEntries, getSeenCount, clearSeen } from "@/lib/seen/seen";
import { loadSeenPano } from "@/lib/sv/panoSingleton";
import { enrichAll, needsEnrichment } from "@/lib/sv/enrich";
import { bulkPinToPano } from "@/lib/sv/pinPano";
import { validateLocations } from "@/lib/sv/validate";
import { fetchSvMetadata } from "@/lib/sv/svMeta";
import { mmaBufUrl } from "@/lib/util/util";

export interface LocationStore {
	locations: Map<number, Location>;
	/** The materialized locations narrowed to a scope (defaults to all). */
	get(scope?: Scope): Location[];
	onChange(cb: () => void): () => void;
	destroy(): void;
}

async function createLocationStore(): Promise<LocationStore> {
	const locs = new Map<number, Location>();
	for (const l of await store.fetchAllLocations()) locs.set(l.id, l);

	const listeners = new Set<() => void>();
	const notify = () => {
		for (const cb of listeners) cb();
	};

	const unsubs = [
		subscribe("location:add", (added) => {
			for (const l of added) locs.set(l.id, l);
			notify();
		}),
		subscribe("location:remove", (ids) => {
			for (const id of ids) locs.delete(id);
			notify();
		}),
		subscribe("location:update", (updates) => {
			for (const u of updates) {
				const existing = locs.get(u.id);
				if (existing) locs.set(u.id, { ...existing, ...u.patch } as Location);
			}
			notify();
		}),
	];

	return {
		locations: locs,
		get(scope = { kind: "all" }) {
			return store.applyScope(scope, [...locs.values()]);
		},
		onChange(cb) {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		destroy() {
			unsubs.forEach((fn) => fn());
			listeners.clear();
			locs.clear();
		},
	};
}

/** A running sidecar process. Callbacks fire per line; listeners self-remove on exit. */
export interface SidecarRun {
	runId: number;
	onLine(cb: (line: string) => void): void;
	onStderr(cb: (line: string) => void): void;
	onExit(cb: (code: number | null) => void): void;
	kill(): void;
}

// Spawn an installed plugin sidecar. Event listeners attach BEFORE the process starts
// (no Rust-emitted line is missed); callers register onLine/onExit right after this resolves.
async function spawnSidecar(pluginId: string, name: string, args: string[]): Promise<SidecarRun> {
	const lineCbs: ((l: string) => void)[] = [];
	const errCbs: ((l: string) => void)[] = [];
	const exitCbs: ((c: number | null) => void)[] = [];
	let runId = -1;
	const unlisteners: UnlistenFn[] = [];
	const cleanup = () => {
		for (const u of unlisteners) u();
		unlisteners.length = 0;
	};

	unlisteners.push(
		await listen<{ runId: number; line: string }>("sidecar-stdout", (ev) => {
			if (ev.payload.runId === runId) for (const cb of lineCbs) cb(ev.payload.line);
		}),
	);
	unlisteners.push(
		await listen<{ runId: number; line: string }>("sidecar-stderr", (ev) => {
			if (ev.payload.runId === runId) for (const cb of errCbs) cb(ev.payload.line);
		}),
	);
	unlisteners.push(
		await listen<{ runId: number; code: number | null }>("sidecar-exit", (ev) => {
			if (ev.payload.runId !== runId) return;
			for (const cb of exitCbs) cb(ev.payload.code);
			cleanup();
		}),
	);

	try {
		runId = await commands.sidecarSpawn(pluginId, name, args);
	} catch (e) {
		cleanup();
		throw e;
	}
	return {
		runId,
		onLine: (cb) => lineCbs.push(cb),
		onStderr: (cb) => errCbs.push(cb),
		onExit: (cb) => exitCbs.push(cb),
		kill: () => void commands.sidecarKill(runId),
	};
}

const mma = {
	ready: false,

	// --- Store ---
	...store,

	// --- Review sessions ---
	...review,

	// --- Rust IPC commands ---
	cmd: commands,

	// --- Tauri primitives (for plugins) ---
	invoke,
	shell: { Command },
	dialog: { open: dialogOpen, save: dialogSave },

	// --- Sidecar binaries (distributed via GitHub Releases on install) ---
	sidecar: {
		installedVersion: (pluginId: string) => commands.sidecarInstalledVersion(pluginId),
		spawn: spawnSidecar,
	},

	// --- Bootstrap (for plugins) ---
	registerPlugin,
	registerEnrichFields,
	registerEnrichmentProvider,
	preloadModules,
	getAvailableExternals,
	createLocationStore,

	// --- UI primitives (for plugins) ---
	ui: { Sidebar, Section, Field, EmptyState, SegmentedControl, ScopeSelector },

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

	// --- Google Maps ---
	getGoogleMap: () => getGoogleMap(),
	waitForGoogleMap: () => waitForGoogleMap(),

	// --- Settings ---
	setSetting,
	getSettings: () => ({ ...getSettings() }),

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
	enrichAll: async (opts?: Record<string, unknown>) =>
		enrichAll(await store.fetchAllLocations(), opts),
	bulkPinToPano: async (opts?: Record<string, unknown>) =>
		bulkPinToPano(await store.fetchAllLocations(), opts),
	validateLocations,
	needsEnrichment,

	// --- SV metadata ---
	fetchSvMetadata,

	// --- Util ---
	mmaBufUrl,

	// --- Test-only convenience ---
	_test: {
		openMap: async (id: string) => {
			// Await the real store op for a deterministic completion signal, THEN sync the
			// URL — by which point the router's reconcile is a no-op (state already matches),
			// so no second fire-and-forget openMap can interleave with the next test step.
			await store.openMap(id);
			goToMap(id);
		},
		closeMap: async () => {
			await store.closeMap();
			goToList();
		},
		deleteMap: (id: string) => store.deleteMap(id),
		importPaste: async (text: string) => {
			await commands.storeImportPastePreview(text);
			const r = await commands.storeImportFile([], null);
			await store.mutate(Promise.resolve(r));
			return [r];
		},
		importFile: async (droppedFields: string[], tagName?: string) => {
			const r = await commands.storeImportFile(droppedFields, tagName ?? null);
			await store.mutate(Promise.resolve(r));
			return r;
		},
	},
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
