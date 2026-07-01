import { describe, it, expect } from "vitest";
import { syncHash, type NormalizedSyncLocation } from "@/plugins/mapMakingSync/adapter";
import {
	computeSyncPlan,
	summarize,
	isNoop,
	type SyncState,
	type BaseHashes,
} from "@/plugins/mapMakingSync/diff";

function n(over: Partial<NormalizedSyncLocation> = {}): NormalizedSyncLocation {
	return {
		lat: 0,
		lng: 0,
		heading: 0,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags: [],
		...over,
	};
}

/** Build a current-state map (full locations). */
const state = (entries: Record<string, NormalizedSyncLocation>): SyncState =>
	new Map(Object.entries(entries));
/** Build a base map (fingerprints only) from the locations agreed at last sync. */
const hashes = (entries: Record<string, NormalizedSyncLocation>): BaseHashes =>
	new Map(Object.entries(entries).map(([k, v]) => [k, syncHash(v)]));

const NOSTATE: SyncState = new Map();
const NOBASE: BaseHashes = new Map();

describe("mapMakingSync diff — three-way merge (hash-based base)", () => {
	it("no changes anywhere is a no-op", () => {
		const v = { a: n({ lat: 1 }) };
		expect(isNoop(computeSyncPlan(hashes(v), state(v), state(v)))).toBe(true);
	});

	// --- First sync (empty base) ---

	it("first sync: local-only -> push.create, remote-only -> pull.create", () => {
		const plan = computeSyncPlan(NOBASE, state({ a: n({ lat: 1 }) }), state({ b: n({ lat: 2 }) }));
		expect(plan.push.create).toEqual(["a"]);
		expect(plan.pull.create).toEqual(["b"]);
		expect(plan.conflicts).toHaveLength(0);
	});

	it("first sync: same identity added identically on both sides -> converged (adopt)", () => {
		const v = n({ lat: 5, tags: ["x"] });
		const plan = computeSyncPlan(NOBASE, state({ a: v }), state({ a: { ...v } }));
		expect(plan.converged).toEqual(["a"]);
		expect(isNoop(plan)).toBe(true);
	});

	it("first sync: same identity added differently -> add-add conflict", () => {
		const plan = computeSyncPlan(NOBASE, state({ a: n({ lat: 5 }) }), state({ a: n({ lat: 6 }) }));
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0]!.kind).toBe("add-add");
	});

	// --- Steady state (base present), one side moves ---

	it("local modified, remote unchanged -> push.update", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), state({ a: n({ lat: 2 }) }), state(b));
		expect(plan.push.update).toEqual(["a"]);
		expect(summarize(plan).actionable).toBe(1);
	});

	it("remote modified, local unchanged -> pull.update", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), state(b), state({ a: n({ lat: 2 }) }));
		expect(plan.pull.update).toEqual(["a"]);
	});

	it("local deleted, remote unchanged -> push.delete", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), NOSTATE, state(b));
		expect(plan.push.delete).toEqual(["a"]);
	});

	it("remote deleted, local unchanged -> pull.delete", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), state(b), NOSTATE);
		expect(plan.pull.delete).toEqual(["a"]);
	});

	// --- Steady state, both sides move ---

	it("both modified to the same value -> converged (no apply)", () => {
		const b = { a: n({ lat: 1 }) };
		const moved = n({ lat: 9 });
		const plan = computeSyncPlan(hashes(b), state({ a: moved }), state({ a: { ...moved } }));
		expect(plan.converged).toEqual(["a"]);
		expect(isNoop(plan)).toBe(true);
	});

	it("both modified differently -> update-update conflict", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(
			hashes(b),
			state({ a: n({ lat: 2 }) }),
			state({ a: n({ lat: 3 }) }),
		);
		expect(plan.conflicts[0]).toMatchObject({ key: "a", kind: "update-update" });
		expect(plan.conflicts[0]!.local).toEqual(n({ lat: 2 }));
		expect(plan.conflicts[0]!.remote).toEqual(n({ lat: 3 }));
	});

	it("both deleted -> converged", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), NOSTATE, NOSTATE);
		expect(plan.converged).toEqual(["a"]);
		expect(isNoop(plan)).toBe(true);
	});

	it("local deleted, remote modified -> delete-update conflict", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), NOSTATE, state({ a: n({ lat: 2 }) }));
		expect(plan.conflicts[0]).toMatchObject({ key: "a", kind: "delete-update" });
		expect(plan.conflicts[0]!.local).toBeNull();
		expect(plan.conflicts[0]!.remote).toEqual(n({ lat: 2 }));
	});

	it("remote deleted, local modified -> delete-update conflict", () => {
		const b = { a: n({ lat: 1 }) };
		const plan = computeSyncPlan(hashes(b), state({ a: n({ lat: 2 }) }), NOSTATE);
		expect(plan.conflicts[0]).toMatchObject({ key: "a", kind: "delete-update" });
		expect(plan.conflicts[0]!.remote).toBeNull();
	});

	// --- Mixed batch + counts ---

	it("classifies a mixed batch correctly and summarizes", () => {
		const baseObjs = {
			same: n({ lat: 0 }),
			locmod: n({ lat: 1 }),
			remmod: n({ lat: 2 }),
			locdel: n({ lat: 3 }),
			remdel: n({ lat: 4 }),
			conflict: n({ lat: 5 }),
		};
		const local = state({
			same: n({ lat: 0 }),
			locmod: n({ lat: 11 }), // push.update
			remmod: n({ lat: 2 }),
			// locdel removed -> push.delete
			remdel: n({ lat: 4 }),
			conflict: n({ lat: 51 }), // conflict
			locnew: n({ lat: 100 }), // push.create
		});
		const remote = state({
			same: n({ lat: 0 }),
			locmod: n({ lat: 1 }),
			remmod: n({ lat: 22 }), // pull.update
			locdel: n({ lat: 3 }),
			// remdel removed -> pull.delete
			conflict: n({ lat: 52 }), // conflict
			remnew: n({ lat: 200 }), // pull.create
		});
		const plan = computeSyncPlan(hashes(baseObjs), local, remote);
		const c = summarize(plan);
		expect(c.push).toEqual({ create: 1, update: 1, delete: 1 });
		expect(c.pull).toEqual({ create: 1, update: 1, delete: 1 });
		expect(c.conflicts).toBe(1);
		expect(c.actionable).toBe(7);
		expect(plan.push.create).toEqual(["locnew"]);
		expect(plan.pull.create).toEqual(["remnew"]);
		expect(plan.conflicts[0]!.key).toBe("conflict");
	});
});
