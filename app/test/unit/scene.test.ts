// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	listeners: new Map<string, Array<(payload?: unknown) => void>>(),
	marks: [] as string[],
	channels: [] as { onmessage: (buf: ArrayBuffer) => void }[],
	subscribe: null as null | (() => Promise<null>),
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (buf: ArrayBuffer) => void = () => {};
	},
}));

vi.mock("@/lib/events", () => ({
	emit: (evt: string, payload?: unknown) => {
		for (const fn of h.listeners.get(evt) ?? []) fn(payload);
	},
	useEventValue: (_evt: string, get: () => unknown) => get(),
	subscribe: (evt: string, fn: (payload?: unknown) => void) => {
		let list = h.listeners.get(evt);
		if (!list) {
			list = [];
			h.listeners.set(evt, list);
		}
		list.push(fn);
		return () => {
			const l = h.listeners.get(evt);
			if (l)
				h.listeners.set(
					evt,
					l.filter((f) => f !== fn),
				);
		};
	},
}));

vi.mock("@/lib/util/debug", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/util/debug")>()),
	mapOpen: { mark: (phase: string) => h.marks.push(phase) },
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeSubscribeFrames: (channel: { onmessage: (buf: ArrayBuffer) => void }) => {
			h.channels.push(channel);
			return h.subscribe ? h.subscribe() : Promise.resolve(null);
		},
	},
}));
import { Scene } from "@/lib/render/scene";
import { emit, subscribe as subscribeEvent } from "@/lib/events";
import { entry, frame, paint, scene } from "./fixtures/renderFixtures";

const visibleByte = (id: number) => {
	for (const cb of Scene.get().cells.values()) {
		const i = cb.idToIndex.get(id);
		if (i != null) return cb.visible[i];
	}
	return null;
};

beforeEach(() => {
	emit("open:change", null);
	h.marks = [];
	h.channels = [];
	h.subscribe = null;
	Scene.clear();
});

describe("Scene (single scene source)", () => {
	it("exposes one stable CellManager", () => {
		expect(Scene.get()).toBe(Scene.get());
	});

	it("opening a map row repaints without a reload", () => {
		let bumps = 0;
		const unsub = subscribeEvent("scene:changed", () => bumps++);
		emit("open:change", 5);
		expect(bumps).toBe(1);
		unsub();
	});
});

describe("Scene frames", () => {
	/** Start a load, wait for its subscription, and answer it with the scene `buf` holds. */
	async function load(buf: ArrayBuffer) {
		const done = Scene.load("pin");
		await vi.waitFor(() => expect(h.channels.length).toBeGreaterThan(0));
		const channel = h.channels.at(-1)!;
		channel.onmessage(buf);
		await done;
		return channel;
	}

	const added = (version: number, id: number) =>
		frame({ version, cells: [{ cell: "s", add: [{ key: id, lng: id, lat: id }] }] });

	it("the open map row stays hidden across a clear and the next load", async () => {
		await load(scene([entry("s", 1, 1, 1), entry("s", 2, 2, 2)], 3));
		emit("open:change", 1);
		expect(visibleByte(1)).toBe(0);
		Scene.clear();
		h.channels = [];
		await load(scene([entry("s", 1, 1, 1), entry("s", 2, 2, 2)], 4));
		expect(visibleByte(1)).toBe(0);
		expect(visibleByte(2)).toBe(255);
	});

	it("an opening that names no map row shows every row again", async () => {
		await load(scene([entry("s", 1, 1, 1)], 3));
		emit("open:change", 1);
		emit("open:change", null);
		expect(visibleByte(1)).toBe(255);
	});

	it("the selected ids come from the frames, and a clear empties them", async () => {
		await load(scene([entry("s", 1, 1, 1, 0, paint([255, 0, 0])), entry("s", 2, 2, 2)], 3));
		expect([...Scene.selected()]).toEqual([1]);
		Scene.clear();
		expect(Scene.selected().size).toBe(0);
	});

	it("a load fills the scene from the replace frame and marks it", async () => {
		await load(scene([entry("s", 1, 1, 1), entry("t", 2, 2, 2)], 3));
		expect(Scene.get().totalCount).toBe(2);
		expect(h.marks).toContain("markers");
	});

	it("frames on a channel a later load replaced are ignored", async () => {
		const first = await load(scene([entry("s", 1, 1, 1)], 3));
		h.channels = [];
		await load(scene([entry("s", 1, 1, 1)], 4));

		first.onmessage(added(5, 9));
		expect(Scene.get().totalCount).toBe(1);
	});

	it("a wait for a version gets that frame's summary, whether it landed before or after", async () => {
		const channel = await load(scene([entry("s", 1, 1, 1)], 3));

		channel.onmessage(added(4, 7));
		expect(Array.from((await Scene.reached(4)).added)).toEqual([7]);

		const later = Scene.reached(5);
		channel.onmessage(added(5, 8));
		expect(Array.from((await later).added)).toEqual([8]);
	});

	it("a frame that changes no marker does not repaint", async () => {
		const channel = await load(scene([entry("s", 1, 1, 1)], 3));
		let repaints = 0;
		const unsub = subscribeEvent("scene:changed", () => repaints++);
		channel.onmessage(frame({ version: 4 }));
		expect((await Scene.reached(4)).version).toBe(4);
		expect(repaints).toBe(0);
		channel.onmessage(added(5, 7));
		expect(repaints).toBe(1);
		unsub();
	});

	it("a wait resolves at once when the scene follows no map", async () => {
		const s = await Scene.reached(3);
		expect(s.version).toBe(3);
		expect(s.added).toHaveLength(0);
	});

	it("a replace frame from a reopened map answers every wait and forgets the old versions", async () => {
		const channel = await load(scene([entry("s", 1, 1, 1)], 30));
		const pending = Scene.reached(31);
		channel.onmessage(scene([entry("s", 1, 1, 1)], 2));
		expect((await pending).replace).toBe(true);

		const next = Scene.reached(3);
		channel.onmessage(added(3, 9));
		expect(Array.from((await next).added)).toEqual([9]);
	});

	it("clearing the scene releases every wait", async () => {
		await load(scene([], 3));
		const pending = Scene.reached(10);
		Scene.clear();
		expect((await pending).added).toHaveLength(0);
	});

	it("a subscription that fails stops following", async () => {
		h.subscribe = () => Promise.reject(new Error("no map open"));
		await Scene.load("pin");
		expect((await Scene.reached(1)).version).toBe(1);
		expect(h.marks).not.toContain("markers");
	});
});
