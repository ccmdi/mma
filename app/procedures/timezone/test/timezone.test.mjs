// Drives the built bundle directly: `map` is the procedure's only entry point, and the
// zone lookup itself is @photostructure/tz-lookup, so only this module's own rules are
// worth pinning here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const tzlookup = createRequire(import.meta.url)("@photostructure/tz-lookup");

const failed = [];
globalThis.mma = { fail: (id) => failed.push(id), log: () => {} };

const { map } = await import(
	new URL("../../../src-tauri/procedures/timezone.js", import.meta.url).href
);

function runMap(rows) {
	failed.length = 0;
	const patches = map(rows);
	for (const p of patches) {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patches must be LocationPatch-shaped");
	}
	return { patches: patches.map((p) => ({ id: p.id, patch: p.patch.extra })), failed: [...failed] };
}

const row = (id, lat, lng, extra = { datetime: 1719835200 }) => ({ id, lat, lng, extra });

test("rows without a numeric datetime are skipped", () => {
	const { patches, failed } = runMap([
		row(1, 47.3769, 8.5417),
		row(2, 47.3769, 8.5417, null),
		row(3, 47.3769, 8.5417, { note: "no datetime" }),
		row(4, 47.3769, 8.5417, { datetime: "2024-07-01" }),
		row(5, 47.3769, 8.5417, { nested: { datetime: 1 }, other: 2 }),
	]);
	assert.deepEqual(failed, []);
	assert.deepEqual(
		patches.map((p) => p.id),
		[1],
	);
	assert.deepEqual(patches[0].patch, { timezone: "Europe/Zurich" });
});

test("out-of-range coordinates fail the row instead of patching it", () => {
	const { patches, failed } = runMap([
		row(1, 91, 0),
		row(2, 0, 181),
		row(3, -90.5, 0),
		row(4, NaN, 0),
		row(5, 48.8566, 2.3522),
	]);
	assert.deepEqual(failed, [1, 2, 3, 4]);
	assert.deepEqual(
		patches.map((p) => p.id),
		[5],
	);
	assert.deepEqual(patches[0].patch, { timezone: "Europe/Paris" });
});

test("the bundled dataset is the installed package", () => {
	const points = [
		[47.3769, 8.5417],
		[-33.8688, 151.2093],
		[0, 0],
		[90, 0],
		[-90, 0],
		[71, 25],
	];
	const { patches } = runMap(points.map(([lat, lng], i) => row(i + 1, lat, lng)));
	assert.deepEqual(
		patches.map((p) => p.patch.timezone),
		points.map(([lat, lng]) => tzlookup(lat, lng)),
	);
});
