import { describe, it, expect } from "vitest";
import type { Location } from "@/bindings.gen";
import { buildKeyedInputs } from "@/lib/sync/keying";
import { computeSyncPlan } from "@/lib/sync/diff";
import { localToNormalized, syncHash, type NormalizedSyncLocation } from "@/lib/sync/normalized";
import type { SyncProvider } from "@/lib/sync/provider";
import type { RemoteMappingRow } from "@/lib/sync/syncStore";

const tagName = (id: number) => (id === 1 ? "red" : undefined);

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

/** A remote whose raw shape is already the normalized contract, so tests stay about identity. */
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

function makeProvider(over: Partial<SyncProvider<Raw>> = {}): SyncProvider<Raw> {
	return {
		id: "test",
		label: "Test",
		identity: "stable",
		supportsTags: true,
		listMaps: async () => [],
		pull: async () => ({ locations: [] }),
		push: async () => [],
		remoteIdOf: (item, index) => item.rid ?? index,
		normalize: strip,
		materialize: (loc) => ({ ...loc }),
		...over,
	};
}

const hashOf = (loc: Location) => syncHash(localToNormalized(loc, tagName));

describe("keying: unmapped duplicates", () => {
	it("keeps two identical unmapped local pins as separate identities", () => {
		const p = makeProvider();
		const dupes = [local(1), local(2)];
		const keyed = buildKeyedInputs(p, dupes, [], [], tagName);

		expect(keyed.local.size).toBe(2);
		expect(new Set(keyed.localById.keys()).size).toBe(2);
		// Both must survive into the plan as pushes; the old content-only key silently dropped one.
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);
		expect(plan.push.create).toHaveLength(2);
	});

	it("converges only as many duplicates as both sides actually share", () => {
		const p = makeProvider();
		// Two identical local pins, one identical remote pin.
		const keyed = buildKeyedInputs(p, [local(1), local(2)], [raw()], [], tagName);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

		expect(plan.converged).toHaveLength(1); // the shared one is adopted, not duplicated
		expect(plan.push.create).toHaveLength(1); // the surplus local copy is pushed
		expect(plan.pull.create).toHaveLength(0);
	});
});

