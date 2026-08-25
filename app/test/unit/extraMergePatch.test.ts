import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the extra-write invariants: `LocationPatch.extra` is a JSON Merge Patch
// (RFC 7386) — writers ship only the keys they touch and the store composes them
// against the authoritative base, so concurrent writers can never clobber each
// other's keys (the enrich-batch vs exact-date-hook race). applyLocationPatch is
// the JS mirror of Rust's overlay_update and must agree with it.

type UpdateCall = { id: number; patch: { extra?: Record<string, unknown> | null } }[];
const wire = vi.hoisted(() => ({
	updates: [] as UpdateCall[],
	undoable: [] as boolean[],
	gates: [] as (() => void)[],
	gated: false,
}));

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	const mutationResult = () => ({
		delta: { added: [], updated: [], removed: [], fullReset: false },
		locationCount: 1,
		canUndo: true,
		canRedo: false,
		newFieldDefs: null,
		tags: null,
		tagCounts: null,
		knownFieldKeys: [],
	});
	return cmdProxy({
		storeGetMap: async () => testMap({ locationCount: 0 }),
		storeOpenMap: async () => openMapResult(),
		storeUpdateLocations: (updates: unknown, undoable: unknown) => {
			wire.updates.push(updates as UpdateCall);
			wire.undoable.push(undoable as boolean);
			if (!wire.gated) return Promise.resolve(mutationResult());
			return new Promise((res) => wire.gates.push(() => res(mutationResult())));
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { openMap, openDuplicateLocation, updateLocations, getMapState } from "@/store/useMapStore";
import { createLocation, applyLocationPatch } from "@/types";
import type { Location } from "@/types";

function makeLoc(extra: Record<string, unknown> | null = null): Location {
	return { ...createLocation({ lat: 1, lng: 2 }), id: 7, extra };
}

function patchExtra(loc: Location, extra: Record<string, unknown>) {
	return updateLocations([{ id: loc.id, patch: { extra } }], { undoable: false });
}

beforeEach(async () => {
	wire.updates.length = 0;
	wire.undoable.length = 0;
	wire.gates.length = 0;
	wire.gated = false;
	await openMap("m1");
});

describe("extra merge-patch writes via updateLocations", () => {
	it("ships only the patched keys, non-undoable", async () => {
		const loc = makeLoc({ existing: 1 });
		openDuplicateLocation(loc);

		await patchExtra(loc, { datetime: 111 });

		expect(wire.updates[0][0].patch.extra).toEqual({ datetime: 111 });
		expect(wire.undoable[0]).toBe(false);
	});

	it("a writer holding a stale snapshot cannot erase concurrently-written keys", async () => {
		const stale = makeLoc(); // snapshot from before any writes (enrich's `loc`)
		openDuplicateLocation(stale);

		await patchExtra(stale, { datetime: 111, timezone: "X/Y" });
		await patchExtra(stale, { imageDate: "2023-03", copyrightYear: 2023 });

		expect(getMapState().activeLocation?.extra).toMatchObject({
			datetime: 111,
			timezone: "X/Y",
			imageDate: "2023-03",
			copyrightYear: 2023,
		});
	});

	it("in-flight concurrent patches compose in the active cache", async () => {
		const loc = makeLoc();
		openDuplicateLocation(loc);
		wire.gated = true;

		const first = patchExtra(loc, { datetime: 111 });
		const second = patchExtra(loc, { copyrightYear: 2023 });
		wire.gates.forEach((release) => release());
		await Promise.all([first, second]);

		expect(getMapState().activeLocation?.extra).toMatchObject({
			datetime: 111,
			copyrightYear: 2023,
		});
	});

	it("null values delete keys from the active cache", async () => {
		const loc = makeLoc({ datetime: 111, keep: 1 });
		openDuplicateLocation(loc);

		await patchExtra(loc, { datetime: null as unknown as number });

		expect(getMapState().activeLocation?.extra).toEqual({ keep: 1 });
	});
});

describe("applyLocationPatch — JS mirror of Rust overlay_update", () => {
	const base = makeLoc({ a: 1, b: 2 });

	it("merges extra keys and overwrites top-level fields", () => {
		const next = applyLocationPatch(base, { heading: 90, extra: { b: 3, c: 4 } });
		expect(next.heading).toBe(90);
		expect(next.extra).toEqual({ a: 1, b: 3, c: 4 });
	});

	it("null value deletes its key; empty result becomes null", () => {
		expect(applyLocationPatch(base, { extra: { a: null } }).extra).toEqual({ b: 2 });
		expect(applyLocationPatch(makeLoc({ a: 1 }), { extra: { a: null } }).extra).toBeNull();
	});

	it("null patch clears extra entirely", () => {
		expect(applyLocationPatch(base, { extra: null }).extra).toBeNull();
	});

	it("absent extra leaves extra untouched", () => {
		expect(applyLocationPatch(base, { heading: 90 }).extra).toEqual({ a: 1, b: 2 });
	});
});
