import { describe, it, expect } from "vitest";
import type { Location } from "@/bindings.gen";
import { buildKeyedInputs } from "@/plugins/mapMakingSync/keying";
import { computeSyncPlan } from "@/plugins/mapMakingSync/diff";
import { syncHash, localToNormalized } from "@/plugins/mapMakingSync/adapter";
import type * as Remote from "@/plugins/mapMakingSync/remote-types";
import type { RemoteMappingRow } from "@/plugins/mapMakingSync/syncStore";

const NAMES = new Map([[1, "red"]]);
const tagName = (id: number) => NAMES.get(id);

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
function remote(id: number, over: Partial<Remote.Location> = {}): Remote.Location {
	return {
		id,
		location: { lat: 0, lng: 0 },
		panoId: null,
		heading: 0,
		pitch: 0,
		zoom: 0,
		createdAt: "1970-01-01T00:00:00Z",
		flags: 0,
		tags: [],
		...over,
	};
}

describe("mapMakingSync keying", () => {
	it("first sync: identical unmapped pins on both sides converge (adopt, no dup)", () => {
		const l = local(5, { lat: 1, lng: 2 });
		const r = remote(9000, { location: { lat: 1, lng: 2 } }); // same content, different ids
		const k = buildKeyedInputs([l], [r], [], tagName);
		const plan = computeSyncPlan(k.base, k.local, k.remote);
		expect(plan.converged).toHaveLength(1);
		expect(plan.push.create).toEqual([]);
		expect(plan.pull.create).toEqual([]);
		// the converged key resolves to both the local and remote originals (for recording the mapping)
		const key = plan.converged[0]!;
		expect(k.localById.get(key)?.id).toBe(5);
		expect(k.remoteById.get(key)?.id).toBe(9000);
	});

	it("first sync: one-sided pins become create on the correct side", () => {
		const k = buildKeyedInputs(
			[local(5, { lat: 1 })],
			[remote(9000, { location: { lat: 2, lng: 0 } })],
			[],
			tagName,
		);
		const plan = computeSyncPlan(k.base, k.local, k.remote);
		expect(plan.push.create).toHaveLength(1); // local-only -> push
		expect(plan.pull.create).toHaveLength(1); // remote-only -> pull
		expect(plan.converged).toEqual([]);
	});

	it("mapped pin keyed by local id; remote edit detected against base hash", () => {
		// map local 5 <-> remote 9000, base hash from the ORIGINAL content
		const orig = local(5, { lat: 1, lng: 2 });
		const mapping: RemoteMappingRow[] = [
			{ localId: 5, remoteId: 9000, hash: syncHash(localToNormalized(orig, tagName)) },
		];
		// local unchanged, remote moved
		const k = buildKeyedInputs(
			[orig],
			[remote(9000, { location: { lat: 9, lng: 9 } })],
			mapping,
			tagName,
		);
		const plan = computeSyncPlan(k.base, k.local, k.remote);
		expect(plan.pull.update).toEqual(["L:5"]);
		expect(k.remoteById.get("L:5")?.id).toBe(9000);
		expect(k.localById.get("L:5")?.id).toBe(5);
	});

	it("mapped pin deleted remotely -> pull.delete", () => {
		const orig = local(5, { lat: 1, lng: 2 });
		const mapping: RemoteMappingRow[] = [
			{ localId: 5, remoteId: 9000, hash: syncHash(localToNormalized(orig, tagName)) },
		];
		const k = buildKeyedInputs([orig], [], mapping, tagName); // remote gone
		const plan = computeSyncPlan(k.base, k.local, k.remote);
		expect(plan.pull.delete).toEqual(["L:5"]);
	});
});
