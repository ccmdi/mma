// Drives the built bundle: `configure` then `run`, against a host stub whose `mma.panos`
// answers with the timelines the case names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pano, panos } from "../../panoStub.mjs";

const LoadAsPanoId = 1;

let asked = [];
let failed = [];
let progress = 0;

const { configure, run } = await import(
	new URL("../../../src-tauri/procedures/pinPano.js", import.meta.url).href
);

const row = (id, panoId = null, flags = 0) => ({
	id,
	lat: 0,
	lng: 0,
	heading: 0,
	pitch: 0,
	zoom: 0,
	flags,
	createdAt: 0,
	modifiedAt: null,
	panoId,
	tags: [],
	extra: null,
});

function runProcedure(rows, lookup, { force = false, config = null } = {}) {
	asked = [];
	failed = [];
	progress = 0;
	const answer = panos(lookup ?? (() => assert.fail("unexpected request")));
	globalThis.mma = {
		panos(queries) {
			const ids = queries.map((q) => q.panoId);
			if (ids.some(Boolean)) asked.push(ids.filter(Boolean));
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
	configure({ fields: [], force, config });
	return { patches: run(rows), asked, progress, failed };
}

/** A pano whose timeline names `history`, ascending as the host sorts it. */
const withTimeline = (id, history) =>
	pano({ id, time: history.map((p) => ({ panoId: p, date: "2020-01-01" })) });

const OFFICIAL_A = "aaaaaaaaaaaaaaaaaaaaaA";
const OFFICIAL_B = "bbbbbbbbbbbbbbbbbbbbbQ";
const OFFICIAL_C = "cccccccccccccccccccccg";
const UNOFFICIAL = "F:AF1QipMabcdefgHIJklmn";

test("without useLatest a pano-carrying row just gains the flag", () => {
	const { patches, asked, progress, failed } = runProcedure(
		[row(1, OFFICIAL_A, 0), row(2, OFFICIAL_B, 2)],
		null,
	);
	assert.deepEqual(asked, []);
	assert.deepEqual(patches, [
		{ id: 1, patch: { flags: 1 } },
		{ id: 2, patch: { flags: 3 } },
	]);
	assert.equal(progress, 2);
	assert.deepEqual(failed, []);
});

test("already pinned rows are skipped, and forced ones are not", () => {
	const skipped = runProcedure([row(1, OFFICIAL_A, LoadAsPanoId)], null);
	assert.deepEqual(skipped.patches, []);
	assert.equal(skipped.progress, 0);

	const forced = runProcedure([row(1, OFFICIAL_A, LoadAsPanoId)], null, { force: true });
	assert.deepEqual(forced.patches, [{ id: 1, patch: { flags: 1 } }]);
	assert.equal(forced.progress, 1);
});

test("useLatest never picks a bare CIHM contributor key, whatever its shape", () => {
	const CONTRIBUTOR = "CIHM0ogKEICAgICTzu7WYg";
	const { patches, failed } = runProcedure(
		[row(1, OFFICIAL_A, 0)],
		(id) => withTimeline(id, [OFFICIAL_A, OFFICIAL_B, CONTRIBUTOR]),
		{ config: { useLatest: true } },
	);
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: OFFICIAL_B, flags: 1 } }]);
	assert.deepEqual(failed, []);
});

test("useLatest picks the newest official pano in the timeline", () => {
	const { patches, asked, failed } = runProcedure(
		[row(1, OFFICIAL_A, 0)],
		(id) => withTimeline(id, [OFFICIAL_A, OFFICIAL_B, OFFICIAL_C]),
		{ config: { useLatest: true } },
	);
	assert.deepEqual(asked, [[OFFICIAL_A]]);
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: OFFICIAL_C, flags: 1 } }]);
	assert.deepEqual(failed, []);
});

test("useLatest skips a newer unofficial entry", () => {
	const { patches } = runProcedure(
		[row(1, OFFICIAL_A, 0)],
		(id) => withTimeline(id, [OFFICIAL_B, UNOFFICIAL]),
		{ config: { useLatest: true } },
	);
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: OFFICIAL_B, flags: 1 } }]);
});

test("useLatest with no official entry anywhere fails the row", () => {
	const { patches, failed } = runProcedure(
		[row(3, UNOFFICIAL, 0)],
		(id) => withTimeline(id, [UNOFFICIAL]),
		{ config: { useLatest: true } },
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [3]);
});

test("useLatest falls back to the image's own pano when the timeline names none", () => {
	const { patches } = runProcedure(
		[row(1, OFFICIAL_A, 0)],
		(id) => withTimeline(id, [OFFICIAL_A]),
		{ config: { useLatest: true } },
	);
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: OFFICIAL_A, flags: 1 } }]);
});

test("useLatest fails the row when the metadata request fails", () => {
	const { patches, failed } = runProcedure([row(4, OFFICIAL_A, 0)], () => "fail", {
		config: { useLatest: true },
	});
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [4]);
});

test("rows sharing a pano keep their own flags", () => {
	const { patches, asked } = runProcedure(
		[row(1, OFFICIAL_A, 0), row(2, OFFICIAL_A, 4)],
		(id) => withTimeline(id, [OFFICIAL_C]),
		{ config: { useLatest: true } },
	);
	assert.equal(asked.length, 1);
	assert.deepEqual(patches, [
		{ id: 1, patch: { panoId: OFFICIAL_C, flags: 1 } },
		{ id: 2, patch: { panoId: OFFICIAL_C, flags: 5 } },
	]);
});
