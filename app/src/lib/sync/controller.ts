import { LOCATION_DATA_EVENTS, TAG_DATA_EVENTS } from "@/lib/events";
import { reconcile, type FirstSyncMode, type ReconcileOptions, type SyncOutcome } from "./engine";
import { createMappingBackend } from "./mappingBackend";
import { createScheduler, type Scheduler, type SyncStatus } from "./scheduler";
import type { RemoteMapSummary, SyncProvider } from "./provider";
import {
	createSyncStore,
	type IdentityKey,
	type KeyValueStore,
	type SyncLink,
	type SyncStore,
} from "./syncStore";

export interface SyncController {
	readonly provider: { id: string; label: string };
	currentMapId(): string | null;
	getLink(): SyncLink | null;
	/** Web URL of the linked remote map, or null when unlinked. */
	remoteMapUrl(): string | null;
	link(map: RemoteMapSummary, remoteUserId: string | null): Promise<void>;
	unlink(): Promise<void>;
	syncNow(): Promise<SyncOutcome>;
	/** First sync after linking, with the seeding mode the user chose. */
	firstSync(mode: FirstSyncMode): Promise<SyncOutcome>;
	/** Re-sync with a winner picked for each conflicted key, so those keys stop re-conflicting. */
	resolveConflicts(
		resolutions: { key: IdentityKey; side: "local" | "remote" }[],
	): Promise<SyncOutcome>;
	localLocationCount(): number;

	isLive(): boolean;
	livePref(): boolean;
	liveStatus(): SyncStatus;
	/** Why the last live sync failed. Survives the loop stopping; cleared by the next success. */
	liveError(): string | null;
	onStatus(fn: (s: SyncStatus) => void): () => void;
	startLive(): void;
	/** Tear the loop down but KEEP the persisted pref, so `map:open` can auto-resume it. */
	pauseLive(): void;
	/** Explicit user "off": clear the pref, then stop. */
	stopLive(): void;
}

/**
 * Per-provider sync controller: owns the link, the in-flight guard and the live loop for
 * whichever map is currently open. Everything provider-specific arrives via {@link SyncProvider}.
 */
