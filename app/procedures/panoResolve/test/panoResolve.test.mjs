// Drives the built bundle against a stubbed host. The SingleImageSearch wire format
// lives in @/lib/sv/singleImageSearch, but `jsLocationBody` below is the only JS
// statement of it that is independent of that module, so it stays the reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAnswer } from "../../arrayJson.mjs";

const { configure, run, query } = await import(
	new URL("../../../src-tauri/procedures/panoResolve.js", import.meta.url).href
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Reference request body, mirroring StreetViewService.getPanorama({location, radius}) ---

function jsLocationBody(lat, lng, radius, frontends = [2, 3, 10]) {
	const sources = frontends.map((f) => `[${f},true,2]`).join(",");
	return `[["apiv3"],[[null,null,${lat},${lng}],${radius}],[null,null,null,null,null,null,null,null,[2],null,[[${sources}]]],[[1,2,3,4,8,6]]]`;
}

const NO_IMAGES = '[[5,"generic","Search returned no images."]]';
/** The least a search answers for a pano: an OK image status, its key, and one
 *  information entry, which is all the decode needs to call it found. */
const found = (pano, frontend = 2) =>
	searchAnswer({ status: { code: 1 }, pano: { frontend, id: pano }, information: [{}] });

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

/** Installs a host stub. `respond` receives {lat,lng,body,n} and returns a body string
 *  or {status, body}. `abortAfter` makes `aborted()` true once that many requests have
 *  been answered. */
function installHost(respond, { abortAfter = Infinity } = {}) {
	const calls = [];
	const failed = [];
	let progress = 0;
	let hostCalls = 0;

	const answer = (req) => {
		const body = typeof req.body === "string" ? req.body : decoder.decode(req.body);
		const coord = /\[null,null,(-?[\d.e+-]+),(-?[\d.e+-]+)\],(-?[\d.e+-]+)\]/.exec(body);
		const call = {
			req,
			body,
			lat: Number(coord[1]),
			lng: Number(coord[2]),
			radius: Number(coord[3]),
			n: calls.length,
		};
		calls.push(call);
		const r = respond(call);
		const status = typeof r === "object" ? r.status : 200;
		return { status, body: encoder.encode(typeof r === "object" ? r.body : r) };
	};

	globalThis.mma = {
		fetch: answer,
		fetchMany(reqs) {
			hostCalls++;
			return reqs.map(answer);
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

test("request body mirrors the location search getPanorama sends", () => {
	const cases = [
		[52.10947502806108, 34.90131410856584],
		[0, 0],
		[-33.5, -70.25],
	];
	for (const [lat, lng] of cases) {
		const { calls } = runProcedure([{ id: 1, lat, lng }], () => NO_IMAGES);
		assert.equal(calls[0].body, jsLocationBody(lat, lng, 50), `${lat},${lng}`);
		assert.equal(
			calls[0].req.url,
			"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch",
		);
		assert.equal(calls[0].req.headers["content-type"], "application/json+protobuf");
	}
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

test("a ZERO_RESULTS result status fails the row", () => {
	const { patches, failed } = runProcedure(
		[{ id: 7, lat: 1, lng: 2 }],
		() => `[[0],[[2],null,null]]`,
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [7]);
});

test("a non-2xx response fails the row instead of reading as no coverage", () => {
	const { patches, failed } = runProcedure([{ id: 9, lat: 1, lng: 2 }], () => ({
		status: 500,
		body: "",
	}));
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
		(c) => (c.n === 2 ? NO_IMAGES : found(`p${c.n}`)),
		{ abortAfter: 1 },
	);
	assert.deepEqual(
		patches.map((p) => p.id),
		[1, 2],
	);
	assert.deepEqual(failed, [], "a cancelled run must not count declined rows as failures");
	assert.equal(progress, 2);
});

test("non-official frontends round-trip through the ImageKey encoding", () => {
	const fife = runProcedure([{ id: 1, lat: 1, lng: 2 }], () => found("AF1QipMabc", 3));
	assert.deepEqual(fife.patches, [{ id: 1, patch: { panoId: "F:AF1QipMabc" } }]);

	// frontend 10 (user uploaded) becomes a base64url-encoded binary ImageKey.
	const user = runProcedure([{ id: 1, lat: 1, lng: 2 }], () => found("upload-1", 10));
	assert.equal(user.patches.length, 1);
	const raw = Buffer.from(
		user.patches[0].patch.panoId.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "="),
		"base64",
	);
	assert.deepEqual([...raw], [0x08, 10, 0x12, 8, ...Buffer.from("upload-1")]);
});

test("with needs configured, a row that holds every wanted field is left alone", () => {
	const rows = [
		{ id: 1, lat: 1, lng: 2, panoId: null, extra: { countryCode: "CH", panoType: 2 } },
		{ id: 2, lat: 1, lng: 2, panoId: null, extra: { countryCode: "CH" } },
		{ id: 3, lat: 1, lng: 2, panoId: null, extra: { countryCode: "CH", panoType: null } },
	];
	const config = { radius: 50, needs: ["countryCode", "panoType"] };
	const done = runProcedure(rows, () => found("x1"), { config });
	assert.deepEqual(done.patches.map((p) => p.id), [2, 3]);
	assert.equal(done.calls.length, 2);
	// Without needs (pinning, heading) every row without a pano is resolved.
	const all = runProcedure(rows, () => found("x1"), { config: { radius: 50 } });
	assert.equal(all.patches.length, 3);
});

test("the configured radius rides the request", () => {
	const { calls } = runProcedure([{ id: 1, lat: 1, lng: 2 }], () => NO_IMAGES, {
		config: { radius: 250 },
	});
	assert.equal(calls[0].radius, 250);
	assert.equal(calls[0].body, jsLocationBody(1, 2, 250));
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
		answer.map((a) => a && a.pano),
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
	assert.equal(a.calls[0].body, jsLocationBody(1, 2, 250));
	const b = queryAt({ op: "at", points: pt }, () => NO_IMAGES);
	assert.equal(b.calls[0].body, jsLocationBody(1, 2, 50));
});

test("sources narrows the search to the collections named", () => {
	const pt = [{ lat: 1, lng: 2 }];
	const user = queryAt({ op: "at", points: pt, sources: [3, 10] }, () => NO_IMAGES);
	assert.equal(user.calls[0].body, jsLocationBody(1, 2, 50, [3, 10]));
	// No sources named: every frontend, as getPanorama({location}) searched.
	const off = queryAt({ op: "at", points: pt }, () => NO_IMAGES);
	assert.equal(off.calls[0].body, jsLocationBody(1, 2, 50));
});

test("a non-2xx response reads as no coverage rather than failing the query", () => {
	const { answer } = queryAt({ op: "at", points: [{ lat: 1, lng: 2 }] }, () => ({
		status: 500,
		body: "",
	}));
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
