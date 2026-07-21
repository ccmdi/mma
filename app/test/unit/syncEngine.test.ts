// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { Location, LocationPatch_Deserialize, Tag, Update } from "@/bindings.gen";
import { reconcile, type ReconcileOptions, type SyncOutcome } from "@/lib/sync/engine";
import { syncHash, type NormalizedSyncLocation } from "@/lib/sync/normalized";
import type { IdentityModel, PushBatch, PushedId, SyncProvider } from "@/lib/sync/provider";
import type { RemoteMappingRow, SyncLink, SyncStore } from "@/lib/sync/syncStore";
import type { IdentityKey } from "@/lib/sync/diff";

function local(id: number, over: Partial<Location> = {}): Location {
	return {
		id,
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags: [],
		extra: null,
		createdAt: 0,
		modifiedAt: null,
		...over,
	};
}

/** A remote whose raw shape is already the normalized contract, so tests stay about orchestration. */
type Raw = NormalizedSyncLocation & { rid?: number };

const raw = (over: Partial<Raw> = {}): Raw => ({
	lat: 0,
	lng: 0,
	heading: 0,
	pitch: 0,
	zoom: 0,
	panoId: null,
	flags: 0,
	tags: [],
	...over,
});

const strip = (r: Raw): NormalizedSyncLocation => {
	const { rid: _rid, ...n } = r;
	return n;
};

/** Hash of the normalized contract described by `over` - what a mapping row should carry. */
const nhash = (over: Partial<Raw> = {}) => syncHash(strip(raw(over)));

const tag = (id: number, name: string): Tag => ({ id, name, color: "#000000" });

// --- fake window.MMA -------------------------------------------------------

interface FakeMma {
	locs(): Location[];
	loc(id: number): Location | undefined;
	tagNames(): string[];
	setMapId(id: string): void;
	install(): void;
}

function makeMma(initial: Location[] = [], initialTags: string[] = []): FakeMma {
	const locations = new Map<number, Location>();
	for (const l of initial) locations.set(l.id, { ...l });
	let nextId = Math.max(0, ...initial.map((l) => l.id)) + 1;

	const tags: Record<string, Tag> = {};
	let nextTagId = 1;
	for (const name of initialTags) {
		const id = nextTagId++;
		tags[String(id)] = tag(id, name);
	}

	const meta = { id: "map-a", tags };
	const api = {
		getCurrentMap: () => ({ meta }),
		fetchAllLocations: async () => [...locations.values()].map((l) => ({ ...l })),
		createLocation: (partial: Partial<Location>) => local(0, partial),
		// Rust assigns ids and writes them back into the passed objects.
		addLocations: async (locs: Location[]) => {
			for (const l of locs) {
				l.id = nextId++;
				locations.set(l.id, { ...l });
			}
		},
		updateLocations: async (updates: Update<LocationPatch_Deserialize>[]) => {
			for (const u of updates) {
				const cur = locations.get(u.id);
				if (cur) locations.set(u.id, { ...cur, ...u.patch } as Location);
			}
		},
		removeLocations: async (ids: ReadonlySet<number>) => {
			for (const id of ids) locations.delete(id);
		},
		createTags: async (names: string[]) => {
			const out: Tag[] = [];
			for (const name of names) {
				const found = Object.values(tags).find((t) => t.name === name);
				if (found) {
					out.push(found);
					continue;
				}
				const t = tag(nextTagId++, name);
				tags[String(t.id)] = t;
				out.push(t);
			}
			return out;
		},
	};

	return {
		locs: () => [...locations.values()].sort((a, b) => a.id - b.id),
		loc: (id) => locations.get(id),
		tagNames: () => Object.values(tags).map((t) => t.name),
		setMapId: (id) => {
			meta.id = id;
		},
		install: () => {
			(window as unknown as { MMA: unknown }).MMA = api;
		},
	};
}

// --- fake SyncStore --------------------------------------------------------

const link = (over: Partial<SyncLink> = {}): SyncLink => ({
	localMapId: "map-a",
	remoteMapId: "r1",
	remoteMapName: "remote",
	remoteUserId: null,
	linkedAt: "2026-01-01T00:00:00Z",
	lastSyncedAt: null,
	...over,
});

interface FakeStore extends SyncStore {
	rows(): RemoteMappingRow[];
}

