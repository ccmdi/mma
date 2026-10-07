import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the extra-write invariants: `LocationPatch.extra` is a JSON Merge Patch
// (RFC 7386) — writers ship only the keys they touch and the store composes them
// against the authoritative base, so concurrent writers can never clobber each
// other's keys (the enrich-batch vs exact-date-hook race). applyPatch is
// the JS mirror of Rust's overlay_update and must agree with it.

type UpdateCall = { id: number; extra?: Record<string, unknown> | null }[];
const wire = vi.hoisted(() => ({
	updates: [] as UpdateCall[],
	undoable: [] as boolean[],
	gates: [] as (() => void)[],
	gated: false,
	active: null as unknown,
}));

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	const mutationResult = () => ({
		version: 0,
		selectionSync: null,
		values: {
			locationCount: 1,
			canUndo: true,
			canRedo: null,
			tagCounts: null,
			tags: null,
			fieldDefs: null,
		},
		step: null,
		active: wire.active,
	});
	return cmdProxy({
		storeGetMap: async () => testMap({ locationCount: 0 }),
		storeOpenMap: async () => openMapResult(),
		storeEdit: (_target: unknown, edits: unknown, opts: unknown) => {
			const puts = (edits as { put: Record<string, unknown> }[]).map((e) => e.put);
			wire.updates.push(puts as UpdateCall);
			wire.undoable.push((opts as { recordUndo?: boolean } | null)?.recordUndo as boolean);
			if (!wire.gated) return Promise.resolve(mutationResult());
			return new Promise((res) => wire.gates.push(() => res(mutationResult())));
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { openMap, openDuplicateLocation, updateLocations, getMapState } from "@/store/useMapStore";
import { createLocation, applyPatch } from "@/types";
import type { Location } from "@/bindings.gen";
import { LOCATION_MERGED } from "@/bindings.consts";

function makeLoc(extra: Record<string, unknown> | null = null): Location {
	return { ...createLocation({ lat: 1, lng: 2 }), id: 7, extra };
}

function patchExtra(loc: Location, extra: Record<string, unknown>) {
	return updateLocations([{ id: loc.id, extra }], { undoable: false });
}

beforeEach(async () => {
	wire.updates.length = 0;
	wire.undoable.length = 0;
	wire.gates.length = 0;
	wire.gated = false;
	wire.active = null;
	await openMap("m1");
});

describe("extra merge-patch writes via updateLocations", () => {
	it("ships only the patched keys, non-undoable", async () => {
		const loc = makeLoc({ existing: 1 });
		openDuplicateLocation(loc);

		await patchExtra(loc, { datetime: 111 });

		expect(wire.updates[0][0].extra).toEqual({ datetime: 111 });
		expect(wire.undoable[0]).toBe(false);
	});

	it("the active location becomes the row the store hands back", async () => {
		const loc = makeLoc({ existing: 1 });
		openDuplicateLocation(loc);
		const stored = { ...loc, extra: { existing: 1, datetime: 111 } };
		wire.active = stored;

		await patchExtra(loc, { datetime: 111 });

		expect(getMapState().activeLocation).toEqual(stored);
	});
});

describe("applyPatch — JS mirror of Rust overlay_update", () => {
	const base = makeLoc({ a: 1, b: 2 });

	it("merges extra keys and overwrites top-level fields", () => {
		const next = applyPatch(base, { heading: 90, extra: { b: 3, c: 4 } }, LOCATION_MERGED);
		expect(next.heading).toBe(90);
		expect(next.extra).toEqual({ a: 1, b: 3, c: 4 });
	});

	it("null value deletes its key; empty result becomes null", () => {
		expect(applyPatch(base, { extra: { a: null } }, LOCATION_MERGED).extra).toEqual({ b: 2 });
		expect(applyPatch(makeLoc({ a: 1 }), { extra: { a: null } }, LOCATION_MERGED).extra).toBeNull();
	});

	it("null patch clears extra entirely", () => {
		expect(applyPatch(base, { extra: null }, LOCATION_MERGED).extra).toBeNull();
	});

	it("absent extra leaves extra untouched", () => {
		expect(applyPatch(base, { heading: 90 }, LOCATION_MERGED).extra).toEqual({ a: 1, b: 2 });
	});
});
