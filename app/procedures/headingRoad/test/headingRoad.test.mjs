// Drives the built bundle: `configure` then `run`, against a stubbed host whose
// `fetchMany` answers GetMetadata requests with protobuf built here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataRequest,
	writeGetMetadataResponse,
} from "../../../src/lib/proto/getmetadata.gen.js";

let respond = () => assert.fail("unexpected request");
let calls = [];
let failed = [];
let progress = 0;

globalThis.mma = {
	fetchMany(reqs) {
		return reqs.map((req) => {
			const decoded = readGetMetadataRequest(new PbfReader(req.body));
			calls.push({ req, keys: decoded.key.map((k) => k.key.id) });
			const r = respond();
			return r?.status !== undefined ? r : { status: 200, body: r ?? new Uint8Array() };
		});
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

function runProcedure(rows, onRequest, { direction = "forwards" } = {}) {
	calls = [];
	failed = [];
	progress = 0;
	respond = onRequest ?? (() => assert.fail("unexpected request"));
	configure({ fields: [], force: false, config: { direction } });
	const patches = run(rows);
	return { patches, calls, progress, failed };
}

function responseBytes(obj) {
	const w = new PbfWriter();
	writeGetMetadataResponse(obj, w);
	return w.finish().slice();
}

/** ImageMetadata whose location carries `pov.heading`, the driving direction. */
function metaWithHeading(panoId, heading) {
	const location = { location: { lat: 1, lng: 2 }, countryCode: "JP" };
	if (heading !== null) location.pov = { heading };
	return {
		status: { code: 1 },
		pano: { frontend: 2, id: panoId },
		tiles: { worldSize: { height: 6656, width: 13312 } },
		information: [{ location, time: [] }],
		date: { sourceInfo: { source: "launch" }, date: { year: 2021, month: 6, day: 15 } },
	};
}

/** Clamp to [-180, 180]: normalizeHeading in app/src/lib/sv/lookup.ts. */
const normalizeHeading = (h) => (h > 180 ? h - 360 : h < -180 ? h + 360 : h);

const PANO = "aaaaaaaaaaaaaaaaaaaaaA";

test("forwards writes the driving direction unchanged", () => {
	const { patches, calls, progress, failed } = runProcedure([row(1, PANO)], () =>
		responseBytes({ metadata: [metaWithHeading(PANO, 90)] }),
	);
	assert.deepEqual(calls[0].keys, [PANO]);
	assert.deepEqual(patches, [{ id: 1, patch: { heading: 90 } }]);
	assert.equal(progress, 1);
	assert.deepEqual(failed, []);
});

test("backwards matches normalizeHeading(center - 180) exactly", () => {
	// float32 round-trips exactly for these; the protobuf pov.heading is a float.
	for (const center of [0, 90, 180, -90, -180, 45.5, 179.5, -179.5]) {
		const { patches } = runProcedure(
			[row(1, PANO)],
			() => responseBytes({ metadata: [metaWithHeading(PANO, center)] }),
			{ direction: "backwards" },
		);
		assert.equal(patches[0].patch.heading, normalizeHeading(center - 180), `center ${center}`);
	}
});

test("an unknown direction reads as forwards", () => {
	const { patches } = runProcedure(
		[row(1, PANO)],
		() => responseBytes({ metadata: [metaWithHeading(PANO, 12)] }),
		{ direction: "sideways" },
	);
	assert.deepEqual(patches, [{ id: 1, patch: { heading: 12 } }]);
});

test("a row without a pano id fails and never reaches a request", () => {
	const { patches, calls, progress, failed } = runProcedure([row(7)], null);
	assert.equal(calls.length, 0);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [7]);
	assert.equal(progress, 1);
});

test("metadata with no pov leaves the heading alone without failing", () => {
	const { patches, progress, failed } = runProcedure([row(1, PANO)], () =>
		responseBytes({ metadata: [metaWithHeading(PANO, null)] }),
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, []);
	assert.equal(progress, 1);
});

test("undecodable metadata fails the row", () => {
	const { patches, failed } = runProcedure([row(2, PANO)], () =>
		responseBytes({ metadata: [{ status: { code: 2 } }] }),
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [2]);
});

test("a non-2xx response fails the row", () => {
	const { patches, failed } = runProcedure([row(3, PANO)], () => ({
		status: 503,
		body: new Uint8Array(),
	}));
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [3]);
});

test("rows sharing a pano are fetched once and each get the heading", () => {
	const { patches, calls } = runProcedure([row(1, PANO), row(2, PANO)], () =>
		responseBytes({ metadata: [metaWithHeading(PANO, 33)] }),
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(patches, [
		{ id: 1, patch: { heading: 33 } },
		{ id: 2, patch: { heading: 33 } },
	]);
});
