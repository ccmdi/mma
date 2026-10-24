import { test } from "node:test";
import assert from "node:assert/strict";

const counts = { overlays: 0, finalized: 0, fetches: 0, subs: 0, unsubs: 0 };

const handlers = {};
const subscribe = (event, handler) => {
	counts.subs++;
	handlers[event] = handler;
	return () => counts.unsubs++;
};

const host = {
	createDeckOverlay: () => {
		counts.overlays++;
		return { setProps: () => {}, finalize: () => counts.finalized++ };
	},
	getZoom: () => 12,
	on: subscribe,
};

let plugin;
const store = {};
const watchers = new Set();
let lastSelector;

globalThis.__mma_require = () => ({ LineLayer: class {} });
globalThis.MMA = {
	registerPlugin: (p) => {
		plugin = p;
	},
	registerProvider: () => {},
	waitForMapHost: async () => host,
	fetchColumns: async (selector) => {
		counts.fetches++;
		lastSelector = selector;
		return [[], [], [], []];
	},
	on: subscribe,
	pluginSetting: (_id, key, fallback) => ({
		get: () => (key in store ? store[key] : fallback),
		set: (value) => {
			store[key] = value;
			for (const watch of [...watchers]) watch(key, value);
		},
		on: (listener) => {
			counts.subs++;
			const watch = (changed, value) => changed === key && listener(value);
			watchers.add(watch);
			return () => {
				counts.unsubs++;
				watchers.delete(watch);
			};
		},
	}),
	all: (...selectors) => ({ type: "Intersection", selectors }),
	has: (field) => ({ has: field }),
	selectorForPick: (pick) => ({ type: pick.pick === "all" ? "Everything" : "Selected" }),
	ui: {},
};

const { showRays } = await import(new URL("../index.js", import.meta.url).href);

const setting = (key, value) => {
	store[key] = value;
	for (const watch of [...watchers]) watch(key, value);
};

// Activation and the stub fetch resolve through promise continuations.
// setImmediate provides an event-loop fence after those microtasks settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an activated plugin stays idle until the rays are turned on", async () => {
	const teardown = plugin.activate();
	await settle();
	assert.deepEqual({ overlays: counts.overlays, fetches: counts.fetches }, { overlays: 0, fetches: 0 });
	teardown();
});

test("turning the rays on mounts one overlay, however often it is asked", async () => {
	showRays(true);
	showRays(true);
	await settle();
	assert.equal(counts.overlays, 1);
	assert.equal(counts.fetches, 1);
	assert.ok(counts.subs > 0);
});

test("the rays come from the picked locations that have a sun bearing", () => {
	assert.deepEqual(lastSelector, {
		type: "Intersection",
		selectors: [{ type: "Everything" }, { has: "sunAzimuth" }],
	});
});

test("only the selection source reloads on a selection change", async () => {
	const wait = () => new Promise((resolve) => setTimeout(resolve, 150));
	store.source = { pick: "all" };
	let before = counts.fetches;
	handlers["selection:change"]([]);
	await wait();
	assert.equal(counts.fetches, before);

	store.source = { pick: "selection" };
	before = counts.fetches;
	handlers["selection:change"]([]);
	await wait();
	assert.equal(counts.fetches, before + 1);
	delete store.source;
});

test("changing the source reloads the rays from it", async () => {
	const before = counts.fetches;
	setting("source", { pick: "selection" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(counts.fetches, before + 1);
	assert.deepEqual(lastSelector.selectors[0], { type: "Selected" });
	delete store.source;
});

test("cycling the toggle leaks no overlay and no listener", async () => {
	for (let i = 0; i < 3; i++) {
		showRays(false);
		await settle();
		showRays(true);
		await settle();
	}
	showRays(false);
	await settle();
	assert.equal(counts.overlays, counts.finalized);
	assert.equal(counts.subs, counts.unsubs);
});

test("the stored preference decides what activation starts, and its changes follow", async () => {
	store.showRays = true;
	const teardown = plugin.activate();
	await settle();
	assert.equal(counts.overlays, counts.finalized + 1);
	setting("showRays", false);
	await settle();
	assert.equal(counts.overlays, counts.finalized);
	setting("showRays", true);
	await settle();
	assert.equal(counts.overlays, counts.finalized + 1);
	teardown();
	await settle();
	assert.equal(counts.overlays, counts.finalized);
	assert.equal(counts.subs, counts.unsubs);
	delete store.showRays;
});

test("the rays reload for a change that moved locations, and for no other change", async () => {
	showRays(true);
	await settle();
	const before = counts.fetches;
	const wait = () => new Promise((resolve) => setTimeout(resolve, 150));
	handlers["store:change"]({ added: [], updated: [], removed: [] });
	await wait();
	assert.equal(counts.fetches, before);
	handlers["store:change"]({ added: [], updated: [7], removed: [] });
	await wait();
	assert.equal(counts.fetches, before + 1);
	showRays(false);
	await settle();
});
