// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { SyncReconcileResult } from "@/bindings.gen";
import { createSyncController } from "@/lib/sync/controller";
import type { SyncProvider } from "@/lib/sync/provider";
import type { RemoteMappingRow } from "@/lib/sync/syncStore";

const PLUGIN = "test-plugin";
const REMOTE = { id: "r1", name: "Remote", locationCount: 0 };

/** Empty reconcile result: nothing to push, pull, or hold. */
const EMPTY_RESULT: SyncReconcileResult = {
	pushed: { create: 0, update: 0, delete: 0 },
	pulled: { create: 0, update: 0, delete: 0 },
	adopted: 0,
	conflicts: [],
	neededTags: [],
	pullCreates: [],
	pullUpdates: [],
	pullDeleteIds: [],
	mirrorLocalDeleteIds: [],
};

// --- fake window.MMA -------------------------------------------------------

/** In-memory MMA with a KV store, the row-oriented mapping backend, and a gated syncReconcile. */
function makeMma() {
	const storage = new Map<string, unknown>();
	const mapping = new Map<string, RemoteMappingRow[]>(); // key = `${provider}:${mapId}`
	let mapId: string | null = "map-a";
	let gate: Promise<void> | null = null;
	let release: (() => void) | null = null;

	const kv = {
		get: <T>(k: string, fallback?: T): T =>
			storage.has(k) ? (storage.get(k) as T) : (fallback as T),
		set: (k: string, v: unknown) => void storage.set(k, v),
		remove: (k: string) => void storage.delete(k),
	};

	const api = {
		storage: () => kv,
		getCurrentMap: () => (mapId ? { meta: { id: mapId, locationCount: 0, tags: {} } } : null),
		createLocation: (p: unknown) => p,
		addLocations: async () => {},
		updateLocations: async () => {},
		removeLocations: async () => {},
		createTags: async () => [],
		on: () => () => {},
		cmd: {
			syncReconcile: async (): Promise<SyncReconcileResult> => {
				if (gate) await gate;
				return EMPTY_RESULT;
			},
			remoteMappingGet: async (provider: string, id: string) =>
				(mapping.get(`${provider}:${id}`) ?? []).map((r) => ({ ...r })),
			remoteMappingUpsert: async (provider: string, id: string, rows: RemoteMappingRow[]) => {
				const key = `${provider}:${id}`;
				const t = new Map((mapping.get(key) ?? []).map((r) => [r.localId, r] as const));
				for (const r of rows) t.set(r.localId, { ...r });
				mapping.set(key, [...t.values()]);
			},
			remoteMappingDelete: async (provider: string, id: string, ids: number[]) => {
				const key = `${provider}:${id}`;
				mapping.set(
					key,
					(mapping.get(key) ?? []).filter((r) => !ids.includes(r.localId)),
				);
			},
			remoteMappingClear: async (provider: string, id: string) => {
				mapping.delete(`${provider}:${id}`);
			},
		},
	};

	return {
		storage,
		mapping,
		install: () => {
			(window as unknown as { MMA: unknown }).MMA = api;
		},
		setMapId: (id: string | null) => {
			mapId = id;
		},
		block: () => {
			gate = new Promise<void>((r) => (release = r));
		},
		release: () => release?.(),
	};
}

// --- fake provider ---------------------------------------------------------

function makeProvider(): SyncProvider {
	return {
		id: "fake",
		label: "Fake",
		remoteMapUrl: (id) => `https://fake.test/maps/${id}`,
		listMaps: async () => [],
	};
}

// ---------------------------------------------------------------------------

describe("createSyncController", () => {
	it("unlink waits for the in-flight sync before clearing, so an aborted run cannot resurrect the link", async () => {
		const mma = makeMma();
		mma.install();
		const controller = createSyncController(makeProvider(), PLUGIN);

		await controller.link(REMOTE, null);
		expect(controller.getLink()).not.toBeNull();

		mma.block();
		const syncing = controller.syncNow(); // reconcile suspends on the blocked command
		await Promise.resolve();

		const unlinking = controller.unlink();
		mma.release(); // the aborted run runs to its end and re-persists the link
		await Promise.all([syncing.catch(() => undefined), unlinking]);

		expect(controller.getLink()).toBeNull();
		expect(mma.mapping.has("fake:map-a")).toBe(false);
	});

	it("a queued non-coalesced run rejects when the open map changed while it waited", async () => {
		const mma = makeMma();
		mma.install();
		const controller = createSyncController(makeProvider(), PLUGIN);

		await controller.link(REMOTE, null);

		mma.block();
		const first = controller.syncNow(); // in flight for map-a
		await Promise.resolve();
		const queued = controller.firstSync("merge"); // queues behind it (non-coalesced)

		mma.setMapId("map-b"); // user switches maps before the queue drains
		mma.release();

		await Promise.all([
			first.catch(() => undefined),
			expect(queued).rejects.toThrow("map changed before sync could run"),
		]);
	});

	it("live preference is namespaced per map, not shared across the provider's maps", async () => {
		const mma = makeMma();
		mma.install();
		const controller = createSyncController(makeProvider(), PLUGIN);

		await controller.link(REMOTE, null);

		mma.block(); // keep the scheduler's first run from completing
		controller.startLive();
		expect(controller.livePref()).toBe(true);
		expect(controller.isLive()).toBe(true);
		expect(mma.storage.has("live:map-a")).toBe(true);
		expect(mma.storage.has("live")).toBe(false); // not a provider-global key

		mma.setMapId("map-b");
		expect(controller.livePref()).toBe(false); // a different map has its own pref

		controller.pauseLive(); // clear the poll interval
	});
});
