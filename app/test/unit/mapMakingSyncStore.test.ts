import { describe, it, expect } from "vitest";
import {
	createSyncStore,
	localKey,
	remoteKey,
	type KeyValueStore,
	type MappingBackend,
	type RemoteMappingRow,
	type SyncLink,
} from "@/plugins/mapMakingSync/syncStore";

/** In-memory KV mirroring MMA.storage(pluginId), with a serialize round-trip. */
function memKv(): KeyValueStore {
	const m = new Map<string, unknown>();
	return {
		get: <T>(key: string, fallback?: T) => (m.has(key) ? (m.get(key) as T) : (fallback as T)),
		set: (key, value) => void m.set(key, JSON.parse(JSON.stringify(value))),
		remove: (key) => void m.delete(key),
	};
}

/** In-memory mapping backend mirroring the Rust remote_mapping CRUD (upsert/delete by localId, scoped). */
function memMapping(): MappingBackend {
	const tables = new Map<string, Map<number, RemoteMappingRow>>();
	const t = (p: string, m: string) => {
		const k = `${p}::${m}`;
		let tbl = tables.get(k);
		if (!tbl) tables.set(k, (tbl = new Map()));
		return tbl;
	};
	return {
		get: async (p, m) => [...t(p, m).values()],
		upsert: async (p, m, rows) => rows.forEach((r) => t(p, m).set(r.localId, { ...r })),
		delete: async (p, m, ids) => ids.forEach((id) => t(p, m).delete(id)),
		clear: async (p, m) => void t(p, m).clear(),
	};
}

const link = (over: Partial<SyncLink> = {}): SyncLink => ({
	localMapId: "map-a",
	remoteMapId: 449219,
	remoteBaseUrl: "https://map-making.app",
	remoteUserId: 854,
	linkedAt: "2026-06-30T00:00:00Z",
	lastSyncedAt: null,
	...over,
});

const P = "map-making.app";
const byLocal = (rows: RemoteMappingRow[]) => [...rows].sort((a, b) => a.localId - b.localId);

describe("mapMakingSync syncStore", () => {
	it("identity keys are local-anchored and namespaced by side", () => {
		expect(localKey(42)).toBe("L:42");
		expect(remoteKey(42)).toBe("R:42");
	});

	it("link round-trips via KV; mapping starts empty", async () => {
		const s = createSyncStore(memKv(), memMapping(), P, "map-a");
		expect(s.getLink()).toBeNull();
		expect(await s.getMapping()).toEqual([]);
		s.setLink(link({ lastSyncedAt: "2026-06-30T01:00:00Z" }));
		expect(s.getLink()?.lastSyncedAt).toBe("2026-06-30T01:00:00Z");
	});

	it("upsert writes rows and updates by localId (remote id churn)", async () => {
		const s = createSyncStore(memKv(), memMapping(), P, "map-a");
		await s.upsertMapping([
			{ localId: 1, remoteId: 1000, hash: "h1" },
			{ localId: 2, remoteId: 2000, hash: "h2" },
		]);
		await s.upsertMapping([{ localId: 1, remoteId: 1500, hash: "h1b" }]); // 1 modified remotely
		expect(byLocal(await s.getMapping())).toEqual([
			{ localId: 1, remoteId: 1500, hash: "h1b" },
			{ localId: 2, remoteId: 2000, hash: "h2" },
		]);
	});

	it("deleteMapping removes only the named local ids", async () => {
		const s = createSyncStore(memKv(), memMapping(), P, "map-a");
		await s.upsertMapping([
			{ localId: 1, remoteId: 10, hash: "a" },
			{ localId: 2, remoteId: 20, hash: "b" },
			{ localId: 3, remoteId: 30, hash: "c" },
		]);
		await s.deleteMapping([2]);
		expect(byLocal(await s.getMapping()).map((r) => r.localId)).toEqual([1, 3]);
	});

	it("namespaces by provider + map; clear() drops only this map's link and rows", async () => {
		const kv = memKv();
		const mapping = memMapping();
		const a = createSyncStore(kv, mapping, P, "map-a");
		const b = createSyncStore(kv, mapping, P, "map-b");
		const g = createSyncStore(kv, mapping, "geoguessr", "map-a");
		a.setLink(link());
		await a.upsertMapping([{ localId: 1, remoteId: 10, hash: "a" }]);
		b.setLink(link({ localMapId: "map-b" }));
		await b.upsertMapping([{ localId: 9, remoteId: 90, hash: "z" }]);
		await g.upsertMapping([{ localId: 1, remoteId: 77, hash: "g" }]); // same map id, other provider

		await a.clear();
		expect(a.getLink()).toBeNull();
		expect(await a.getMapping()).toEqual([]);
		expect(b.getLink()).not.toBeNull(); // other map untouched
		expect(await b.getMapping()).toHaveLength(1);
		expect(await g.getMapping()).toHaveLength(1); // other provider untouched
	});
});
