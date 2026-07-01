import { LOCATION_DATA_EVENTS, TAG_DATA_EVENTS } from "@/lib/events";
import { MapMakingWebApi, Remote } from "./map-making-web-api";
import { createSyncStore, type KeyValueStore, type SyncLink, type SyncStore } from "./syncStore";
import { createMappingBackend } from "./mappingBackend";
import { createScheduler, type Scheduler, type SyncStatus } from "./scheduler";
import { reconcile, type FirstSyncMode, type SyncOutcome } from "./engine";

const PROVIDER = "map-making.app";
const PLUGIN_ID = "map-making-sync";
const BASE_URL = "https://map-making.app";

const kv = (): KeyValueStore => window.MMA.storage(PLUGIN_ID);
const storeFor = (mapId: string): SyncStore =>
	createSyncStore(kv(), createMappingBackend(), PROVIDER, mapId);
const makeApi = (): MapMakingWebApi => new MapMakingWebApi({ apiKey: getApiKey() });

export const getApiKey = (): string => kv().get<string>("apiKey", "");
export const setApiKey = (key: string): void => kv().set("apiKey", key.trim());
export const currentMapId = (): string | null => window.MMA.getCurrentMap()?.meta.id ?? null;

export function getLink(): SyncLink | null {
	const id = currentMapId();
	return id ? storeFor(id).getLink() : null;
}

// Cache the validated identity so reopening the sidebar is instant
let cachedUser: Remote.User | null = null;
let cachedMaps: Remote.Map[] | null = null;
export const getCachedUser = (): Remote.User | null => cachedUser;
export const getCachedMaps = (): Remote.Map[] | null => cachedMaps;
/** Drop the cached identity (on key change). */
export const forgetAuth = (): void => {
	cachedUser = null;
	cachedMaps = null;
};

export async function validate(): Promise<Remote.User> {
	cachedUser = await makeApi().getUser();
	return cachedUser;
}
export async function listMaps(): Promise<Remote.Map[]> {
	cachedMaps = await makeApi().getMaps();
	return cachedMaps;
}

export function link(remoteMapId: number, remoteUserId: number | null): void {
	const id = currentMapId();
	if (!id) throw new Error("no map open");
	storeFor(id).setLink({
		localMapId: id,
		remoteMapId,
		remoteBaseUrl: BASE_URL,
		remoteUserId,
		linkedAt: new Date().toISOString(),
		lastSyncedAt: null,
	});
}

export async function unlink(): Promise<void> {
	const id = currentMapId();
	if (!id) return;
	stopLive();
	await storeFor(id).clear();
}

// Single in-flight guard shared by manual Sync-now AND the live loop, so two reconciles never
// overlap on the same map (which would double-create unmapped locals + race the mapping writes).
let syncing: Promise<SyncOutcome> | null = null;

function runReconcile(opts?: { firstSync?: FirstSyncMode }): Promise<SyncOutcome> {
	if (syncing) return syncing; // coalesce: hand back the run already in flight
	const id = currentMapId();
	if (!id) return Promise.reject(new Error("no map open"));
	syncing = reconcile(makeApi(), storeFor(id), opts).finally(() => {
		syncing = null;
	});
	return syncing;
}

export function syncNow(): Promise<SyncOutcome> {
	return runReconcile();
}

/** First sync after linking, with the seeding mode the user chose (merge / mirror). */
export function firstSync(mode: FirstSyncMode): Promise<SyncOutcome> {
	return runReconcile({ firstSync: mode });
}

/** Location count of the currently open local map (for the merge-vs-mirror prompt). */
export const localLocationCount = (): number => window.MMA.getCurrentMap()?.meta.locationCount ?? 0;

// --- Live loop ---

let scheduler: Scheduler | null = null;
let unsubs: (() => void)[] = [];
const statusListeners = new Set<(s: SyncStatus) => void>();

export const isLive = (): boolean => scheduler !== null;
export const onStatus = (fn: (s: SyncStatus) => void): (() => void) => {
	statusListeners.add(fn);
	return () => statusListeners.delete(fn);
};
export const liveStatus = (): SyncStatus => scheduler?.status() ?? "idle";

export function startLive(): void {
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
}

/** Tear down the running loop but KEEP the persisted pref, so map:open can auto-resume it.
 *  Used by the map-close teardown (a close is not the user turning sync off). */
export function pauseLive(): void {
	scheduler?.stop();
	scheduler = null;
	unsubs.forEach((u) => u());
	unsubs = [];
	statusListeners.forEach((l) => l("idle"));
}

/** Explicit user "off" (toggle/unlink): clear the persisted pref, then stop the loop. */
export function stopLive(): void {
	kv().set("live", false);
	pauseLive();
}

/** Whether the user left the live toggle on (persisted), so `activate` can auto-resume on open. */
export const livePref = (): boolean => kv().get<boolean>("live", false);
