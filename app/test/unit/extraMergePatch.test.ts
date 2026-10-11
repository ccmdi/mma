import { describe, it, expect, vi, beforeEach } from "vitest";

// updateLocations sends only changed extra keys, leaving the store to merge them.

type UpdateCall = { id: number; extra?: Record<string, unknown> | null }[];
const wire = vi.hoisted(() => ({
	updates: [] as UpdateCall[],
	gates: [] as (() => void)[],
	gated: false,
	active: null as unknown,
}));

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	const mutationResult = () => ({ mutation: { version: 0, keys: [] } });
	return cmdProxy({
		storeGetMap: async () => testMap({ locationCount: 0 }),
		storeOpenMap: async () => openMapResult(),
		storeEdit: (_target: unknown, edits: unknown) => {
			const puts = (edits as { put: Record<string, unknown> }[]).map((e) => e.put);
			wire.updates.push(puts as UpdateCall);
			if (!wire.gated) return Promise.resolve(mutationResult());
			return new Promise((res) => wire.gates.push(() => res(mutationResult())));
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
import { Maps } from "@/store/maps";
import { Editor } from "@/store/editor";
import { Location } from "@/store/location";
import { createLocation } from "@/types";

function makeLoc(extra: Record<string, unknown> | null = null): Location {
	return { ...createLocation({ lat: 1, lng: 2 }), id: 7, extra };
}

function patchExtra(loc: Location, extra: Record<string, unknown>) {
	return Location.update([{ id: loc.id, extra }]);
}

beforeEach(async () => {
	wire.updates.length = 0;
	wire.gates.length = 0;
	wire.gated = false;
	wire.active = null;
	await Maps.open("m1");
});

describe("extra merge-patch writes via updateLocations", () => {
	it("ships only the patched keys", async () => {
		const loc = makeLoc({ existing: 1 });
		Editor.openDuplicate(loc);

		await patchExtra(loc, { datetime: 111 });

		expect(wire.updates[0][0].extra).toEqual({ datetime: 111 });
	});
});
