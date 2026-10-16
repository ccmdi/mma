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
	beforeReturn: null as (() => void) | null,
	settlement: null as Promise<void> | null,
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		syncReconcile: async (...args: unknown[]) => {
			h.reconciles.push(args);
			h.beforeReturn?.();
			return h.result;
		},
	},
}));
vi.mock("@/store/store", () => ({
	Store: {
		get: () => ({ mapId: h.mapId, map: h.mapId ? { id: h.mapId } : null }),
	},
}));
vi.mock("@/store/mutation", () => ({
	Mutation: {
		settle: async (m: unknown) => {
			h.mutations.push(m);
			return h.settlement ?? Promise.resolve();
		},
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
		id: "link-1",
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
	h.beforeReturn = null;
	h.settlement = null;
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
		h.result = { ...RESULT, mutation: null } as unknown as SyncReconcileResult;
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

	it("waits for the local mutation feed before advancing the sync timestamp", async () => {
		const store = linkedStore();
		let release!: () => void;
		h.settlement = new Promise<void>((resolve) => (release = resolve));

		const completion = reconcile(provider, store);
		await Promise.resolve();
		expect(h.mutations).toEqual([MUTATION]);
		expect(store.getLink()?.lastSyncedAt).toBeNull();

		release();
		await completion;
		expect(store.getLink()?.lastSyncedAt).toBeTruthy();
	});

	it("does not mark a canceled sync complete if cancellation arrives during feed settlement", async () => {
		const store = linkedStore();
		const controller = new AbortController();
		let release!: () => void;
		h.settlement = new Promise<void>((resolve) => (release = resolve));

		const completion = reconcile(provider, store, { signal: controller.signal });
		await Promise.resolve();
		controller.abort();
		release();

		await expect(completion).rejects.toMatchObject({ name: "AbortError" });
		expect(h.mutations).toEqual([MUTATION]);
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});

	it("does not overwrite a replacement link after the old result settles", async () => {
		const store = linkedStore();
		let release!: () => void;
		h.settlement = new Promise<void>((resolve) => (release = resolve));

		const completion = reconcile(provider, store);
		await Promise.resolve();
		store.setLink({
			id: "link-2",
			localMapId: MAP,
			remoteMapId: "replacement",
			remoteMapName: "New remote",
			remoteUserId: null,
			linkedAt: "2026-02-01T00:00:00Z",
			lastSyncedAt: null,
		});
		release();

		await expect(completion).rejects.toThrow("map was relinked during sync");
		expect(store.getLink()?.remoteMapId).toBe("replacement");
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});

	it("tells a relink to the same remote at the same instant from the link it replaced", async () => {
		const store = linkedStore();
		let release!: () => void;
		h.settlement = new Promise<void>((resolve) => (release = resolve));

		const completion = reconcile(provider, store);
		await Promise.resolve();
		const old = store.getLink();
		if (!old) throw new Error("linked");
		store.setLink({ ...old, id: "link-2" });
		release();

		await expect(completion).rejects.toThrow("map was relinked during sync");
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});
	it("leaves the sync timestamp unchanged when waiting for the feed fails", async () => {
		const store = linkedStore();
		h.settlement = Promise.reject(new Error("feed failed"));

		await expect(reconcile(provider, store)).rejects.toThrow("feed failed");
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});

	it("does not call Rust when the caller is already aborted", async () => {
		const store = linkedStore();
		const controller = new AbortController();
		controller.abort();

		await expect(reconcile(provider, store, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(h.reconciles).toEqual([]);
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});

	it("refuses when the link has already been removed", async () => {
		const store = linkedStore();
		store.setLink(null);

		await expect(reconcile(provider, store)).rejects.toThrow("map is not linked");
		expect(h.reconciles).toEqual([]);
	});

	it("does not report completion after Rust applies a result to an aborted caller", async () => {
		const store = linkedStore();
		const controller = new AbortController();
		h.beforeReturn = () => controller.abort();

		await expect(reconcile(provider, store, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(h.mutations).toEqual([]);
		expect(store.getLink()?.lastSyncedAt).toBeNull();
	});

	it("does not advance a link removed while Rust is reconciling", async () => {
		const store = linkedStore();
		h.beforeReturn = () => store.setLink(null);

		await expect(reconcile(provider, store)).rejects.toThrow("map was unlinked during sync");
		expect(h.mutations).toEqual([]);
		expect(store.getLink()).toBeNull();
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