function makeStore(rows: RemoteMappingRow[] = [], l: SyncLink | null = link()): FakeStore {
	const table = new Map<number, RemoteMappingRow>();
	for (const r of rows) table.set(r.localId, { ...r });
	return {
		getLink: () => l,
		setLink: (next) => {
			l = next;
		},
		getMapping: async () => [...table.values()].map((r) => ({ ...r })),
		upsertMapping: async (rs) => {
			for (const r of rs) table.set(r.localId, { ...r });
		},
		deleteMapping: async (ids) => {
			for (const id of ids) table.delete(id);
		},
		clear: async () => {
			table.clear();
			l = null;
		},
		rows: () => [...table.values()].sort((a, b) => a.localId - b.localId),
	};
}

// --- fake remote + provider ------------------------------------------------

interface FakeRemote {
	provider: SyncProvider<Raw>;
	pushes: PushBatch<Raw>[];
	items(): Raw[];
	setItems(next: Raw[]): void;
}

/**
 * `stable` churns the remote id on every update (map-making.app does); `positional` replaces the
 * whole document from `desired` and reports a handle for every entry carrying a localId.
 */
function makeRemote(
	identity: IdentityModel,
	initial: Raw[] = [],
	hooks: { afterPull?: () => void } = {},
): FakeRemote {
	let items = initial.map((r) => ({ ...r }));
	let nextRid = 1000;
	const pushes: PushBatch<Raw>[] = [];

	const provider: SyncProvider<Raw> = {
		id: "fake",
		label: "Fake",
		identity,
		supportsTags: true,
		listMaps: async () => [],
		pull: async () => {
			const snapshot = { locations: items.map((i) => ({ ...i })), token: "tok" };
			hooks.afterPull?.();
			return snapshot;
		},
		push: async (_mapId, batch) => {
			pushes.push(batch);
			if (identity === "positional") {
				items = batch.desired.map((d) => ({ ...d.item }));
				const out: PushedId[] = [];
				batch.desired.forEach((d, i) => {
					if (d.localId !== null) out.push({ localId: d.localId, remoteId: i });
				});
				return out;
			}
			const out: PushedId[] = [];
			for (const d of batch.delete) items = items.filter((i) => i.rid !== d.rid);
			for (const u of batch.update) {
				const at = items.findIndex((i) => i.rid === u.replaces.rid);
				const rid = nextRid++;
				if (at >= 0) items[at] = { ...u.item, rid };
				out.push({ localId: u.localId, remoteId: rid });
			}
			for (const c of batch.create) {
				const rid = nextRid++;
				items.push({ ...c.item, rid });
				out.push({ localId: c.localId, remoteId: rid });
			}
			return out;
		},
		remoteIdOf: (item, index) => (identity === "stable" ? item.rid! : index),
		normalize: strip,
		materialize: (loc) => ({ ...loc }),
	};

	return {
		provider,
		pushes,
		items: () => items.map((i) => ({ ...i })),
		setItems: (next) => {
			items = next.map((i) => ({ ...i }));
		},
	};
}

// --- harness ---------------------------------------------------------------

function run(
	mma: FakeMma,
	remote: FakeRemote,
	store: SyncStore,
	opts?: ReconcileOptions,
): Promise<SyncOutcome> {
	mma.install();
	return reconcile(remote.provider, store, opts);
}

const NOOP: SyncOutcome = {
	pushed: { create: 0, update: 0, delete: 0 },
	pulled: { create: 0, update: 0, delete: 0 },
	adopted: 0,
	conflicts: [],
};

const expectNoop = (out: SyncOutcome) => expect(out).toEqual(NOOP);

// ---------------------------------------------------------------------------

describe("reconcile: push", () => {
	it("pushes an unmapped local location and records the resolved remote id", async () => {
		const mma = makeMma([local(1, { lat: 10, lng: 20 })]);
		const remote = makeRemote("stable");
		const store = makeStore();

		const out = await run(mma, remote, store);

		expect(out.pushed).toEqual({ create: 1, update: 0, delete: 0 });
		expect(remote.pushes).toHaveLength(1);
		expect(remote.pushes[0]!.create.map((c) => c.localId)).toEqual([1]);
		expect(remote.pushes[0]!.desired.map((d) => d.localId)).toEqual([1]);
		expect(store.rows()).toEqual([
			{ localId: 1, remoteId: 1000, hash: nhash({ lat: 10, lng: 20 }) },
		]);
		expect(remote.items()).toEqual([raw({ lat: 10, lng: 20, rid: 1000 })]);

		expectNoop(await run(mma, remote, store));
	});
});

