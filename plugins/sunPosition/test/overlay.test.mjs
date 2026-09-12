import { test } from "node:test";
import assert from "node:assert/strict";

const counts = { overlays: 0, finalized: 0, fetches: 0, subs: 0, unsubs: 0 };

const subscribe = () => {
	counts.subs++;
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
let stored = false;

globalThis.__mma_require = () => ({ LineLayer: class {} });
globalThis.MMA = {
	registerPlugin: (p) => {
		plugin = p;
	},
	registerEnrichFields: () => {},
	registerProvider: () => {},
	waitForMapHost: async () => host,
	fetchColumns: async () => {
		counts.fetches++;
		return [[], [], [], []];
	},
	on: subscribe,
	storage: () => ({ get: () => stored }),
	usePluginState: () => [false, () => {}],
	ui: {},
};

const { showRays } = await import(new URL("../index.js", import.meta.url).href);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an activated plugin stays idle until the rays are turned on", async () => {
	plugin.activate();
	await settle();
	assert.deepEqual(
		{ overlays: counts.overlays, fetches: counts.fetches, subs: counts.subs },
		{ overlays: 0, fetches: 0, subs: 0 },
	);
});

test("turning the rays on mounts one overlay, however often it is asked", async () => {
	showRays(true);
	showRays(true);
	await settle();
	assert.equal(counts.overlays, 1);
	assert.equal(counts.fetches, 1);
	assert.ok(counts.subs > 0);
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

test("the stored preference decides what activation starts", async () => {
	stored = true;
	const teardown = plugin.activate();
	await settle();
	assert.equal(counts.overlays, counts.finalized + 1);
	teardown();
	await settle();
	assert.equal(counts.overlays, counts.finalized);
	assert.equal(counts.subs, counts.unsubs);
});