describe("keying: positional identity", () => {
	const positional = makeProvider({ identity: "positional" });

	it("holds identity when the array is untouched", () => {
		const a = local(10, { lat: 1 });
		const b = local(11, { lat: 2 });
		const mapping: RemoteMappingRow[] = [
			{ localId: 10, remoteId: 0, hash: hashOf(a) },
			{ localId: 11, remoteId: 1, hash: hashOf(b) },
		];
		const keyed = buildKeyedInputs(
			positional,
			[a, b],
			[raw({ lat: 1 }), raw({ lat: 2 })],
			mapping,
			tagName,
		);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);
		expect(plan.push.create).toHaveLength(0);
		expect(plan.pull.create).toHaveLength(0);
		expect(keyed.remote.has("L:10")).toBe(true);
		expect(keyed.remote.has("L:11")).toBe(true);
	});

	it("realigns by content hash when the remote inserts ahead of us", () => {
		const a = local(10, { lat: 1 });
		const b = local(11, { lat: 2 });
		const mapping: RemoteMappingRow[] = [
			{ localId: 10, remoteId: 0, hash: hashOf(a) },
			{ localId: 11, remoteId: 1, hash: hashOf(b) },
		];
		// Someone added a pin at the front on the remote, shifting both of ours by one.
		const keyed = buildKeyedInputs(
			positional,
			[a, b],
			[raw({ lat: 99 }), raw({ lat: 1 }), raw({ lat: 2 })],
			mapping,
			tagName,
		);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

		expect(keyed.remote.has("L:10")).toBe(true);
		expect(keyed.remote.has("L:11")).toBe(true);
		expect(plan.pull.create).toHaveLength(1); // only the genuinely new pin comes in
		expect(plan.push.create).toHaveLength(0); // and nothing of ours is re-pushed as new
		expect(plan.pull.update).toHaveLength(0);
	});

	it("keeps the local id when the remote edits a pin in place", () => {
		const a = local(10, { lat: 1 });
		const mapping: RemoteMappingRow[] = [{ localId: 10, remoteId: 0, hash: hashOf(a) }];
		// Same slot, different heading: a remote-side edit, not a delete plus an add.
		const keyed = buildKeyedInputs(
			positional,
			[a],
			[raw({ lat: 1, heading: 42 })],
			mapping,
			tagName,
		);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

		expect(plan.pull.update).toEqual(["L:10"]);
		expect(plan.pull.create).toHaveLength(0);
		expect(plan.push.delete).toHaveLength(0);
	});

	it("recovers an edited pin by panoId even after an earlier delete shifts it", () => {
		const a = local(10, { lat: 1, panoId: "PANO_A", flags: 1 });
		const b = local(11, { lat: 2, panoId: "PANO_B", flags: 1 });
		const mapping: RemoteMappingRow[] = [
			{ localId: 10, remoteId: 0, hash: hashOf(a) },
			{ localId: 11, remoteId: 1, hash: hashOf(b) },
		];
		// Remote deleted #10 outright AND re-aimed #11, so #11's index and hash are both stale.
		const keyed = buildKeyedInputs(
			positional,
			[a, b],
			[raw({ lat: 2, panoId: "PANO_B", flags: 1, heading: 77 })],
			mapping,
			tagName,
		);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

		expect(plan.pull.update).toEqual(["L:11"]); // matched on pano, local id preserved
		expect(plan.pull.delete).toEqual(["L:10"]);
		expect(plan.pull.create).toHaveLength(0);
	});

	it("does not trust a bare index once the array length has changed", () => {
		const a = local(10, { lat: 1 });
		const b = local(11, { lat: 2 });
		const mapping: RemoteMappingRow[] = [
			{ localId: 10, remoteId: 0, hash: hashOf(a) },
			{ localId: 11, remoteId: 1, hash: hashOf(b) },
		];
		// Both remotes were replaced by unrelated content and one was dropped. Nothing can be
		// matched, so these must surface as deletes plus an add - never as a wrong pairing.
		const keyed = buildKeyedInputs(positional, [a, b], [raw({ lat: 500 })], mapping, tagName);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

		expect(plan.pull.delete.sort()).toEqual(["L:10", "L:11"]);
		expect(plan.pull.create).toHaveLength(1);
	});
});

describe("keying: provider projection and filtering", () => {
	it("erases unrepresentable fields on the local side so they never read as a difference", () => {
		// A pin carrying a panoId it does not load by. The remote cannot express that, and reports
		// panoId null; without projection this would diff forever.
		const loc = local(10, { panoId: "PANO", flags: 0 });
		const p = makeProvider({
			identity: "positional",
			supportsTags: false,
			project: (n) => ({ ...n, panoId: n.flags & 1 ? n.panoId : null, tags: [] }),
		});
		const projected = { ...localToNormalized(loc, tagName), panoId: null, tags: [] };
		const mapping: RemoteMappingRow[] = [{ localId: 10, remoteId: 0, hash: syncHash(projected) }];
		const keyed = buildKeyedInputs(p, [loc], [raw({ panoId: null })], mapping, tagName);
		const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

		expect(plan.push.update).toHaveLength(0);
		expect(plan.pull.update).toHaveLength(0);
		expect(keyed.local.get("L:10")?.panoId).toBeNull();
	});

	it("excludes locations the provider refuses, and deletes remotely once excluded", () => {
		const kept = local(10, { lat: 1 });
		const excluded = local(11, { lat: 2, flags: 2 });
		const p = makeProvider({ includeLocal: (l) => (l.flags & 2) === 0 });

		const fresh = buildKeyedInputs(p, [kept, excluded], [], [], tagName);
		expect(fresh.local.size).toBe(1);
		expect(computeSyncPlan(fresh.base, fresh.local, fresh.remote).push.create).toHaveLength(1);

		// Already synced, then marked excluded: it must be withdrawn from the remote.
		const mapping: RemoteMappingRow[] = [
			{ localId: 11, remoteId: 7, hash: hashOf(local(11, { lat: 2 })) },
		];
		const after = buildKeyedInputs(
			p,
			[kept, excluded],
			[raw({ lat: 2, rid: 7 })],
			mapping,
			tagName,
		);
		expect(computeSyncPlan(after.base, after.local, after.remote).push.delete).toEqual(["L:11"]);
	});
});