describe("reconcile: pull", () => {
	it("creates a remote-only location locally and maps the id assigned in place", async () => {
		const mma = makeMma();
		const remote = makeRemote("stable", [raw({ lat: 5, rid: 7 })]);
		const store = makeStore();

		const out = await run(mma, remote, store);

		expect(out.pulled).toEqual({ create: 1, update: 0, delete: 0 });
		expect(remote.pushes).toHaveLength(0);
		expect(mma.locs()).toHaveLength(1);
		const created = mma.locs()[0]!;
		expect(created.lat).toBe(5);
		expect(store.rows()).toEqual([{ localId: created.id, remoteId: 7, hash: nhash({ lat: 5 }) }]);

		expectNoop(await run(mma, remote, store));
	});

	it("creates missing local tags for a pulled location", async () => {
		const mma = makeMma();
		const remote = makeRemote("stable", [raw({ lat: 5, rid: 7, tags: ["blue"] })]);
		const store = makeStore();

		await run(mma, remote, store);

		expect(mma.tagNames()).toEqual(["blue"]);
		const created = mma.locs()[0]!;
		expect(created.tags).toHaveLength(1);
		expectNoop(await run(mma, remote, store));
	});
});

describe("reconcile: updates in both directions", () => {
	it("pushes the local edit and applies the remote edit to the local store", async () => {
		const mma = makeMma([local(1, { lat: 11 }), local(2, { lat: 2 })]);
		const remote = makeRemote("stable", [raw({ lat: 1, rid: 7 }), raw({ lat: 22, rid: 8 })]);
		const store = makeStore([
			{ localId: 1, remoteId: 7, hash: nhash({ lat: 1 }) },
			{ localId: 2, remoteId: 8, hash: nhash({ lat: 2 }) },
		]);

		const out = await run(mma, remote, store);

		expect(out.pushed).toEqual({ create: 0, update: 1, delete: 0 });
		expect(out.pulled).toEqual({ create: 0, update: 1, delete: 0 });
		expect(mma.loc(2)!.lat).toBe(22);
		expect(mma.loc(1)!.lat).toBe(11); // the push must not write back over local
		expect(remote.pushes[0]!.update.map((u) => u.localId)).toEqual([1]);
		expect(remote.pushes[0]!.update[0]!.replaces).toEqual(raw({ lat: 1, rid: 7 }));
		expect(store.rows()).toEqual([
			{ localId: 1, remoteId: 1000, hash: nhash({ lat: 11 }) },
			{ localId: 2, remoteId: 8, hash: nhash({ lat: 22 }) },
		]);

		expectNoop(await run(mma, remote, store));
	});
});

describe("reconcile: convergence", () => {
	it("adopts a change both sides already made, and the base advances", async () => {
		const mma = makeMma([local(1, { lat: 2 })]);
		const remote = makeRemote("stable", [raw({ lat: 2, rid: 7 })]);
		const store = makeStore([{ localId: 1, remoteId: 7, hash: nhash({ lat: 1 }) }]);

		const out = await run(mma, remote, store);

		expect(out.adopted).toBe(1);
		expect(out.pushed).toEqual({ create: 0, update: 0, delete: 0 });
		expect(out.pulled).toEqual({ create: 0, update: 0, delete: 0 });
		expect(remote.pushes).toHaveLength(0);
		expect(store.rows()).toEqual([{ localId: 1, remoteId: 7, hash: nhash({ lat: 2 }) }]);

		// The whole point of adopting: the second pass has nothing left to do.
		const before = { rows: store.rows(), locs: mma.locs(), items: remote.items() };
		expectNoop(await run(mma, remote, store));
		expect(store.rows()).toEqual(before.rows);
		expect(mma.locs()).toEqual(before.locs);
		expect(remote.items()).toEqual(before.items);
		expect(remote.pushes).toHaveLength(0);
	});
});

