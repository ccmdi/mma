// Drives the built bundle directly. The maths is suncalc's `getPosition`, so what is
// pinned here is this module's own contract: the north-clockwise azimuth convention, the
// two-decimal rounding, which rows it touches, and which keys it emits.
import { test } from "node:test";
import assert from "node:assert/strict";

const failed = [];
globalThis.mma = { fail: (id) => failed.push(id), log: () => {} };

const { map, configure } = await import(new URL("../procedure.js", import.meta.url).href);

const row = (id, lat, lng, extra = { datetime: 1719835200 }) => ({ id, lat, lng, extra });

function runMap(rows, fields = null) {
	failed.length = 0;
	configure(fields === null ? null : { fields, force: false, config: null });
	const patches = map(rows);
	for (const p of patches) {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patches must be LocationPatch-shaped");
	}
	return patches.map((p) => ({ id: p.id, patch: p.patch.extra }));
}

/** Sun positions at four fixed instants, to the two decimals the module writes. */
test("known sun positions", () => {
	const cases = [
		// Zurich, 2024-07-01T12:00Z: early afternoon, sun past due south and high.
		[47.3769, 8.5417, 1719835200, { sunAzimuth: 196.44, sunAltitude: 64.98 }],
		// Sydney, 2024-01-01T00:00Z: mid-morning local, sun in the north-east.
		[-33.8688, 151.2093, 1704067200, { sunAzimuth: 75.22, sunAltitude: 61.94 }],
		// Helsinki, 2024-07-01T12:00Z: same instant as Zurich, further west of local noon.
		[60.17, 24.94, 1719835200, { sunAzimuth: 214.85, sunAltitude: 49.34 }],
		// Greenwich, 2024-06-21T00:00Z: midsummer midnight, sun just below the horizon.
		[51.4778, 0, 1718928000, { sunAzimuth: 359.51, sunAltitude: -15.08 }],
	];
	const patches = runMap(cases.map(([lat, lng, t], i) => row(i + 1, lat, lng, { datetime: t })));
	assert.deepEqual(
		patches.map((p) => p.patch),
		cases.map(([, , , expected]) => expected),
	);
});

test("azimuth is measured from north, clockwise, in [0,360)", () => {
	// At solar noon the sun is due south from the northern hemisphere and due north from
	// the southern one, so the convention is readable off the two values alone.
	const [greenwich, sydney] = runMap([
		row(1, 51.4778, 0, { datetime: 1718971386 }), // 2024-06-21 solar noon at Greenwich
		row(2, -33.8688, 151.2093, { datetime: 1704074361 }), // 2024-01-01 solar noon at Sydney
	]);
	assert.ok(Math.abs(greenwich.patch.sunAzimuth - 180) < 1, greenwich.patch.sunAzimuth);
	assert.ok(Math.abs(sydney.patch.sunAzimuth - 360) < 1, sydney.patch.sunAzimuth);

	// A full day of samples never leaves the range.
	const day = [];
	for (let h = 0; h < 24; h++) day.push(row(h + 1, 47.3769, 8.5417, { datetime: 1719792000 + h * 3600 }));
	for (const p of runMap(day)) {
		assert.ok(p.patch.sunAzimuth >= 0 && p.patch.sunAzimuth < 360, `${p.id}: ${p.patch.sunAzimuth}`);
		assert.ok(p.patch.sunAltitude >= -90 && p.patch.sunAltitude <= 90, `${p.id}: ${p.patch.sunAltitude}`);
	}
});

test("both values are rounded to two decimals", () => {
	const day = [];
	for (let h = 0; h < 24; h++) day.push(row(h + 1, 47.3769, 8.5417, { datetime: 1719792000 + h * 3600 }));
	for (const p of runMap(day)) {
		for (const v of [p.patch.sunAzimuth, p.patch.sunAltitude]) {
			assert.equal(v, Math.round(v * 100) / 100, `${v} is not rounded to 2dp`);
		}
	}
});

test("a datetime that is not a number is failed, not skipped", () => {
	const patches = runMap([
		row(1, 47.3769, 8.5417),
		row(2, 47.3769, 8.5417, null),
		row(3, 47.3769, 8.5417, { note: "no datetime" }),
		row(4, 47.3769, 8.5417, { datetime: "2024-07-01" }),
		row(5, 47.3769, 8.5417, { nested: { datetime: 1 }, other: 2 }),
	]);
	assert.deepEqual(
		patches.map((p) => p.id),
		[1],
	);
	assert.deepEqual(failed, [2, 3, 4, 5]);
});

test("a datetime outside the JS Date range fails the row", () => {
	const patches = runMap([
		row(1, 47.3769, 8.5417, { datetime: 9e12 }), // 9e15 ms, past the Date limit
		row(2, 47.3769, 8.5417, { datetime: -9e12 }),
		row(3, 47.3769, 8.5417, { datetime: Infinity }),
		row(4, 47.3769, 8.5417, { datetime: NaN }),
		row(5, 47.3769, 8.5417),
	]);
	assert.deepEqual(
		patches.map((p) => p.id),
		[5],
	);
	assert.deepEqual(failed, [1, 2, 3, 4]);
});

test("only the configured fields are emitted", () => {
	const one = row(1, 47.3769, 8.5417);

	assert.deepEqual(Object.keys(runMap([one])[0].patch), ["sunAzimuth", "sunAltitude"]);
	assert.deepEqual(Object.keys(runMap([one], ["sunAltitude"])[0].patch), ["sunAltitude"]);
	assert.deepEqual(Object.keys(runMap([one], ["sunAzimuth", "sunAltitude", "other"])[0].patch), [
		"sunAzimuth",
		"sunAltitude",
	]);
	assert.deepEqual(runMap([one], ["other"]), []);
});
