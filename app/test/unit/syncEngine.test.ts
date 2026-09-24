// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { SyncReconcileResult } from "@/bindings.gen";
import { reconcile } from "@/lib/sync/engine";
import type { SyncProvider } from "@/lib/sync/provider";
import {
	createSyncStore,
	type KeyValueStore,
	type MappingBackend,
	type RemoteMappingRow,
} from "@/lib/sync/syncStore";

const MAP = "map-a";
const PROVIDER = "fake";

const noPatch = {
	lat: null,
	lng: null,
	heading: null,
	pitch: null,
	zoom: null,
	panoIdSet: false,
	panoId: null,
	flags: null,
	tags: null,
};

/** Location 2 was edited remotely and location 3 was deleted remotely. */
const RESULT: SyncReconcileResult = {
	pushed: { create: 0, update: 0, delete: 0 },
	pulled: { create: 0, update: 1, delete: 1 },
	adopted: 0,
	conflicts: [],
	neededTags: [],
	pullCreates: [],
	pullUpdates: [{ localId: 2, patch: { ...noPatch, lat: 22 }, remoteId: 8, hash: "remote-2" }],
	pullDeleteIds: [3],
	mirrorLocalDeleteIds: [],
};

const SEEDED: RemoteMappingRow[] = [
	{ localId: 2, remoteId: 8, hash: "base-2" },
	{ localId: 3, remoteId: 9, hash: "base-3" },
];

function memKv(): KeyValueStore {
	const m = new Map<string, unknown>();
	return {
		get: <T>(key: string, fallback?: T) => (m.has(key) ? (m.get(key) as T) : (fallback as T)),
		set: (key, value) => void m.set(key, value),
		remove: (key) => void m.delete(key),
		keys: () => [...m.keys()],
	};
}

function memMapping(seed: RemoteMappingRow[]): MappingBackend {
	const rows = new Map(seed.map((r) => [r.localId, { ...r }] as const));
	return {
		get: async () => [...rows.values()].sort((a, b) => a.localId - b.localId),
		upsert: async (_p, _m, next) => next.forEach((r) => rows.set(r.localId, { ...r })),
		delete: async (_p, _m, ids) => ids.forEach((id) => rows.delete(id)),
		clear: async () => rows.clear(),
	};
}

type Step = "reconcile" | "update" | "remove";

/** Fake MMA whose open map switches away right after `switchAfter` completes. */
function setup(switchAfter: Step | null) {
	let mapId = MAP;
	const calls: Step[] = [];
	const step = (s: Step) => {
		calls.push(s);
		if (s === switchAfter) mapId = "map-b";
	};
	(window as unknown as { MMA: unknown }).MMA = {
		getMapState: () => ({ mapId, map: { id: mapId } }),
		getTags: () => ({}),
		createTags: async () => [],
		createLocation: (p: unknown) => p,
		addLocations: async () => {},
		updateLocations: async () => step("update"),
		removeLocations: async () => step("remove"),
		cmd: {
			syncReconcile: async () => {
				step("reconcile");
				return RESULT;
			},
		},
	};
	const store = createSyncStore(memKv(), memMapping(SEEDED), PROVIDER, MAP);
	store.setLink({
		localMapId: MAP,
		remoteMapId: "r1",
		remoteMapName: "Remote",
		remoteUserId: null,
		linkedAt: "2026-01-01T00:00:00Z",
		lastSyncedAt: null,
	});
	const provider = { id: PROVIDER } as SyncProvider;
	return { store, calls, run: () => reconcile(provider, store) };
}

describe("sync reconcile apply step", () => {
	it("leaves every pull's mapping row untouched when the map switches before any pull applies", async () => {
		const { store, calls, run } = setup("reconcile");

		await expect(run()).rejects.toThrow("linked map is no longer open");

		expect(calls).toEqual(["reconcile"]);
		expect(await store.getMapping()).toEqual(SEEDED);
	});

	it("records an applied update but keeps an unapplied delete's row when the map switches between them", async () => {
		const { store, calls, run } = setup("update");

		await expect(run()).rejects.toThrow("linked map is no longer open");

		expect(calls).toEqual(["reconcile", "update"]);
		expect(await store.getMapping()).toEqual([
			{ localId: 2, remoteId: 8, hash: "remote-2" },
			{ localId: 3, remoteId: 9, hash: "base-3" },
		]);
	});

	it("records every pull once all of them apply", async () => {
		const { store, calls, run } = setup(null);

		await run();

		expect(calls).toEqual(["reconcile", "update", "remove"]);
		expect(await store.getMapping()).toEqual([{ localId: 2, remoteId: 8, hash: "remote-2" }]);
	});
});
