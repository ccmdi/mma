import { LOCATION_DATA_EVENTS, TAG_DATA_EVENTS } from "@/lib/events";
import type { IdentityKey } from "./diff";
import { reconcile, type FirstSyncMode, type ReconcileOptions, type SyncOutcome } from "./engine";
import { createMappingBackend } from "./mappingBackend";
import { createScheduler, type Scheduler, type SyncStatus } from "./scheduler";
import type { RemoteMapSummary, SyncProvider } from "./provider";
import { createSyncStore, type KeyValueStore, type SyncLink, type SyncStore } from "./syncStore";

export interface SyncController {
	readonly provider: { id: string; label: string };
	currentMapId(): string | null;
	getLink(): SyncLink | null;
	link(map: RemoteMapSummary, remoteUserId: string | null): void;
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
export function createSyncController<R>(
	provider: SyncProvider<R>,
	pluginId: string,
): SyncController {
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
			return inFlight.run.catch(() => undefined).then(() => runReconcile(opts, false));
		}
		if (inFlight) inFlight.abort.abort(); // a different map: the old run is moot
		const abort = new AbortController();
		const run = reconcile(provider, storeFor(id), { ...opts, signal: abort.signal }).finally(() => {
			if (inFlight?.run === run) inFlight = null;
		});
		inFlight = { mapId: id, run, abort };
		return run;
	}

	let scheduler: Scheduler | null = null;
	let unsubs: (() => void)[] = [];
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
		localLocationCount: () => window.MMA.getCurrentMap()?.meta.locationCount ?? 0,

		link(map, remoteUserId) {
			const id = currentMapId();
			if (!id) throw new Error("no map open");
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
			this.stopLive();
			await storeFor(id).clear();
		},

		syncNow: () => runReconcile(),
		firstSync: (mode) => runReconcile({ firstSync: mode }, false),
		resolveConflicts: (resolutions) =>
			runReconcile({ resolutions: new Map(resolutions.map((r) => [r.key, r.side])) }, false),

		isLive: () => scheduler !== null,
		livePref: () => kv().get<boolean>("live", false),
		liveStatus: () => scheduler?.status() ?? "idle",
		onStatus(fn) {
			statusListeners.add(fn);
			return () => statusListeners.delete(fn);
		},

		startLive() {
			const id = currentMapId();
			if (scheduler || !id || !storeFor(id).getLink()) return;
			kv().set("live", true);
			scheduler = createScheduler(async () => void (await runReconcile()), {
				onStatus: (s) => statusListeners.forEach((l) => l(s)),
			});
			unsubs = [...LOCATION_DATA_EVENTS, ...TAG_DATA_EVENTS].map((e) =>
				window.MMA.on(e, () => scheduler?.request()),
			);
			scheduler.start();
			void scheduler.runNow();
		},

		pauseLive,
		stopLive() {
			kv().set("live", false);
			pauseLive();
		},
	};
}
