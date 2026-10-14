// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EditCall = { target: { name: string }; edits: unknown[] };
const h = vi.hoisted(() => ({
	id: 0,
	order: [] as string[],
	edits: [] as EditCall[],
	lands: [] as string[],
	reads: [] as { target: { name: string }; selector: unknown; ask: unknown }[],
	drops: [] as { name: string; mapId?: string }[],
	mapId: "map-test" as string | null,
	blockNextEdit: false,
	started: null as (() => void) | null,
	release: null as (() => void) | null,
	failNextEdit: false,
}));

vi.mock("@/store/store", () => ({ Store: { get: () => ({ mapId: h.mapId }) } }));
vi.mock("@/store/edit", () => ({
	Edit: {
		locations: async (target: { name: string }, edits: unknown[]) => {
			h.order.push("edit");
			h.edits.push({ target, edits });
			if (h.blockNextEdit) {
				h.blockNextEdit = false;
				h.started?.();
				await new Promise<void>((resolve) => {
					h.release = resolve;
				});
			}
			if (h.failNextEdit) {
				h.failNextEdit = false;
				throw new Error("edit failed");
			}
			return { mutation: { version: 0, keys: [] }, changed: 0, failed: [] };
		},
	},
}));
vi.mock("@/store/mutation", () => ({
	Mutation: { run: (write: () => Promise<unknown>) => write() },
}));
vi.mock("@/store/query", () => ({
	Query: {
		read: async (selector: unknown, ask: unknown, target: { name: string }) => {
			h.order.push("read");
			h.reads.push({ target, selector, ask });
			return [];
		},
	},
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeLandLayer: async (name: string) => {
			h.order.push("land");
			h.lands.push(name);
			return { mutation: { version: 0, keys: [] } };
		},
		storeCloseLayer: async (name: string, mapId?: string) => {
			h.order.push("drop");
			h.drops.push({ name, mapId });
		},
	},
}));

import { Layer } from "@/store/layer";

beforeEach(() => {
	h.id = 0;
	h.order = [];
	h.edits = [];
	h.lands = [];
	h.reads = [];
	h.drops = [];
	h.mapId = "map-test";
	h.blockNextEdit = false;
	h.started = null;
	h.release = null;
	h.failNextEdit = false;
	vi.stubGlobal("crypto", { randomUUID: () => `test-${h.id++}` });
});

afterEach(() => vi.unstubAllGlobals());

describe("Layer", () => {
	it("initializes once and serializes edits, reads, and landing against the same target", async () => {
		const layer = await Layer.open();
		const name = layer.target.name;
		expect(h.edits).toHaveLength(1);
		expect(h.edits[0]).toMatchObject({ target: layer.target, edits: [] });

		h.order = [];
		h.edits = [];
		let signalStart!: () => void;
		const started = new Promise<void>((resolve) => (signalStart = resolve));
		h.started = signalStart;
		h.blockNextEdit = true;
		const patch = [{ put: { id: 7, lat: 9 } }] as never;
		const editing = layer.edit(patch);
		await started;
		const reading = layer.read(
			{ type: "Locations", locations: [7], name: null },
			{ kind: "locations" },
		);
		const landing = layer.land();

		expect(h.order).toEqual(["edit"]);
		h.release?.();
		await Promise.all([editing, reading, landing]);

		expect(h.order).toEqual(["edit", "read", "land"]);
		expect(h.edits.map((call) => call.target.name)).toEqual([name]);
		expect(h.lands).toEqual([name]);
		expect(h.reads).toEqual([
			{
				target: layer.target,
				selector: { type: "Locations", locations: [7], name: null },
				ask: { kind: "locations" },
			},
		]);
	});

	it("waits for admitted work before dropping and rejects new work after close", async () => {
		const layer = await Layer.open();
		h.order = [];
		let signalStart!: () => void;
		const started = new Promise<void>((resolve) => (signalStart = resolve));
		h.started = signalStart;
		h.blockNextEdit = true;
		const editing = layer.edit([{ put: { id: 7, lat: 9 } }] as never);
		await started;

		const closing = layer.close();
		expect(h.drops).toEqual([]);
		h.release?.();
		await Promise.all([editing, closing]);

		expect(h.order).toEqual(["edit", "drop"]);
		expect(h.drops).toEqual([{ name: layer.target.name, mapId: "map-test" }]);
		await expect(layer.edit([])).rejects.toThrow("Layer is closed");
		await layer.close();
		expect(h.drops).toHaveLength(1);
	});
	it("rejects operations after the map changes and drops from the captured map", async () => {
		const layer = await Layer.open();
		h.mapId = "map-next";

		await expect(
			layer.read({ type: "Locations", locations: [7], name: null }, { kind: "locations" }),
		).rejects.toThrow("Layer belongs to another map");
		await expect(layer.edit([])).rejects.toThrow("Layer belongs to another map");
		await layer.close();

		expect(h.drops).toEqual([{ name: layer.target.name, mapId: "map-test" }]);
	});
	it("drops an initialized target when opening edits fail", async () => {
		h.failNextEdit = true;
		await expect(Layer.open([{ put: { id: 7, lat: 9 } }] as never)).rejects.toThrow("edit failed");
		expect(h.edits).toHaveLength(1);
		expect(h.drops).toEqual([{ name: "layer:test-0", mapId: "map-test" }]);
	});
});
