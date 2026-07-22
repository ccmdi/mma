// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { Location } from "@/bindings.gen";
import { createSyncController } from "@/lib/sync/controller";
import type { NormalizedSyncLocation } from "@/lib/sync/normalized";
import type { PushedId, SyncProvider } from "@/lib/sync/provider";
import type { RemoteMappingRow } from "@/lib/sync/syncStore";

const PLUGIN = "test-plugin";
const REMOTE = { id: "r1", name: "Remote", locationCount: 0 };

// --- fake window.MMA -------------------------------------------------------

/** In-memory MMA with a KV store and the row-oriented mapping backend the controller wires up. */
function makeMma() {
	const storage = new Map<string, unknown>();
	const mapping = new Map<string, RemoteMappingRow[]>(); // key = `${provider}:${mapId}`
	let mapId: string | null = "map-a";

	const kv = {
		get: <T>(k: string, fallback?: T): T =>
			storage.has(k) ? (storage.get(k) as T) : (fallback as T),
		set: (k: string, v: unknown) => void storage.set(k, v),
		remove: (k: string) => void storage.delete(k),
	};

	const api = {
		storage: () => kv,
		getCurrentMap: () => (mapId ? { meta: { id: mapId, locationCount: 0, tags: {} } } : null),
		fetchAllLocations: async (): Promise<Location[]> => [],
		createLocation: (p: Partial<Location>) => p,
		addLocations: async () => {},
		updateLocations: async () => {},
		removeLocations: async () => {},
		createTags: async () => [],
		on: () => () => {},
		cmd: {
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
	};
}

// --- fake provider with a controllable pull gate ---------------------------

function makeProvider() {
	let gate: Promise<void> | null = null;
	let release: (() => void) | null = null;

	const provider: SyncProvider<NormalizedSyncLocation> = {
		id: "fake",
		label: "Fake",
		identity: "stable",
		supportsTags: false,
		listMaps: async () => [],
		pull: async () => {
			if (gate) await gate;
			return { locations: [], token: "tok" };
		},
		push: async (): Promise<PushedId[]> => [],
		remoteIdOf: (_item, index) => index,
		normalize: (item) => item,
		materialize: (loc) => loc,
	};

	return {
		provider,
		block: () => {
			gate = new Promise<void>((r) => (release = r));
		},
		release: () => release?.(),
	};
}

// ---------------------------------------------------------------------------

describe("createSyncController", () => {
	it("unlink waits for the in-flight sync before clearing, so an aborted run cannot resurrect the link", async () => {
		const mma = makeMma();
		mma.install();
		const { provider, block, release } = makeProvider();
		const controller = createSyncController(provider, PLUGIN);

		await controller.link(REMOTE, null);
		expect(controller.getLink()).not.toBeNull();

		block();
		const syncing = controller.syncNow(); // reconcile suspends on the blocked pull
		await Promise.resolve();

		const unlinking = controller.unlink();
		release(); // the aborted run runs to its end and re-persists the link
		await Promise.all([syncing.catch(() => undefined), unlinking]);

		expect(controller.getLink()).toBeNull();
		expect(mma.mapping.has("fake:map-a")).toBe(false);
	});

	it("a queued non-coalesced run rejects when the open map changed while it waited", async () => {
		const mma = makeMma();
		mma.install();
		const { provider, block, release } = makeProvider();
		const controller = createSyncController(provider, PLUGIN);

		await controller.link(REMOTE, null);

		block();
		const first = controller.syncNow(); // in flight for map-a
		await Promise.resolve();
		const queued = controller.firstSync("merge"); // queues behind it (non-coalesced)

		mma.setMapId("map-b"); // user switches maps before the queue drains
		release();

		await Promise.all([
			first.catch(() => undefined),
			expect(queued).rejects.toThrow("map changed before sync could run"),
		]);
	});

	it("live preference is namespaced per map, not shared across the provider's maps", async () => {
		const mma = makeMma();
		mma.install();
		const { provider, block } = makeProvider();
		const controller = createSyncController(provider, PLUGIN);

		await controller.link(REMOTE, null);

		block(); // keep the scheduler's first run from completing
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
