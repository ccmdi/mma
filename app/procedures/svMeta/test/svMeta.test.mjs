// Drives the built bundle directly: `run` and `query` against a host stub whose
// `mma.panos` answers with the panos the case names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pano, panos } from "../../panoStub.mjs";

const { run, query, configure } = await import(
	new URL("../../../src-tauri/procedures/svMeta.js", import.meta.url).href
);

const EMPTY_ROW = {
	lat: 0,
	lng: 0,
	heading: 0,
	pitch: 0,
	zoom: 0,
	flags: 0,
	createdAt: 0,
	modifiedAt: null,
	panoId: null,
	tags: [],
	extra: null,
};

/** A pano carrying every field the eight derivations read. */
const full = (over = {}) =>
	pano({
		pano: "x",
		lat: 35.6,
		lng: 139.7,
		altitude: 12.5,
		countryCode: "JP",
		uploaderName: "Some Uploader",
		pov: { heading: 123.5, tilt: 90, roll: 0 },
		centerHeading: 123.5,
		source: "launch",
		date: { year: 2021, month: 6, day: 15 },
		imageDate: "2021-06",
		coverageDates: ["2015-08", "2019-05", "2021-06"],
		...over,
	});

/** Installs an `mma` answering every non-empty id through `lookup`. */
function install(lookup, { fields = null } = {}) {
	const asked = [];
	const failed = [];
	let progress = 0;
	const answer = panos(lookup);
	globalThis.mma = {
		panos(queries) {
			asked.push(queries.map((q) => q.panoId));
			return answer(queries);
		},
		log() {},
		progress(units) {
			progress += units;
		},
		fail(id) {
			failed.push(id);
		},
		aborted: () => false,
	};
	configure(fields ? { fields, force: false, config: null } : null);
	return { asked, state: () => ({ progress, failed }) };
}

/** Runs `run` over `rows`. This procedure writes `extra` only; unwrap so the cases below
 *  read the fields. */
function runProcedure(rows, lookup, opts = {}) {
	const h = install(lookup, opts);
	const patches = run(rows.map((r) => ({ ...EMPTY_ROW, ...r }))).map((p) => {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patch entries must be LocationPatch-shaped");
		return { id: p.id, patch: p.patch.extra };
	});
	return { patches, asked: h.asked, ...h.state() };
}

function queryProcedure(input, lookup, opts = {}) {
	const h = install(lookup, opts);
	return { result: JSON.parse(JSON.stringify(query(input))), asked: h.asked, ...h.state() };
}

const CLASSIC_A = "abcdefghijklmnopqrstuA";
const CLASSIC_B = "vwxyz0123456789-_ABCDQ";

/** One row per pano, ids 1..n. */
const rowsFor = (panoIds, extra = null) =>
	panoIds.map((panoId, i) => ({ id: i + 1, lat: 1, lng: 2, panoId, extra }));

// --- Derivation ---

test("a full row yields all eight fields, in the order the field list names", () => {
	const { patches, progress, failed } = runProcedure(rowsFor([CLASSIC_A]), (id) =>
		full({ pano: id }),
	);
	assert.deepEqual(failed, []);
	assert.equal(progress, 1);
	assert.deepEqual(patches[0].patch, {
		altitude: 12.5,
		countryCode: "JP",
		cameraType: "gen2",
		panoType: "2",
		drivingDirection: 123.5,
		uploaderName: "Some Uploader",
		imageDate: "2021-06",
		coverageDates: ["2015-08", "2019-05", "2021-06"],
	});
	assert.equal(
		Object.keys(patches[0].patch).join(","),
		"altitude,countryCode,cameraType,panoType,drivingDirection,uploaderName,imageDate,coverageDates",
	);
});

test("absent facts collapse to nulls and defaults", () => {
	const { patches, failed } = runProcedure(rowsFor([CLASSIC_A]), (id) =>
		pano({ pano: id, cameraType: null }),
	);
	assert.deepEqual(failed, []);
	assert.deepEqual(patches[0].patch, {
		altitude: 0,
		countryCode: null,
		cameraType: null,
		panoType: "2",
		drivingDirection: null,
		uploaderName: null,
		imageDate: null,
		coverageDates: [],
	});
});