describe("reconcile: conflicts", () => {
	const setup = () => ({
		mma: makeMma([local(1, { lat: 2 })]),
		remote: makeRemote("stable", [raw({ lat: 3, rid: 7 })]),
		store: makeStore([{ localId: 1, remoteId: 7, hash: nhash({ lat: 1 }) }]),
	});

	it("holds a divergent edit back from both sides and does not advance the row", async () => {
		const { mma, remote, store } = setup();

		const out = await run(mma, remote, store);

		expect(out.conflicts).toHaveLength(1);
		expect(out.conflicts[0]!.key).toBe("L:1");
		expect(out.conflicts[0]!.kind).toBe("update-update");
		expect(mma.loc(1)!.lat).toBe(2);
		expect(remote.items()).toEqual([raw({ lat: 3, rid: 7 })]);
		expect(remote.pushes).toHaveLength(0);
		expect(store.rows()).toEqual([{ localId: 1, remoteId: 7, hash: nhash({ lat: 1 }) }]);
	});

	it("applies a local resolution as a push and settles", async () => {
		const { mma, remote, store } = setup();
		await run(mma, remote, store);

		const resolutions = new Map<IdentityKey, "local" | "remote">([["L:1", "local"]]);
		const out = await run(mma, remote, store, { resolutions });

		expect(out.conflicts).toEqual([]);
		expect(out.pushed).toEqual({ create: 0, update: 1, delete: 0 });
		expect(remote.items()).toEqual([raw({ lat: 2, rid: 1000 })]);
		expect(mma.loc(1)!.lat).toBe(2);
		expect(store.rows()).toEqual([{ localId: 1, remoteId: 1000, hash: nhash({ lat: 2 }) }]);

		expectNoop(await run(mma, remote, store));
	});

	it("applies a remote resolution as a pull", async () => {
		const { mma, remote, store } = setup();
		await run(mma, remote, store);

		const resolutions = new Map<IdentityKey, "local" | "remote">([["L:1", "remote"]]);
		const out = await run(mma, remote, store, { resolutions });

		expect(out.conflicts).toEqual([]);
		expect(out.pulled).toEqual({ create: 0, update: 1, delete: 0 });
		expect(mma.loc(1)!.lat).toBe(3);
		expect(remote.pushes).toHaveLength(0);
		expect(store.rows()).toEqual([{ localId: 1, remoteId: 7, hash: nhash({ lat: 3 }) }]);

		expectNoop(await run(mma, remote, store));
	});
});

describe("reconcile: first-sync mirror modes", () => {
	const setup = () => ({
		mma: makeMma([local(1, { lat: 1 })]),
		remote: makeRemote("stable", [raw({ lat: 2, rid: 7 })]),
		store: makeStore(),
	});

	it("merge (the default) keeps both sides and deletes nothing", async () => {
		const { mma, remote, store } = setup();

		const out = await run(mma, remote, store);

		expect(out.pushed).toEqual({ create: 1, update: 0, delete: 0 });
		expect(out.pulled).toEqual({ create: 1, update: 0, delete: 0 });
		expect(
			mma
				.locs()
				.map((l) => l.lat)
				.sort(),
		).toEqual([1, 2]);
		expect(
			remote
				.items()
				.map((i) => i.lat)
				.sort(),
		).toEqual([1, 2]);
		expect(remote.pushes[0]!.delete).toEqual([]);
	});

	it("mirrorFromRemote deletes local-only pins instead of pushing them", async () => {
		const { mma, remote, store } = setup();

		const out = await run(mma, remote, store, { firstSync: "mirrorFromRemote" });

		expect(out.pushed).toEqual({ create: 0, update: 0, delete: 0 });
		expect(out.pulled).toEqual({ create: 1, update: 0, delete: 1 });
		expect(mma.locs().map((l) => l.lat)).toEqual([2]); // local-only pin gone
		expect(mma.loc(1)).toBeUndefined();
		expect(remote.pushes).toHaveLength(0);
		expect(remote.items()).toEqual([raw({ lat: 2, rid: 7 })]);
	});

	it("mirrorFromLocal deletes remote-only pins instead of pulling them", async () => {
		const { mma, remote, store } = setup();

		const out = await run(mma, remote, store, { firstSync: "mirrorFromLocal" });

		// The deletion is applied remotely, so it counts as a push - not a pull.
		expect(out.pulled).toEqual({ create: 0, update: 0, delete: 0 });
		expect(out.pushed).toEqual({ create: 1, update: 0, delete: 1 });
		expect(mma.locs().map((l) => l.lat)).toEqual([1]); // nothing pulled in
		expect(remote.pushes[0]!.delete).toEqual([raw({ lat: 2, rid: 7 })]);
		expect(remote.pushes[0]!.desired.map((d) => d.localId)).toEqual([1]);
		expect(remote.items()).toEqual([raw({ lat: 1, rid: 1000 })]);
	});
});

