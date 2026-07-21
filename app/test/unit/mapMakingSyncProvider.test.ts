import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/types";
import {
	localToNormalized,
	normalizedToLocalFields,
	syncEqual,
	type NormalizedSyncLocation,
} from "@/lib/sync/normalized";
import type { PushBatch } from "@/lib/sync/provider";
import * as Remote from "@/plugins/mapMakingSync/remote-types";
import { mapMakingProvider as P } from "@/plugins/mapMakingSync/provider";

const NAMES = new Map([
	[10, "red"],
	[20, "blue"],
]);
const IDS = new Map([
	["red", 10],
	["blue", 20],
]);
const tagName = (id: number) => NAMES.get(id);
const tagId = (n: string) => IDS.get(n);

function localLoc(over: Partial<Location> = {}): Location {
	return {
		id: 1,
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

function remoteLoc(over: Partial<Remote.Location> = {}): Remote.Location {
	return {
		id: 1,
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

/** Simulate the server echoing a pushed location back as a full remote Location. */
function echo(item: Remote.Location, id: number): Remote.Location {
	return remoteLoc({
		...item,
		id,
		author: 1,
		panoDate: "2023-07-01T00:00:00Z",
		createdAt: "2024-01-01T00:00:00Z",
	});
}

describe("mapMakingSync provider — 1:1 contract", () => {
	it("declares the persisted provider identity", () => {
		expect(P.id).toBe("map-making.app");
		expect(P.identity).toBe("stable");
		expect(P.supportsTags).toBe(true);
		expect(P.remoteIdOf(remoteLoc({ id: 9000 }), 3)).toBe(9000);
	});

	it("push round-trips losslessly (local -> materialize -> normalize == local normalized)", () => {
		const L = localLoc({
			lat: 1.5,
			lng: 2.5,
			heading: 90,
			pitch: -5,
			zoom: 1.5,
			panoId: "abc",
			flags: LocationFlag.LoadAsPanoId | LocationFlag.ImportPreview, // virtual bit present
			tags: [20, 10],
		});
		const n = localToNormalized(L, tagName);
		expect(n.flags).toBe(LocationFlag.LoadAsPanoId); // virtual stripped
		expect(n.tags).toEqual(["blue", "red"]); // names, sorted
		const item = P.materialize(n, tagName);
		expect(item.tags).toEqual(["blue", "red"]);
		expect(P.normalize(echo(item, 555))).toEqual(n);
	});

	it("pull round-trips losslessly (remote -> normalize -> local fields == remote normalized)", () => {
		const R = remoteLoc({
			location: { lat: 3, lng: 4 },
			heading: 45,
			pitch: 2,
			zoom: null, // unpanned
			panoId: "xyz",
			flags: LocationFlag.Informational,
			tags: ["blue", "red"],
		});
		const n = P.normalize(R);
		const fields = normalizedToLocalFields(n, tagId);
		expect(fields.zoom).toBe(0); // null -> 0
		expect(fields.tags).toEqual([20, 10]);
		const L = localLoc({ ...fields, id: 7, createdAt: 123, modifiedAt: 99, extra: { foo: 1 } });
		expect(localToNormalized(L, tagName)).toEqual(n);
	});

	it("remote-only fields (author/panoDate/createdAt) never affect the contract", () => {
		const base = remoteLoc({ tags: ["red"] });
		const enriched = remoteLoc({
			tags: ["red"],
			author: 42,
			panoDate: "2020-01-01T00:00:00Z",
			createdAt: "2025-05-05T00:00:00Z",
		});
		expect(syncEqual(P.normalize(base), P.normalize(enriched))).toBe(true);
	});

	it("zoom null and 0 are equivalent (unpanned)", () => {
		expect(
			syncEqual(P.normalize(remoteLoc({ zoom: null })), P.normalize(remoteLoc({ zoom: 0 }))),
		).toBe(true);
	});

	it("normalize dedupes and sorts tag names", () => {
		expect(P.normalize(remoteLoc({ tags: ["red", "blue", "red"] })).tags).toEqual(["blue", "red"]);
	});

	it("unknown remote tag names are dropped (caller must pre-create them)", () => {
		const n = P.normalize(remoteLoc({ tags: ["red", "ghost"] }));
		expect(normalizedToLocalFields(n, tagId).tags).toEqual([10]);
	});

	it("virtual flags never cross to a push payload", () => {
		const L = localLoc({ flags: LocationFlag.SeenOverlay | LocationFlag.Informational });
		expect(P.materialize(localToNormalized(L, tagName), tagName).flags).toBe(
			LocationFlag.Informational,
		);
	});
});

// --- push wire semantics ---

const norm = (over: Partial<NormalizedSyncLocation> = {}): NormalizedSyncLocation => ({
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

const emptyBatch = (): PushBatch<Remote.Location> => ({
	create: [],
	update: [],
	delete: [],
	desired: [],
});

describe("mapMakingSync provider — push", () => {
	let sent: Remote.LocationEditRequest;
	let fetchMock: ReturnType<typeof vi.fn>;
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
			sent = JSON.parse(String(init.body)) as Remote.LocationEditRequest;
			const remap: Remote.LocationEditResult = {};
			sent.edits[0]!.create.forEach((c, i) => (remap[String(c.id)] = 7000 + i));
			return new Response(JSON.stringify(remap), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		(globalThis as { window?: unknown }).window = {
			MMA: { storage: () => ({ get: () => "key", set: () => {}, remove: () => {} }) },
		};
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		delete (globalThis as { window?: unknown }).window;
	});

	it("creates use negative placeholder ids and map back to the assigned ids", async () => {
		const batch = emptyBatch();
		batch.create.push({ localId: 11, item: P.materialize(norm({ lat: 1 }), tagName) });
		batch.create.push({ localId: 12, item: P.materialize(norm({ lat: 2 }), tagName) });

		const pushed = await P.push("449219", batch, undefined);

		const edit = sent.edits[0]!;
		expect(edit.action).toEqual({ type: Remote.EditActionType.Bulk });
		expect(edit.create.map((c) => c.id)).toEqual([-1, -2]);
		expect(edit.remove).toEqual([]);
		expect(pushed).toEqual([
			{ localId: 11, remoteId: 7000 },
			{ localId: 12, remoteId: 7001 },
		]);
	});

	it("an update is remove-old + create-new, and remaps the local id to the new remote id", async () => {
		const batch = emptyBatch();
		batch.update.push({
			localId: 42,
			item: P.materialize(norm({ lat: 5, tags: ["red"] }), tagName),
			replaces: remoteLoc({ id: 9000, location: { lat: 4, lng: 0 } }),
		});

		const pushed = await P.push("449219", batch, undefined);

		const edit = sent.edits[0]!;
		expect(edit.remove).toEqual([9000]); // the old remote id is dropped
		expect(edit.create).toHaveLength(1);
		expect(edit.create[0]!.id).toBe(-1); // ... and re-created under a placeholder
		expect(edit.create[0]!.location).toEqual({ lat: 5, lng: 0 });
		expect(edit.create[0]!.tags).toEqual(["red"]);
		expect(pushed).toEqual([{ localId: 42, remoteId: 7000 }]);
	});

	it("deletes are removed by remote id and produce no pushed ids", async () => {
		const batch = emptyBatch();
		batch.delete.push(remoteLoc({ id: 1234 }));

		const pushed = await P.push("449219", batch, undefined);

		expect(sent.edits[0]!.remove).toEqual([1234]);
		expect(sent.edits[0]!.create).toEqual([]);
		expect(pushed).toEqual([]);
	});

	it("one editLocations call covers create + update + delete", async () => {
		const batch = emptyBatch();
		batch.create.push({ localId: 1, item: P.materialize(norm({ lat: 1 }), tagName) });
		batch.update.push({
			localId: 2,
			item: P.materialize(norm({ lat: 2 }), tagName),
			replaces: remoteLoc({ id: 500 }),
		});
		batch.delete.push(remoteLoc({ id: 600 }));

		const pushed = await P.push("449219", batch, undefined);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sent.edits).toHaveLength(1);
		expect(sent.edits[0]!.create.map((c) => c.id)).toEqual([-1, -2]);
		expect(sent.edits[0]!.remove).toEqual([500, 600]);
		expect(pushed).toEqual([
			{ localId: 1, remoteId: 7000 },
			{ localId: 2, remoteId: 7001 },
		]);
	});

	it("an empty batch never hits the network", async () => {
		expect(await P.push("449219", emptyBatch(), undefined)).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
