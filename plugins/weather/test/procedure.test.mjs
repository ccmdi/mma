// Drives the built bundle directly: the URL `request` builds and the patches `map`
// derives from an Open-Meteo archive response.
import { test } from "node:test";
import assert from "node:assert/strict";

const failed = [];
globalThis.mma = { fail: (id) => failed.push(id), log: () => {} };

const { request, map, configure } = await import(new URL("../procedure.js", import.meta.url).href);

// --- the JS builder, kept verbatim as the URL parity reference -----------------

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const PARAMS = [
	"weather_code",
	"cloud_cover",
	"precipitation",
	"snow_depth",
	"snowfall",
	"temperature_2m",
	"sunshine_duration",
	"wind_speed_10m",
];

function pad(n) {
	return String(n).padStart(2, "0");
}

function utcDateAndHour(unixSeconds) {
	const d = new Date(unixSeconds * 1000);
	const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	return { date, hourKey: `${date}T${pad(d.getUTCHours())}:00` };
}

function referenceUrl(locs, params = PARAMS) {
	const lat = locs.map((l) => l.lat).join(",");
	const lng = locs.map((l) => l.lng).join(",");
	const dates = locs.map((l) => utcDateAndHour(l.datetime).date).join(",");
	return (
		`${ARCHIVE_URL}?latitude=${lat}&longitude=${lng}` +
		`&start_date=${dates}&end_date=${dates}` +
		`&hourly=${params.join(",")}&timezone=GMT`
	);
}

/// extra key -> hourly param, in request order.
const FIELD_PARAM = {
	weatherCode: "weather_code",
	cloudCover: "cloud_cover",
	precipitation: "precipitation",
	snowDepth: "snow_depth",
	snowfall: "snowfall",
	temperature2m: "temperature_2m",
	sunshineDuration: "sunshine_duration",
	windSpeed10m: "wind_speed_10m",
};

// --- harness ------------------------------------------------------------------

function toRows(locs) {
	return locs.map((l) => ({
		id: l.id,
		lat: l.lat,
		lng: l.lng,
		extra: l.extra !== undefined ? l.extra : { datetime: l.datetime },
	}));
}

function apply(fields) {
	configure(fields === null ? null : { fields, force: false, config: null });
}

function runRequest(locs, fields = null) {
	apply(fields);
	return request(toRows(locs));
}

function runMap(locs, status, body, fields = null) {
	apply(fields);
	failed.length = 0;
	const patches = map(toRows(locs), { status, body: new TextEncoder().encode(body) });
	for (const p of patches) {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patches must be LocationPatch-shaped");
	}
	return { patches: patches.map((p) => ({ id: p.id, patch: p.patch.extra })), failed: [...failed] };
}

// --- canned Open-Meteo response -----------------------------------------------

/** One coordinate's result: 24 hourly stamps for `date`, values keyed off the hour. */
function coordResult(date, overrides = {}) {
	const time = [];
	for (let h = 0; h < 24; h++) time.push(`${date}T${pad(h)}:00`);
	const hourly = { time };
	for (const p of PARAMS) hourly[p] = time.map((_, h) => h);
	Object.assign(hourly, overrides);
	return { latitude: 0, longitude: 0, hourly };
}

// --- tests --------------------------------------------------------------------

const THREE = [
	{ id: 1, lat: 47.3769, lng: 8.5417, datetime: 1719835200 }, // 2024-07-01T12:00Z
	{ id: 2, lat: -33.8688, lng: 151.2093, datetime: 1704067200 }, // 2024-01-01T00:00Z
	{ id: 3, lat: 0.5, lng: -120.125, datetime: 1719878399 }, // 2024-07-01T23:59Z
];

test("request URL is byte-identical to the JS builder", () => {
	const req = runRequest(THREE);
	assert.equal(req.method, "GET");
	assert.equal(req.url, referenceUrl(THREE));
});

