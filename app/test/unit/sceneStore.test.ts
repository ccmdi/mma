// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	activeId: null as number | null,
	mapId: null as string | null,
	selected: new Set<number>(),
	listeners: new Map<string, Array<() => void>>(),
	marks: [] as string[],
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
		mapId: h.mapId,
		activeLocation: h.activeId == null ? null : { id: h.activeId },
		selectedLocationIds: h.selected,
	}),
	mapOpen: { mark: (phase: string) => h.marks.push(phase) },
	setSelectedLocationIds: () => {},
}));

vi.mock("@/lib/commands", () => ({
	cmd: { storeFillRenderFile: async () => "scene.bin" },
}));

import { getScene, loadScene, startSceneEngine } from "@/lib/render/sceneStore";
import { subscribe as subscribeEvent } from "@/lib/events";

const notifyStore = () => (h.listeners.get("store:changed") ?? []).forEach((fn) => fn());

beforeEach(() => {
	h.activeId = null;
	h.mapId = null;
	h.selected = new Set();
	h.listeners.clear();
	h.marks = [];
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

describe("sceneStore full load", () => {
	/** Load the scene while `during` runs between the render file request and its bytes. */
	async function loadAcross(during: () => void) {
		let release!: (buf: ArrayBuffer) => void;
		const bytes = new Promise<ArrayBuffer>((resolve) => (release = resolve));
		let requested!: () => void;
		const fetched = new Promise<void>((resolve) => (requested = resolve));
		vi.stubGlobal("fetch", async () => {
			during();
			requested();
			return { ok: true, arrayBuffer: () => bytes };
		});
		const init = vi.spyOn(getScene(), "initFromBinary").mockImplementation(() => {});
		const load = loadScene("pin");
		await fetched;
		release(new ArrayBuffer(0));
		await load;
		const initialized = init.mock.calls.length > 0;
		init.mockRestore();
		vi.unstubAllGlobals();
		return initialized;
	}

	it("a load for the map still open fills the scene and marks it", async () => {
		h.mapId = "a";
		expect(await loadAcross(() => {})).toBe(true);
		expect(h.marks).toContain("markers");
	});

	it("a load that outlives its map is dropped, so the next map's open is not marked early", async () => {
		h.mapId = "a";
		expect(
			await loadAcross(() => {
				h.mapId = "b";
			}),
		).toBe(false);
		expect(h.marks).not.toContain("markers");
	});
});
