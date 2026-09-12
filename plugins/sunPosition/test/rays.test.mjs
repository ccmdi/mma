import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.__mma_require = () => ({ LineLayer: class {} });
globalThis.MMA = {
	registerPlugin: () => {},
	registerEnrichFields: () => {},
	registerProvider: () => {},
	waitForMapHost: () => new Promise(() => {}),
	fetchColumns: async () => [],
	on: () => () => {},
	storage: () => ({ get: (_key, fallback) => fallback }),
	usePluginState: () => [false, () => {}],
	ui: {},
};

const { sunIsUp, rayLength, rayColor, daylightRays, rayTargets } = await import(
	new URL("../index.js", import.meta.url).href
);

const WORLD_PX = 256;
const RAD = Math.PI / 180;

function mercatorPixels(lng, lat, zoom) {
	const world = WORLD_PX * 2 ** zoom;
	const sin = Math.sin(lat * RAD);
	return {
		x: ((lng + 180) / 360) * world,
		y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
	};
}

function screenRay(lat, lng, azimuth, lengthPx, zoom) {
	const rays = daylightRays([lat], [lng], [azimuth], [45]);
	const target = rayTargets(rays, lengthPx, zoom);
	const from = mercatorPixels(lng, lat, zoom);
	const to = mercatorPixels(target[0], target[1], zoom);
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	return {
		pixels: Math.hypot(dx, dy),
		bearing: (Math.atan2(dx, -dy) / RAD + 360) % 360,
	};
}

test("a ray is drawn only where the sun is above the horizon", () => {
	assert.equal(sunIsUp(0.1), true);
	assert.equal(sunIsUp(0), false);
	assert.equal(sunIsUp(-15.08), false);
	assert.equal(sunIsUp(null), false);
	assert.equal(sunIsUp(undefined), false);
	assert.equal(sunIsUp("45"), false);
});

test("daylightRays keeps only complete daytime rows, packed as [lng, lat]", () => {
	const rays = daylightRays(
		[47.3769, -33.8688, 51.4778, 60.17, 10],
		[8.5417, 151.2093, 0, 24.94, null],
		[196.44, 75.22, 359.51, null, 90],
		[64.98, 61.94, -15.08, 49.34, 30],
	);
	assert.deepEqual([...rays.bearing], [196.44, 75.22]);
	assert.deepEqual([...rays.source], [8.5417, 47.3769, 151.2093, -33.8688]);
});

test("the ray holds its pixel length and its bearing at every zoom", () => {
	for (const zoom of [2, 8, 14, 20]) {
		for (const lat of [0, 47.3769, -33.8688, 66]) {
			for (const azimuth of [0, 75.22, 180, 270, 359.51]) {
				const { pixels, bearing } = screenRay(lat, 8.5417, azimuth, 28, zoom);
				assert.ok(Math.abs(pixels - 28) < 0.001, `${zoom}/${lat}/${azimuth}: ${pixels}px`);
				assert.ok(Math.abs(((bearing - azimuth + 540) % 360) - 180) < 0.001, `${bearing}`);
			}
		}
	}
});

test("ray length scales the screen ray and nothing else", () => {
	const short = screenRay(47.3769, 8.5417, 120, 10, 12);
	const long = screenRay(47.3769, 8.5417, 120, 40, 12);
	assert.ok(Math.abs(long.pixels / short.pixels - 4) < 0.01);
	assert.ok(Math.abs(long.bearing - short.bearing) < 0.01);
});

test("a bad length or colour falls back to the declared default", () => {
	assert.equal(rayLength(40), 40);
	assert.equal(rayLength("40"), 40);
	assert.equal(rayLength(40.4), 40);
	assert.equal(rayLength(0), 28);
	assert.equal(rayLength(-5), 28);
	assert.equal(rayLength("wide"), 28);
	assert.equal(rayLength(undefined), 28);

	assert.deepEqual(rayColor([0, 255, 136]), [0, 255, 136]);
	assert.deepEqual(rayColor([0, 256, 136]), [255, 179, 0]);
	assert.deepEqual(rayColor([0, 255]), [255, 179, 0]);
	assert.deepEqual(rayColor("#00ff88"), [255, 179, 0]);
	assert.deepEqual(rayColor(undefined), [255, 179, 0]);
});
