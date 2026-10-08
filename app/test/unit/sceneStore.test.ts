// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	activeId: null as number | null,
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

vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({
		openRow: h.activeId == null ? null : { id: h.activeId },
		selectedLocationIds: h.selected,
	}),
	setSelectedLocationIds: () => {},
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

import {
	clearScene,
	getScene,
	loadScene,
	sceneReached,
	startSceneEngine,
} from "@/lib/render/sceneStore";
import { subscribe as subscribeEvent } from "@/lib/events";
import { entry, frame, scene } from "./fixtures/renderFixtures";

const notifyStore = () => (h.listeners.get("store:changed") ?? []).forEach((fn) => fn());

beforeEach(() => {
	h.activeId = null;
	h.selected = new Set();
	h.listeners.clear();
	h.marks = [];
	h.channels = [];
	h.subscribe = null;
	clearScene();
});

describe("sceneStore (single scene source)", () => {
	it("exposes one stable CellManager", () => {
		expect(getScene()).toBe(getScene());
	});

	it("active-location change bumps the scene version (fast path, no reload)", () => {
		let bumps = 0;
		const unsub = subscribeEvent("scene:changed", () => bumps++);
		const stop = startSceneEngine();

		h.activeId = 5;
		notifyStore();
		expect(bumps).toBeGreaterThan(0);

		const after = bumps;
		notifyStore(); // same active id -> no work, no bump
		expect(bumps).toBe(after);

		stop();
		unsub();
	});

	it("stops reacting to active changes after the engine stops", () => {
		const stop = startSceneEngine();
		stop();
		let bumps = 0;
		const unsub = subscribeEvent("scene:changed", () => bumps++);
		h.activeId = 9;
		notifyStore();
		expect(bumps).toBe(0);
		unsub();
	});
});

describe("sceneStore frames", () => {
	/** Start a load, wait for its subscription, and answer it with the scene `buf` holds. */
	async function load(buf: ArrayBuffer) {
		const done = loadScene("pin");
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
		expect(getScene().totalCount).toBe(2);
		expect(h.marks).toContain("markers");
	});

	it("frames on a channel a later load replaced are ignored", async () => {
		const first = await load(scene([entry("s", 1, 1, 1)], 3));
		h.channels = [];
		await load(scene([entry("s", 1, 1, 1)], 4));

		first.onmessage(added(5, 9));
		expect(getScene().totalCount).toBe(1);
	});

	it("a wait for a version gets that frame's summary, whether it landed before or after", async () => {
		const channel = await load(scene([entry("s", 1, 1, 1)], 3));

		channel.onmessage(added(4, 7));
		expect(Array.from((await sceneReached(4)).added)).toEqual([7]);

		const later = sceneReached(5);
		channel.onmessage(added(5, 8));
		expect(Array.from((await later).added)).toEqual([8]);
	});

	it("a frame that changes no marker does not repaint", async () => {
		const channel = await load(scene([entry("s", 1, 1, 1)], 3));
		let repaints = 0;
		const unsub = subscribeEvent("scene:changed", () => repaints++);
		channel.onmessage(frame({ version: 4 }));
		expect((await sceneReached(4)).version).toBe(4);
		expect(repaints).toBe(0);
		channel.onmessage(added(5, 7));
		expect(repaints).toBe(1);
		unsub();
	});

	it("a wait resolves at once when the scene follows no map", async () => {
		const s = await sceneReached(3);
		expect(s.version).toBe(3);
		expect(s.added).toHaveLength(0);
	});

	it("a replace frame from a reopened map answers every wait and forgets the old versions", async () => {
		const channel = await load(scene([entry("s", 1, 1, 1)], 30));
		const pending = sceneReached(31);
		channel.onmessage(scene([entry("s", 1, 1, 1)], 2));
		expect((await pending).replace).toBe(true);

		const next = sceneReached(3);
		channel.onmessage(added(3, 9));
		expect(Array.from((await next).added)).toEqual([9]);
	});

	it("clearing the scene releases every wait", async () => {
		await load(scene([], 3));
		const pending = sceneReached(10);
		clearScene();
		expect((await pending).added).toHaveLength(0);
	});

	it("a subscription that fails stops following", async () => {
		h.subscribe = () => Promise.reject(new Error("no map open"));
		await loadScene("pin");
		expect((await sceneReached(1)).version).toBe(1);
		expect(h.marks).not.toContain("markers");
	});
});
