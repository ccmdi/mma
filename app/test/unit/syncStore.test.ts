import { describe, it, expect, vi } from "vitest";
import {
	createSyncStore,
	listLinks,
	type KeyValueStore,
	type SyncLink,
} from "@/lib/sync/syncStore";

/** In-memory KV mirroring MMA.storage(pluginId), with a serialize round-trip. */
function memKv(): KeyValueStore {
	const m = new Map<string, unknown>();
	return {
		get: <T>(key: string, fallback?: T) => (m.has(key) ? (m.get(key) as T) : (fallback as T)),
		set: (key, value) => void m.set(key, JSON.parse(JSON.stringify(value))),
		remove: (key) => void m.delete(key),
		keys: () => [...m.keys()],
	};
}

/** Mapping rows mirroring the Rust remote_mapping table, scoped per provider + map. */
const mapping = vi.hoisted(() => ({ rows: new Set<string>() }));
vi.mock("@/lib/commands", () => ({
	cmd: {
		remoteMappingClear: async (p: string, m: string) => void mapping.rows.delete(`${p}::${m}`),
	},
}));

const link = (over: Partial<SyncLink> = {}): SyncLink => ({
	id: "link-a",
	localMapId: "map-a",
	remoteMapId: "449219",
	remoteMapName: "test map",
	remoteUserId: "854",
	linkedAt: "2026-06-30T00:00:00Z",
	lastSyncedAt: null,
	...over,
});

const P = "map-making.app";

describe("sync syncStore", () => {
	it("link round-trips via KV", () => {
		const s = createSyncStore(memKv(), P, "map-a");
		expect(s.getLink()).toBeNull();
		s.setLink(link({ lastSyncedAt: "2026-06-30T01:00:00Z" }));
		expect(s.getLink()?.lastSyncedAt).toBe("2026-06-30T01:00:00Z");
	});

	it("namespaces by provider + map; clear() drops only this map's link and rows", async () => {
		const kv = memKv();
		mapping.rows.clear();
		mapping.rows.add(`${P}::map-a`).add(`${P}::map-b`).add("geoguessr::map-a");
		const a = createSyncStore(kv, P, "map-a");
		const b = createSyncStore(kv, P, "map-b");
		a.setLink(link());
		b.setLink(link({ localMapId: "map-b" }));

		await a.clear();
		expect(a.getLink()).toBeNull();
		expect(b.getLink()).not.toBeNull(); // other map untouched
		expect(mapping.rows.has(`${P}::map-a`)).toBe(false);
		expect(mapping.rows.has(`${P}::map-b`)).toBe(true);
		expect(mapping.rows.has("geoguessr::map-a")).toBe(true); // other provider untouched
	});

	it("listLinks returns only this provider's links, skipping other keys in the store", () => {
		const kv = memKv();
		createSyncStore(kv, P, "map-a").setLink(link());
		createSyncStore(kv, P, "map-b").setLink(link({ localMapId: "map-b" }));
		createSyncStore(kv, "geoguessr", "map-c").setLink(link({ localMapId: "map-c" }));
		kv.set("live:map-a", true);

		expect(
			listLinks(kv, P)
				.map((l) => l.localMapId)
				.sort(),
		).toEqual(["map-a", "map-b"]);
		expect(listLinks(kv, "geoguessr").map((l) => l.localMapId)).toEqual(["map-c"]);
	});
});
