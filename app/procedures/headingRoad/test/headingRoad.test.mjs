// Drives the built bundle: `configure` then `run`, against a host stub whose `mma.panos`
// answers with the panos the case names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pano, panos } from "../../panoStub.mjs";

let failed = [];
let progress = 0;
let asked = [];

const { configure, run } = await import(
	new URL("../../../src-tauri/procedures/headingRoad.js", import.meta.url).href
);

const row = (id, panoId = null) => ({
	id,
	lat: 0,
	lng: 0,
	heading: 0,
	pitch: 0,
	zoom: 0,
	flags: 0,
	createdAt: 0,
	modifiedAt: null,
	panoId,
	tags: [],
	extra: null,
});

function runProcedure(rows, lookup, { direction = "forwards" } = {}) {
	failed = [];
	progress = 0;
	asked = [];
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
	configure({ fields: [], force: false, config: { direction } });
	return { patches: run(rows), asked, progress, failed };
}

/** A pano facing `heading`, as the host reports one. */
const facing = (id, heading) =>
	pano({
		id,
		pov: heading === null ? null : { heading, tilt: 90, roll: 0 },
		centerHeading: heading ?? 0,
		countryCode: "JP",
		imageDate: "2021-06",
	});

/** Clamp to [-180, 180]: normalizeHeading in app/src/lib/sv/lookup.ts. */
const normalizeHeading = (h) => (h > 180 ? h - 360 : h < -180 ? h + 360 : h);

const PANO = "aaaaaaaaaaaaaaaaaaaaaA";

test("forwards writes the driving direction unchanged", () => {
	const { patches, asked, progress, failed } = runProcedure([row(1, PANO)], (id) => facing(id, 90));
	assert.deepEqual(asked, [[PANO]]);
	assert.deepEqual(patches, [{ id: 1, patch: { heading: 90 } }]);
	assert.equal(progress, 1);
	assert.deepEqual(failed, []);
});

test("backwards matches normalizeHeading(center - 180) exactly", () => {
	for (const center of [0, 90, 180, -90, -180, 45.5, 179.5, -179.5]) {
		const { patches } = runProcedure([row(1, PANO)], (id) => facing(id, center), {
			direction: "backwards",
		});
		assert.equal(patches[0].patch.heading, normalizeHeading(center - 180), `center ${center}`);
	}
});

test("an unknown direction reads as forwards", () => {
	const { patches } = runProcedure([row(1, PANO)], (id) => facing(id, 12), {
		direction: "sideways",
	});
	assert.deepEqual(patches, [{ id: 1, patch: { heading: 12 } }]);
});

test("metadata with no pov leaves the heading alone without failing", () => {
	const { patches, progress, failed } = runProcedure([row(1, PANO)], (id) => facing(id, null));
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, []);
	assert.equal(progress, 1);
});

test("a pano the host could not resolve fails the row", () => {
	const { patches, failed } = runProcedure([row(2, PANO)], () => null);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [2]);
});

test("a request the host never got an answer to fails the row", () => {
	const { patches, failed } = runProcedure([row(3, PANO)], () => "fail");
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [3]);
});

test("a row with no pano id is left unfinished rather than failed", () => {
	const { patches, progress, failed } = runProcedure([row(4)], () => assert.fail("no request"));
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, []);
	assert.equal(progress, 0);
});

test("rows sharing a pano each get the heading, in one host call", () => {
	const { patches, asked } = runProcedure([row(1, PANO), row(2, PANO)], (id) => facing(id, 33));
	assert.equal(asked.length, 1);
	assert.deepEqual(patches, [
		{ id: 1, patch: { heading: 33 } },
		{ id: 2, patch: { heading: 33 } },
	]);
});
