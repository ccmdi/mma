// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	openId: null as number | null,
	selected: new Set<number>(),
	listeners: new Map<string, Array<() => void>>(),
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
	emit: (evt: string) => {
		for (const fn of h.listeners.get(evt) ?? []) fn();
	},
	subscribe: (evt: string, fn: () => void) => {
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

vi.mock("@/store/store", () => ({
	Store: {
		get: () => ({ selectedLocationIds: h.selected }),
		setSelected: () => {},
	},
}));

vi.mock("@/store/editor", () => ({
	Editor: {
		get: () => ({ open: h.openId == null ? null : { location: { id: h.openId } } }),
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
import { subscribe as subscribeEvent } from "@/lib/events";
import { entry, frame, scene } from "./fixtures/renderFixtures";

const notifyEditor = () => (h.listeners.get("editor:changed") ?? []).forEach((fn) => fn());

beforeEach(() => {
	h.openId = null;
	h.selected = new Set();
	h.listeners.clear();
	h.marks = [];
	h.channels = [];
	h.subscribe = null;
	Scene.clear();
});

describe("Scene (single scene source)", () => {
	it("exposes one stable CellManager", () => {
		expect(Scene.get()).toBe(Scene.get());
	});

	it("open-location change bumps the scene version (fast path, no reload)", () => {
		let bumps = 0;
		const unsub = subscribeEvent("scene:changed", () => bumps++);
		const stop = Scene.start();

		h.openId = 5;
		notifyEditor();
		expect(bumps).toBeGreaterThan(0);

		const after = bumps;
		notifyEditor(); // same active id -> no work, no bump
		expect(bumps).toBe(after);

		stop();
		unsub();
	});

	it("stops reacting to active changes after the engine stops", () => {
		const stop = Scene.start();
		stop();
		let bumps = 0;
		const unsub = subscribeEvent("scene:changed", () => bumps++);
		h.openId = 9;
		notifyEditor();
		expect(bumps).toBe(0);
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