export function createSyncController(provider: SyncProvider, pluginId: string): SyncController {
	const kv = (): KeyValueStore => window.MMA.storage(pluginId);
	const storeFor = (mapId: string): SyncStore =>
		createSyncStore(kv(), createMappingBackend(), provider.id, mapId);
	const currentMapId = (): string | null => window.MMA.getCurrentMap()?.meta.id ?? null;

	const getLink = (): SyncLink | null => {
		const id = currentMapId();
		return id ? storeFor(id).getLink() : null;
	};

	// One reconcile at a time, PER MAP. Keying by map id matters: a run still finishing for the
	// map you just closed must not be handed back as the result for the map you just opened.
	let inFlight: { mapId: string; run: Promise<SyncOutcome>; abort: AbortController } | null = null;

	/**
	 * `coalesce` hands back a run already going for this map instead of starting another, which is
	 * what a poll tick or a second Sync-now click wants. A run carrying instructions the in-flight
	 * one does not have (a mirror mode, conflict resolutions) must NOT coalesce -- it would report
	 * someone else's result and silently drop the instruction.
	 */
	function runReconcile(
		opts?: Omit<ReconcileOptions, "signal">,
		coalesce = true,
	): Promise<SyncOutcome> {
		const id = currentMapId();
		if (!id) return Promise.reject(new Error("no map open"));
		if (inFlight?.mapId === id) {
			if (coalesce) return inFlight.run;
			// Queue behind it: two reconciles on one map would double-create unmapped locations.
			// These opts (mirror mode, resolutions) belong to `id`; bail if the map changed.
			return inFlight.run
				.catch(() => undefined)
				.then(() => {
					if (currentMapId() !== id) throw new Error("map changed before sync could run");
					return runReconcile(opts, false);
				});
		}
		if (inFlight) inFlight.abort.abort(); // a different map: the old run is moot
		const abort = new AbortController();
		const run = reconcile(provider, storeFor(id), {
			...opts,
			signal: abort.signal,
		}).finally(() => {
			if (inFlight?.run === run) inFlight = null;
		});
		inFlight = { mapId: id, run, abort };
		return run;
	}

	let scheduler: Scheduler | null = null;
	let unsubs: (() => void)[] = [];
	let liveError: string | null = null;
	const statusListeners = new Set<(s: SyncStatus) => void>();

	const pauseLive = () => {
		scheduler?.stop();
		scheduler = null;
		unsubs.forEach((u) => u());
		unsubs = [];
		inFlight?.abort.abort();
		statusListeners.forEach((l) => l("idle"));
	};

	return {
		provider: { id: provider.id, label: provider.label },
		currentMapId,
		getLink,
		remoteMapUrl() {
			const link = getLink();
			return link ? provider.remoteMapUrl(link.remoteMapId) : null;
		},
		localLocationCount: () => window.MMA.getCurrentMap()?.meta.locationCount ?? 0,

		async link(map, remoteUserId) {
			const id = currentMapId();
			if (!id) throw new Error("no map open");
			// Drop any stale mapping rows a prior link left behind before seeding the new link.
			await storeFor(id).clear();
			storeFor(id).setLink({
				localMapId: id,
				remoteMapId: map.id,
				remoteMapName: map.name,
				remoteUserId,
				linkedAt: new Date().toISOString(),
				lastSyncedAt: null,
			});
		},

		async unlink() {
			const id = currentMapId();
			if (!id) return;
			// The in-flight run persists rows + the link at its very end, past its last abort
			// checkpoint. Let it settle before clearing, or it resurrects what we just removed.
			const pending = inFlight?.run;
			this.stopLive();
			await pending?.catch(() => undefined);
			await storeFor(id).clear();
		},

		syncNow: () => runReconcile(),
		firstSync: (mode) => runReconcile({ firstSync: mode }, false),
		resolveConflicts: (resolutions) =>
			runReconcile({ resolutions: new Map(resolutions.map((r) => [r.key, r.side])) }, false),

		isLive: () => scheduler !== null,
		livePref: () => {
			const id = currentMapId();
			return id ? kv().get<boolean>(`live:${id}`, false) : false;
		},
		liveStatus: () => scheduler?.status() ?? "idle",
		liveError: () => liveError,
		onStatus(fn) {
			statusListeners.add(fn);
			return () => statusListeners.delete(fn);
		},

		startLive() {
			const id = currentMapId();
			if (scheduler || !id || !storeFor(id).getLink()) return;
			kv().set(`live:${id}`, true);
			liveError = null;
			scheduler = createScheduler(
				async () => {
					try {
						await runReconcile();
						liveError = null;
					} catch (e) {
						// The Rust reconcile marks auth failures with an "auth: " prefix; show it clean.
						liveError = (e instanceof Error ? e.message : String(e)).replace(/^auth: /, "");
						// A dead credential never heals by retrying; stop the loop, keep the pref.
						if (provider.isAuthError?.(e)) pauseLive();
						throw e;
					}
				},
				{
					// Every pass re-downloads the whole remote side, so on big maps an edit burst
					// should coalesce into few passes: scale the quiet period with map size.
					debounceMs: Math.min(30_000, Math.max(1500, this.localLocationCount() / 100)),
					onStatus: (s) => statusListeners.forEach((l) => l(s)),
				},
			);
			unsubs = [...LOCATION_DATA_EVENTS, ...TAG_DATA_EVENTS].map((e) =>
				window.MMA.on(e, () => scheduler?.request()),
			);
			scheduler.start();
			void scheduler.runNow();
		},

		pauseLive,
		stopLive() {
			const id = currentMapId();
			if (id) kv().set(`live:${id}`, false);
			pauseLive();
		},
	};
}