describe("reconcile: positional reindexing", () => {
	// Three synced pins; the first is deleted locally, so the push rewrites the whole document
	// and every later pin slides down one index.
	const setup = () => ({
		mma: makeMma([local(2, { lat: 2 }), local(3, { lat: 3 })]),
		remote: makeRemote("positional", [raw({ lat: 1 }), raw({ lat: 2 }), raw({ lat: 3 })]),
		store: makeStore([
			{ localId: 1, remoteId: 0, hash: nhash({ lat: 1 }) },
			{ localId: 2, remoteId: 1, hash: nhash({ lat: 2 }) },
			{ localId: 3, remoteId: 2, hash: nhash({ lat: 3 }) },
		]),
	});

	it("sends the full desired document without the deleted entry", async () => {
		const { mma, remote, store } = setup();

		const out = await run(mma, remote, store);

		expect(out.pushed).toEqual({ create: 0, update: 0, delete: 1 });
		expect(remote.pushes).toHaveLength(1);
		expect(remote.pushes[0]!.desired).toEqual([
			{ item: raw({ lat: 2 }), localId: 2 },
			{ item: raw({ lat: 3 }), localId: 3 },
		]);
		expect(remote.pushes[0]!.delete).toEqual([raw({ lat: 1 })]);
		expect(remote.items()).toEqual([raw({ lat: 2 }), raw({ lat: 3 })]);
	});

	// BUG: `settled` only holds keys the plan touched, so untouched-but-reindexed locations get no
	// mapping row and keep the index they had before the push (2 -> 1, 3 -> 2 instead of 0 and 1).
	// The comment above the final `rowsFor` in engine.ts claims the opposite.
	it("rewrites the mapping rows of untouched locations to their new indices", async () => {
		const { mma, remote, store } = setup();

		await run(mma, remote, store);

		expect(store.rows()).toEqual([
			{ localId: 2, remoteId: 0, hash: nhash({ lat: 2 }) },
			{ localId: 3, remoteId: 1, hash: nhash({ lat: 3 }) },
		]);
	});

	it("drops the mapping row of the deleted location", async () => {
		const { mma, remote, store } = setup();

		await run(mma, remote, store);

		expect(store.rows().map((r) => r.localId)).toEqual([2, 3]);
	});

	// BUG (consequence of the stale rows above): once the rows are stale, a later REMOTE edit can no
	// longer be recovered. `claimRemotes` pass 1/2 fail on the changed hash, pass 3 has no panoId to
	// match on, and pass 4's bare index is out of range - so the edit reads as delete + add and the
	// location loses its local id (and everything hanging off it) instead of being patched.
	it("keeps the local id when the remote later edits a reindexed location", async () => {
		const { mma, remote, store } = setup();
		await run(mma, remote, store);

		remote.setItems([raw({ lat: 2 }), raw({ lat: 3, heading: 77 })]);
		const out = await run(mma, remote, store);

		expect(out.pulled).toEqual({ create: 0, update: 1, delete: 0 });
		expect(mma.loc(3)!.heading).toBe(77);
	});

	it("re-syncs to a no-op against the reindexed remote", async () => {
		const { mma, remote, store } = setup();
		await run(mma, remote, store);

		const before = { locs: mma.locs(), items: remote.items() };
		expectNoop(await run(mma, remote, store));
		expect(remote.pushes).toHaveLength(1); // no second push
		expect(mma.locs()).toEqual(before.locs);
		expect(remote.items()).toEqual(before.items);
	});
});

describe("reconcile: guards", () => {
	it("rejects when the open map changes mid-sync, without touching the local store", async () => {
		const mma = makeMma();
		const store = makeStore();
		const remote = makeRemote("stable", [raw({ lat: 5, rid: 7 })], {
			afterPull: () => mma.setMapId("other-map"),
		});

		mma.install();
		await expect(reconcile(remote.provider, store)).rejects.toThrow("linked map is no longer open");
		expect(mma.locs()).toEqual([]);
		expect(store.rows()).toEqual([]);
	});

	it("rejects an already-aborted signal without touching either side", async () => {
		const mma = makeMma([local(1, { lat: 1 })]);
		const remote = makeRemote("stable", [raw({ lat: 5, rid: 7 })]);
		const store = makeStore();
		const ac = new AbortController();
		ac.abort();

		mma.install();
		await expect(reconcile(remote.provider, store, { signal: ac.signal })).rejects.toThrow(
			"sync aborted",
		);
		expect(mma.locs()).toEqual([local(1, { lat: 1 })]);
		expect(remote.pushes).toHaveLength(0);
		expect(store.rows()).toEqual([]);
	});

	it("rejects when the map is not linked", async () => {
		const mma = makeMma();
		const remote = makeRemote("stable");
		const store = makeStore([], null);

		mma.install();
		await expect(reconcile(remote.provider, store)).rejects.toThrow("map is not linked");
	});
});