test("the pano type is the frontend the id belongs to", () => {
	const { patches } = runProcedure(rowsFor([CLASSIC_A]), (id) =>
		full({ pano: id, panoFrontend: 10 }),
	);
	assert.equal(patches[0].patch.panoType, "10");
});

test("a pano that no longer exists fails the row instead of passing it", () => {
	const { patches, progress, failed } = runProcedure(
		rowsFor([CLASSIC_A, CLASSIC_B]),
		(id) => (id === CLASSIC_B ? null : full({ pano: id })),
	);
	assert.deepEqual(
		patches.map((p) => p.id),
		[1],
	);
	assert.deepEqual(failed, [2]);
	assert.equal(progress, 2);
});

test("a request that never came back fails the row", () => {
	const { patches, failed } = runProcedure(rowsFor([CLASSIC_A]), () => "fail");
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [1]);
});

test("a row with no pano id is left unfinished rather than failed", () => {
	const { patches, progress, failed } = runProcedure(rowsFor([null]), () =>
		assert.fail("unexpected request"),
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, []);
	assert.equal(progress, 0);
});

test("rows sharing a pano each get the fields, in one host call", () => {
	const rows = [
		{ id: 7, panoId: CLASSIC_A },
		{ id: 8, panoId: CLASSIC_A },
		{ id: 9, panoId: CLASSIC_B },
	];
	const { patches, asked, progress } = runProcedure(rows, (id) => full({ pano: id }));
	assert.equal(asked.length, 1);
	assert.deepEqual(
		patches.map((p) => p.id),
		[7, 8, 9],
	);
	assert.equal(progress, 3);
});

// --- Staleness ---
// Forgetting fields derived from a changed imageDate is the engine's job, declared
// through `invalidates`; the procedure writes only what it derived.

test("the procedure writes no staleness keys of its own", () => {
	const { patches } = runProcedure(
		rowsFor([CLASSIC_A], { imageDate: "2020-01", datetime: 1600000000 }),
		(id) => full({ pano: id }),
	);
	assert.equal("datetime" in patches[0].patch, false);
	assert.equal("timezone" in patches[0].patch, false);
});

// --- Field selection ---

const configured = (fields, extra) =>
	runProcedure(rowsFor([CLASSIC_A], extra), (id) => full({ pano: id }), { fields });

test("only the configured fields are written", () => {
	const { patches } = configured(["countryCode", "imageDate", "notAField"]);
	assert.deepEqual(Object.keys(patches[0].patch), ["countryCode", "imageDate"]);
});

test("field selection writes only the selected key, even with derived fields to forget", () => {
	const { patches } = configured(["countryCode"], { imageDate: "2020-01", datetime: 1600000000 });
	assert.deepEqual(patches[0].patch, { countryCode: "JP" });
});

test("a fully deselected provider with nothing stale writes nothing", () => {
	const { patches } = configured([], { imageDate: "2021-06" });
	assert.deepEqual(patches, []);
});

// --- query ---

test("query metadata answers the whole pano, as it stands", () => {
	const answer = full({ pano: CLASSIC_A });
	const { result, asked } = queryProcedure({ op: "metadata", panoIds: [CLASSIC_A] }, () => answer);
	assert.equal(asked.length, 1);
	assert.deepEqual(result, [answer]);
});

test("query metadata keeps answers aligned to the panos it was asked for", () => {
	const { result, asked } = queryProcedure(
		{ op: "metadata", panoIds: [CLASSIC_A, "", CLASSIC_A, CLASSIC_B] },
		(id) => full({ pano: id }),
	);
	assert.deepEqual(asked, [[CLASSIC_A, "", CLASSIC_A, CLASSIC_B]]);
	assert.equal(result.length, 4);
	assert.equal(result[0].pano, CLASSIC_A);
	assert.equal(result[1], null);
	assert.equal(result[2].pano, CLASSIC_A);
	assert.equal(result[3].pano, CLASSIC_B);
});

test("query metadata answers null for a failed request", () => {
	const { result } = queryProcedure({ op: "metadata", panoIds: [CLASSIC_A] }, () => "fail");
	assert.deepEqual(result, [null]);
});

test("query rejects an unknown op", () => {
	const { result, asked } = queryProcedure({ op: "nope" }, () => assert.fail("no request"));
	assert.equal(asked.length, 0);
	assert.match(result.error, /unknown query op/);
});
