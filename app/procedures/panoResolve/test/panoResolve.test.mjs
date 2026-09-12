// Drives the built bundle against a stubbed host. The search request itself is the
// host's job now (pinned byte-for-byte in `sv/pano.test.rs`), so the stub scripts
// `mma.panos` answers by pano id and the tests assert the query objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pano } from "../../panoStub.mjs";

const { configure, run, query } = await import(
	new URL("../../../src-tauri/procedures/panoResolve.js", import.meta.url).href
);

const NO_IMAGES = { state: "notFound" };
const FAILED = { state: "failed" };
const SKIPPED = { state: "skipped" };
/** A scripted search answer naming the pano it found. */
const found = (panoId) => ({
	state: "found",
	pano: pano({ id: panoId, time: [{ panoId, date: "2020-01-01" }] }),
});

// --- Harness ---

const toRow = (r) => ({
	heading: 0,
	pitch: 0,
	zoom: 0,
	flags: 0,
	createdAt: 0,
	modifiedAt: null,
	panoId: null,
	tags: [],
	extra: null,
	...r,
});

/** Installs a host stub. `respond` receives {query,lat,lng,radius,n} and returns a
 *  PanoAnswer. `abortAfter` makes `aborted()` true once that many queries have been
 *  answered. */
function installHost(respond, { abortAfter = Infinity } = {}) {
	const calls = [];
	const failed = [];
	let progress = 0;
	let hostCalls = 0;

	globalThis.mma = {
		panos(queries) {
			hostCalls++;
			return queries.map((query) => {
				const call = {
					query,
					lat: query.lat,
					lng: query.lng,
					radius: query.radius,
					n: calls.length,
				};
				calls.push(call);
				return respond(call);
			});
		},
		log() {},
		progress(units) {
			progress += units;
		},
		fail(id) {
			failed.push(id);
		},
		aborted: () => calls.length >= abortAfter,
	};
	return { calls, failed, stats: () => ({ progress, hostCalls }) };
}

function runProcedure(rows, respond, { config = null, force = false, abortAfter = Infinity } = {}) {
	const h = installHost(respond, { abortAfter });
	configure({ fields: ["panoId"], force, config });
	const patches = run(rows.map(toRow));
	return { patches, calls: h.calls, failed: h.failed, ...h.stats() };
}

function queryAt(input, respond, { config = null } = {}) {
	const h = installHost(respond);
	configure({ fields: [], force: false, config });
	return { answer: query(input), calls: h.calls, ...h.stats() };
}

// --- Tests ---

const PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";

test("a run's query is the point and the radius, nothing else", () => {
	const { calls } = runProcedure([{ id: 1, lat: 52.1, lng: 34.9 }], () => NO_IMAGES);
	assert.deepEqual(calls[0].query, { lat: 52.1, lng: 34.9, radius: 50 });
});

test("a run with sources configured narrows every search to them", () => {
	const { calls } = runProcedure([{ id: 1, lat: 52.1, lng: 34.9 }], () => NO_IMAGES, {
		config: { sources: [2] },
	});
	assert.deepEqual(calls[0].query, { lat: 52.1, lng: 34.9, radius: 50, sources: [2] });
});

test("a resolved pano is written as a panoId patch", () => {
	const { patches, calls, progress, failed } = runProcedure(
		[
			{ id: 1, lat: 1, lng: 2 },
			{ id: 2, lat: 3, lng: 4 },
		],
		() => found(PANO),
	);
	assert.equal(calls.length, 2);
	assert.deepEqual(patches, [
		{ id: 1, patch: { panoId: PANO } },
		{ id: 2, patch: { panoId: PANO } },
	]);
	assert.equal(progress, 2);
	assert.deepEqual(failed, []);
});

test("every row of a run goes to the host in one call", () => {
	const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, lat: i, lng: -i }));
	const { patches, calls, hostCalls } = runProcedure(rows, (c) => found(`p${c.n}`));
	assert.equal(hostCalls, 1, "the procedure must not serialize its own requests");
	assert.equal(calls.length, 12);
	assert.equal(patches.length, 12);
});

