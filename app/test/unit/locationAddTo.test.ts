import { Maps } from "@/store/maps";
import { Location } from "@/store/location";
import { createLocation } from "@/types";
import { describe, it, expect, vi, beforeEach } from "vitest";

const source = vi.hoisted(() => ({}) as Record<string, unknown>);
const calls = vi.hoisted(() => ({
	held: false,
	reads: [] as unknown[][],
	edits: [] as unknown[][],
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/commands", async () => {
	const { cmdProxy, openMapResult, readEach } = await import("./fixtures/mocks");
	return cmdProxy({
		storeOpenMap: async () => openMapResult(),
		storeRead: readEach(async (...args: unknown[]) => {
			calls.reads.push(args);
			if ((args[2] as { kind: string }).kind === "locations")
				return { kind: "locations", rows: { kind: "inline", locations: [source] } };
			return { kind: "held", held: [calls.held] };
		}),
		storeEdit: async (...args: unknown[]) => {
			calls.edits.push(args);
			return { mutation: { version: 0, keys: [1] } };
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const drop = createLocation({ lat: 1, lng: 2, panoId: "PANO", tags: [1] });
const records = { tags: { 1: { id: 1, name: "New" } } };
Object.assign(source, { ...drop, id: 7, createdAt: 1_600_000_000, modifiedAt: 1_700_000_000 });

beforeEach(async () => {
	calls.reads.length = 0;
	calls.edits.length = 0;
	await Maps.open("m1");
});

describe("Location.addTo", () => {
	it("asks the other map whether it holds the location, then adds it with its records", async () => {
		calls.held = false;
		expect(await Location.addTo("m2", drop, records)).toBe(true);
		expect(calls.reads[0][0]).toEqual({ kind: "map", id: "m2" });
		expect(calls.edits).toEqual([
			[{ locations: { target: { kind: "map", id: "m2" }, edits: [{ add: drop }], records } }],
		]);
	});

	it("adds nothing, and so creates no tag, when the other map already holds it", async () => {
		calls.held = true;
		expect(await Location.addTo("m2", drop, records)).toBe(false);
		expect(calls.edits).toEqual([]);
	});
});

describe("Location.duplicate", () => {
	it("leaves the creation time for the map to stamp now", async () => {
		await Location.duplicate(7);
		const [[{ locations }]] = calls.edits as [
			{ locations: { edits: [{ add: Record<string, unknown> }] } },
		][];
		const [{ add }] = locations.edits;
		expect(add).toMatchObject({ lat: 1, lng: 2, panoId: "PANO", createdAt: 0 });
	});
});
