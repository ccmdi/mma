// Drives the built bundle: `configure` then `run`, against a stubbed host whose
// `fetchMany` answers GetMetadata requests with protobuf built here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataRequest,
	writeGetMetadataResponse,
} from "../../../src/lib/proto/getmetadata.gen.js";

const LoadAsPanoId = 1;

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

function runProcedure(rows, onRequest, { force = false, config = null } = {}) {
	calls = [];
	failed = [];
	progress = 0;
	respond = onRequest ?? (() => assert.fail("unexpected request"));
	configure({ fields: [], force, config });
	const patches = run(rows);
	return { patches, calls, progress, failed };
}

function responseBytes(obj) {
	const w = new PbfWriter();
	writeGetMetadataResponse(obj, w);
	return w.finish().slice();
}

/** ImageMetadata whose timeline names `history` (pano id + capture date), newest last. */
function metaWithTimeline(selfPano, selfDate, history) {
	return {
		status: { code: 1 },
		pano: { frontend: 2, id: selfPano },
		tiles: { worldSize: { height: 6656, width: 13312 } },
		information: [
			{
				location: { location: { lat: 1, lng: 2 }, countryCode: "JP" },
				relations: {
					pano: history.map((h) => ({ key: { frontend: h.frontend ?? 2, id: h.pano } })),
				},
				time: history.map((h, i) => ({ target: i, date: h.date })),
			},
		],
		date: { sourceInfo: { source: "launch" }, date: selfDate },
	};
}

const OFFICIAL_A = "aaaaaaaaaaaaaaaaaaaaaA";
const OFFICIAL_B = "bbbbbbbbbbbbbbbbbbbbbQ";
const OFFICIAL_C = "cccccccccccccccccccccg";
const UNOFFICIAL = "F:AF1QipMabcdefgHIJklmn";

test("without useLatest a pano-carrying row just gains the flag", () => {
	const { patches, calls, progress, failed } = runProcedure(
		[row(1, OFFICIAL_A, 0), row(2, OFFICIAL_B, 2)],
		null,
	);
	assert.equal(calls.length, 0);
	assert.deepEqual(patches, [
		{ id: 1, patch: { flags: 1 } },
		{ id: 2, patch: { flags: 3 } },
	]);
	assert.equal(progress, 2);
	assert.deepEqual(failed, []);
});

test("a row with no pano id fails", () => {
	const { patches, progress, failed } = runProcedure([row(5)], null);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [5]);
	assert.equal(progress, 1);
});

test("already pinned rows are skipped, and forced ones are not", () => {
	const skipped = runProcedure([row(1, OFFICIAL_A, LoadAsPanoId)], null);
	assert.deepEqual(skipped.patches, []);
	assert.equal(skipped.progress, 0);

	const forced = runProcedure([row(1, OFFICIAL_A, LoadAsPanoId)], null, { force: true });
	assert.deepEqual(forced.patches, [{ id: 1, patch: { flags: 1 } }]);
	assert.equal(forced.progress, 1);
});

test("useLatest picks the newest official pano in the timeline", () => {
	const body = responseBytes({
		metadata: [
			metaWithTimeline(OFFICIAL_A, { year: 2015, month: 3, day: 1 }, [
				{ pano: OFFICIAL_A, date: { year: 2015, month: 3, day: 1 } },
				{ pano: OFFICIAL_B, date: { year: 2019, month: 7, day: 1 } },
				{ pano: OFFICIAL_C, date: { year: 2022, month: 5, day: 1 } },
			]),
		],
	});
	const { patches, calls, failed } = runProcedure([row(1, OFFICIAL_A, 0)], () => body, {
		config: { useLatest: true },
	});
	assert.deepEqual(calls[0].keys, [OFFICIAL_A]);
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: OFFICIAL_C, flags: 1 } }]);
	assert.deepEqual(failed, []);
});

test("useLatest skips a newer unofficial entry", () => {
	const body = responseBytes({
		metadata: [
			metaWithTimeline(OFFICIAL_A, { year: 2015, month: 3, day: 1 }, [
				{ pano: OFFICIAL_B, date: { year: 2019, month: 7, day: 1 } },
				{ pano: "AF1QipMabcdefgHIJklmn", frontend: 3, date: { year: 2024, month: 1, day: 1 } },
			]),
		],
	});
	const { patches } = runProcedure([row(1, OFFICIAL_A, 0)], () => body, {
		config: { useLatest: true },
	});
	assert.equal(patches.length, 1);
	assert.equal(patches[0].patch.panoId, OFFICIAL_B);
});

test("useLatest with no official entry anywhere fails the row", () => {
	const body = responseBytes({
		metadata: [
			{
				status: { code: 1 },
				pano: { frontend: 3, id: "AF1QipMabcdefgHIJklmn" },
				information: [
					{ location: { location: { lat: 1, lng: 2 } }, relations: { pano: [] }, time: [] },
				],
				date: { date: { year: 2020, month: 1, day: 1 } },
			},
		],
	});
	const { patches, failed } = runProcedure([row(3, UNOFFICIAL, 0)], () => body, {
		config: { useLatest: true },
	});
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [3]);
});

test("useLatest falls back to the image's own pano when the timeline names none", () => {
	const body = responseBytes({
		metadata: [
			{
				status: { code: 1 },
				pano: { frontend: 2, id: OFFICIAL_A },
				information: [{ location: { location: { lat: 1, lng: 2 } }, time: [] }],
				date: { date: { year: 2020, month: 1, day: 1 } },
			},
		],
	});
	const { patches } = runProcedure([row(1, OFFICIAL_A, 0)], () => body, {
		config: { useLatest: true },
	});
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: OFFICIAL_A, flags: 1 } }]);
});

test("useLatest fails the row when the metadata request fails", () => {
	const { patches, failed } = runProcedure(
		[row(4, OFFICIAL_A, 0)],
		() => ({ status: 500, body: new Uint8Array() }),
		{ config: { useLatest: true } },
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [4]);
});

test("rows sharing a pano are fetched once but keep their own flags", () => {
	const body = responseBytes({
		metadata: [
			metaWithTimeline(OFFICIAL_A, { year: 2015, month: 3, day: 1 }, [
				{ pano: OFFICIAL_C, date: { year: 2022, month: 5, day: 1 } },
			]),
		],
	});
	const { patches, calls } = runProcedure([row(1, OFFICIAL_A, 0), row(2, OFFICIAL_A, 4)], () => body, {
		config: { useLatest: true },
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(patches, [
		{ id: 1, patch: { panoId: OFFICIAL_C, flags: 1 } },
		{ id: 2, patch: { panoId: OFFICIAL_C, flags: 5 } },
	]);
});