test("rows that already carry a pano id are left alone", () => {
	const { patches, calls, progress } = runProcedure(
		[
			{ id: 1, lat: 1, lng: 2, panoId: "already" },
			{ id: 2, lat: 3, lng: 4 },
		],
		() => found(PANO),
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(patches, [{ id: 2, patch: { panoId: PANO } }]);
	assert.equal(progress, 1);
});

test("force re-resolves a pano the row already has", () => {
	const { patches, calls, progress, failed } = runProcedure(
		[{ id: 1, lat: 1, lng: 2, panoId: "already" }],
		() => found(PANO),
		{ force: true },
	);
	assert.equal(calls.length, 1);
	assert.deepEqual(patches, [{ id: 1, patch: { panoId: PANO } }]);
	assert.equal(progress, 1);
	assert.deepEqual(failed, []);
});

test("an unforced run leaves a pano the row already has", () => {
	const { patches, calls, progress } = runProcedure(
		[{ id: 1, lat: 1, lng: 2, panoId: "already" }],
		() => assert.fail("no request for a row that already has a pano"),
	);
	assert.equal(calls.length, 0);
	assert.deepEqual(patches, []);
	assert.equal(progress, 0);
});

test("no coverage fails the row without a patch", () => {
	const { patches, progress, failed } = runProcedure([{ id: 7, lat: 1, lng: 2 }], () => NO_IMAGES);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [7]);
	assert.equal(progress, 1);
});

test("a failed request fails the row instead of reading as no coverage", () => {
	const { patches, failed } = runProcedure([{ id: 9, lat: 1, lng: 2 }], () => FAILED);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [9]);
});

test("an aborted run leaves its declined rows unfailed", () => {
	const { patches, failed, progress } = runProcedure(
		[
			{ id: 1, lat: 1, lng: 2 },
			{ id: 2, lat: 3, lng: 4 },
			{ id: 3, lat: 5, lng: 6 },
		],
		(c) => (c.n === 2 ? SKIPPED : found(`p${c.n}`)),
		{ abortAfter: 1 },
	);
	assert.deepEqual(
		patches.map((p) => p.id),
		[1, 2],
	);
	assert.deepEqual(failed, [], "a cancelled run must not count declined rows as failures");
	assert.equal(progress, 2);
});

test("the configured radius rides the request", () => {
	const { calls } = runProcedure([{ id: 1, lat: 1, lng: 2 }], () => NO_IMAGES, {
		config: { radius: 250 },
	});
	assert.equal(calls[0].radius, 250);
});

// --- query: op "at" ---

test("the at query answers a pano per point, in input order", () => {
	const pts = [
		{ lat: 1, lng: 2 },
		{ lat: 3, lng: 4 },
		{ lat: 5, lng: 6 },
	];
	const { answer, calls } = queryAt({ op: "at", points: pts }, (c) =>
		c.n === 1 ? NO_IMAGES : found(`pano${c.n}`),
	);
	assert.deepEqual(
		answer.map((a) => a && a.id),
		["pano0", null, "pano2"],
	);
	assert.deepEqual(
		calls.map((c) => [c.lat, c.lng]),
		[
			[1, 2],
			[3, 4],
			[5, 6],
		],
	);
});

test("every point of a query goes to the host in one call", () => {
	const points = Array.from({ length: 12 }, (_, i) => ({ lat: i, lng: -i }));
	const { answer, calls, hostCalls } = queryAt({ op: "at", points }, (c) => found(`p${c.n}`));
	assert.equal(hostCalls, 1, "the procedure must not serialize its own requests");
	assert.equal(calls.length, 12);
	assert.equal(answer.length, 12);
});

test("the query radius rides the request, defaulting to 50", () => {
	const pt = [{ lat: 1, lng: 2 }];
	const a = queryAt({ op: "at", points: pt, radius: 250 }, () => NO_IMAGES);
	assert.equal(a.calls[0].radius, 250);
	const b = queryAt({ op: "at", points: pt }, () => NO_IMAGES);
	assert.equal(b.calls[0].radius, 50);
});

test("sources narrows the search to the collections named", () => {
	const pt = [{ lat: 1, lng: 2 }];
	const user = queryAt({ op: "at", points: pt, sources: [3, 10] }, () => NO_IMAGES);
	assert.deepEqual(user.calls[0].query.sources, [3, 10]);
	// No sources named: every frontend, which is the host's own default.
	const off = queryAt({ op: "at", points: pt }, () => NO_IMAGES);
	assert.equal(off.calls[0].query.sources, undefined);
});

test("a failed request reads as no coverage rather than failing the query", () => {
	const { answer } = queryAt({ op: "at", points: [{ lat: 1, lng: 2 }] }, () => FAILED);
	assert.deepEqual(answer, [null]);
});

test("no points asks the host nothing", () => {
	const { answer, calls } = queryAt({ op: "at", points: [] }, () => NO_IMAGES);
	assert.deepEqual(answer, []);
	assert.equal(calls.length, 0);
});

test("an unknown query op is an error, not an empty answer", () => {
	const { answer } = queryAt({ op: "metadata", points: [] }, () => NO_IMAGES);
	assert.equal(answer.error, "panoResolve: unknown query op");
});
