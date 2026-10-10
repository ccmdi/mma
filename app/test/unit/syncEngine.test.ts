// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncReconcileResult } from "@/bindings.gen";

// Rust applies sync changes. These tests cover map guards, waiting for the change feed,
// and updating the link after completion.
const h = vi.hoisted(() => ({
	mapId: "map-a" as string | null,
	reconciles: [] as unknown[][],
	mutations: [] as unknown[],
	result: null as SyncReconcileResult | null,
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		syncReconcile: async (...args: unknown[]) => {
			h.reconciles.push(args);
			return h.result;
		},
	},
}));
vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({ mapId: h.mapId, map: h.mapId ? { id: h.mapId } : null }),
	settled: async (m: unknown) => {
		h.mutations.push(m);
	},
}));
vi.mock("@/lib/events", () => ({
	emit: () => {},
}));

import { reconcile } from "@/lib/sync/engine";
import type { SyncProvider } from "@/lib/sync/provider";
import {
	createSyncStore,
	type KeyValueStore,
	type MappingBackend,
	type SyncStore,
} from "@/lib/sync/syncStore";

const MAP = "map-a";
const PROVIDER = "geoguessr";

const MUTATION = {
	version: 3,
	selectionSync: null,
	step: 7,
	active: null,
	firstId: null,
	values: {},
};

const RESULT = {
	pushed: { create: 0, update: 1, delete: 0 },
	pulled: { create: 1, update: 1, delete: 1 },
	adopted: 2,
	conflicts: [],
	mutation: MUTATION,
	removedIds: [3],
} as unknown as SyncReconcileResult;

function memKv(): KeyValueStore {
	const m = new Map<string, unknown>();
	return {
		get: <T>(key: string, fallback?: T) => (m.has(key) ? (m.get(key) as T) : (fallback as T)),
		set: (key, value) => void m.set(key, value),
		remove: (key) => void m.delete(key),
		keys: () => [...m.keys()],
	};
}

const mapping: MappingBackend = {
	clear: async () => {},
};

function linkedStore(): SyncStore {
	const store = createSyncStore(memKv(), mapping, PROVIDER, MAP);
	store.setLink({
		localMapId: MAP,
		remoteMapId: "r1",
		remoteMapName: "Remote",
		remoteUserId: null,
		linkedAt: "2026-01-01T00:00:00Z",
		lastSyncedAt: null,
	});
	return store;
}

const provider = { id: PROVIDER } as SyncProvider;

beforeEach(() => {
	h.mapId = MAP;
	h.reconciles = [];
	h.mutations = [];
	h.result = RESULT;
});

describe("sync reconcile apply step", () => {
	it("applies the landed change once and advances the link", async () => {
		const store = linkedStore();
		const out = await reconcile(provider, store);

		expect(h.reconciles).toEqual([[PROVIDER, MAP, "r1", null, null]]);
		expect(h.mutations).toEqual([MUTATION]);
		expect(store.getLink()?.lastSyncedAt).toBeTruthy();
		expect(out).toEqual({
			pushed: RESULT.pushed,
			pulled: RESULT.pulled,
			adopted: 2,
			conflicts: [],
		});
	});

	it("an unchanged reconcile applies nothing and emits nothing", async () => {
		h.result = { ...RESULT, mutation: null, removedIds: [] } as unknown as SyncReconcileResult;
		const store = linkedStore();
		await reconcile(provider, store);
		expect(h.mutations).toEqual([]);
	});

	it("refuses when the linked map is not the open one, before anything runs", async () => {
		h.mapId = "map-b";
		const store = linkedStore();
		await expect(reconcile(provider, store)).rejects.toThrow("linked map is no longer open");
		expect(h.reconciles).toEqual([]);
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});

	it("passes the first-sync mode and conflict resolutions through", async () => {
		const store = linkedStore();
		await reconcile(provider, store, {
			firstSync: "mirrorFromLocal",
			resolutions: new Map([["k1", "remote"]]),
		});
		expect(h.reconciles[0]).toEqual([PROVIDER, MAP, "r1", "mirrorFromLocal", [["k1", "remote"]]]);
	});
});