test("rows without a numeric datetime are dropped from the request", () => {
	const req = runRequest([THREE[0], { id: 8, lat: 1, lng: 2, extra: { note: "no datetime" } }, THREE[1]]);
	assert.equal(req.url, referenceUrl([THREE[0], THREE[1]]));
});

test("a datetime outside the JS Date range is dropped from the request", () => {
	const req = runRequest([THREE[0], { id: 9, lat: 1, lng: 2, datetime: 9e12 }, THREE[1]]);
	assert.equal(req.url, referenceUrl([THREE[0], THREE[1]]));
});

test("joins each location to its own hour and omits null fields", () => {
	const body = JSON.stringify([
		coordResult("2024-07-01", { cloud_cover: new Array(24).fill(null) }),
		coordResult("2024-01-01"),
		coordResult("2024-07-01", { snowfall: [1, 2] }), // series shorter than the hour index
	]);
	const { patches } = runMap(THREE, 200, body);
	assert.deepEqual(patches.map((p) => p.id), [1, 2, 3]);

	// id 1 is at 12:00Z, so every series reads 12; cloud_cover is null and drops out.
	assert.deepEqual(patches[0].patch, {
		weatherCode: 12,
		precipitation: 12,
		snowDepth: 12,
		snowfall: 12,
		temperature2m: 12,
		sunshineDuration: 12,
		windSpeed10m: 12,
	});
	assert.equal(patches[1].patch.cloudCover, 0); // id 2 is at 00:00Z
	assert.equal(patches[2].patch.windSpeed10m, 23); // id 3 is at 23:00Z
	assert.equal("snowfall" in patches[2].patch, false);
});

test("a single-coordinate response arrives unwrapped", () => {
	const { patches } = runMap([THREE[0]], 200, JSON.stringify(coordResult("2024-07-01")));
	assert.deepEqual(patches.map((p) => p.id), [1]);
	assert.equal(patches[0].patch.temperature2m, 12);
});

test("an hour missing from hourly.time yields no patch", () => {
	// The response covers the day before, so 2024-07-01T12:00 is not in it.
	const { patches } = runMap([THREE[0]], 200, JSON.stringify([coordResult("2024-06-30")]));
	assert.equal(patches.length, 0);
});

test("a result with no hourly block yields no patch", () => {
	const body = JSON.stringify([{ error: true, reason: "out of range" }]);
	const { patches } = runMap([THREE[0]], 200, body);
	assert.equal(patches.length, 0);
});

test("a non-200 emits no patches and fails every row", () => {
	const { patches, failed } = runMap(THREE, 429, '{"error":true}');
	assert.equal(patches.length, 0);
	assert.deepEqual(failed, [1, 2, 3]);
});

test("unusable rows never shift the response index", () => {
	const locs = [{ id: 8, lat: 1, lng: 2, extra: { note: "skip me" } }, THREE[0]];
	const { patches } = runMap(locs, 200, JSON.stringify([coordResult("2024-07-01")]));
	assert.deepEqual(patches.map((p) => p.id), [1]);
	assert.equal(patches[0].patch.temperature2m, 12);
});

test("a filtered field set shrinks the request to those hourly params", () => {
	const fields = ["temperature2m", "cloudCover"];
	// Params keep the module's declared order, not the caller's.
	const params = Object.keys(FIELD_PARAM)
		.filter((k) => fields.includes(k))
		.map((k) => FIELD_PARAM[k]);
	assert.equal(runRequest(THREE, fields).url, referenceUrl(THREE, params));
});

test("a filtered field set emits only those keys", () => {
	const body = JSON.stringify([coordResult("2024-07-01")]);
	const { patches } = runMap([THREE[0]], 200, body, ["temperature2m", "cloudCover"]);
	assert.deepEqual(Object.keys(patches[0].patch), ["cloudCover", "temperature2m"]);
	assert.equal(patches[0].patch.temperature2m, 12);
});
