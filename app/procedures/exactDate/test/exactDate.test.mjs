// Drives the built bundle directly against a scripted SingleImageSearch stub.
import { test } from "node:test";
import assert from "node:assert/strict";

const bundle = await import(
	new URL("../../../src-tauri/procedures/exactDate.js", import.meta.url).href
);

// --- Reference window and body string, written independently of the module ---

function jsWindow(year, month) {
	const startDate = new Date(Date.UTC(year, month - 1, 1));
	startDate.setUTCDate(startDate.getUTCDate() - 1);
	const endInit = new Date(Date.UTC(year, month - 1, 1));
	endInit.setUTCDate(endInit.getUTCDate() + 32);
	return { lo: startDate.getTime() / 1000, hi: endInit.getTime() / 1000 };
}

function jsBody(lat, lng, start, end, radius = 50) {
	return `[["apiv3"],[[null,null,${lat},${lng}],${radius}],[[null,null,null,null,null,null,null,null,null,null,[${start},${end}]],null,null,null,null,null,null,null,[1],null,[[[2,true,2]]]],[[2,6]]]`;
}

// --- Harness ---

const NO_IMAGES = '["Search returned no images."]';
const FOUND = '[[["pano"]]]';
const encoder = new TextEncoder();

const row = (id, lat, lng, extra) => ({
	id,
	lat,
	lng,
	heading: 0,
	pitch: 0,
	zoom: 0,
	flags: 0,
	createdAt: 0,
	modifiedAt: null,
	panoId: null,
	tags: [],
	extra,
});

/** Installs a host whose SingleImageSearch answers come from `respond`, which receives
 *  {lat,lng,start,end,n} and returns a body string or {status, body}. */
function install(respond, { abortAfter = Infinity, onRound = null } = {}) {
	const state = { calls: [], failed: [], progress: 0 };
	globalThis.mma = {
		fetchMany(reqs) {
			const out = reqs.map((req) => {
				const parsed = JSON.parse(req.body);
				const [start, end] = parsed[2][0][10];
				const call = {
					req,
					body: req.body,
					lat: parsed[1][0][2],
					lng: parsed[1][0][3],
					start,
					end,
					n: state.calls.length,
				};
				state.calls.push(call);
				const r = respond(call);
				const status = typeof r === "object" ? r.status : 200;
				return { status, body: encoder.encode(typeof r === "object" ? r.body : r) };
			});
			onRound?.(out.length);
			return out;
		},
		fetch: (req) => globalThis.mma.fetchMany([req])[0],
		log: () => {},
		progress: (units) => {
			state.progress += units;
		},
		fail: (id) => state.failed.push(id),
		aborted: () => state.calls.length >= abortAfter,
		classify: () => assert.fail("exactDate must not classify"),
		sidecar: () => assert.fail("exactDate must not call a sidecar"),
	};
	return state;
}

function runProcedure(rows, respond, opts = {}) {
	const state = install(respond, opts);
	const patches = bundle.run(rows);
	for (const p of patches) {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patches must be LocationPatch-shaped");
	}
	return { ...state, patches: patches.map((p) => ({ id: p.id, patch: p.patch.extra })) };
}

/** Coverage exists in [start, end] iff the hidden capture time falls inside. */
const coverage = (hidden) => (c) => (hidden >= c.start && hidden <= c.end ? FOUND : NO_IMAGES);

// --- Tests ---

const YM = "2021-06";
const { lo, hi } = jsWindow(2021, 6);

test("bisect converges on the hidden timestamp across the month", () => {
	const cases = [
		["start", lo + 1],
		["middle", lo + Math.floor((hi - lo) / 2) + 12345],
		["end", hi - 3600],
	];
	for (const [where, hidden] of cases) {
		const { patches, calls, progress, failed } = runProcedure(
			[row(11, 48.8584, 2.2945, { imageDate: YM })],
			coverage(hidden),
		);
		assert.deepEqual(failed, [], `${where}: no failures`);
		assert.equal(progress, 1);
		assert.equal(patches.length, 1);
		const found = patches[0].patch.datetime;
		assert.equal(Number.isInteger(found), true, `${where}: integer timestamp`);
		assert.ok(
			Math.abs(found - hidden) <= 1,
			`${where}: hidden ${hidden}, found ${found} (delta ${found - hidden})`,
		);
		// ~10 rounds of BRANCH probes plus the seed. Catches accidental blowups.
		assert.ok(calls.length <= 50, `${where}: ${calls.length} probes`);
	}
});

test("not a candidate fails the row after a single probe", () => {
	const { patches, calls, failed, progress } = runProcedure(
		[row(12, 1, 2, { imageDate: YM })],
		() => NO_IMAGES,
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [12]);
	assert.equal(progress, 1);
	assert.equal(calls.length, 1);
});

test("a result at the window end is rejected by the default-pano guard", () => {
	const { patches, failed } = runProcedure([row(13, 1, 2, { imageDate: YM })], coverage(hi));
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [13]);
});

test("an abort stops the rounds and keeps every row already settled", () => {
	const hidden = lo + 500000;
	const rows = () => [
		row(21, 1, 2, { imageDate: YM }),
		// No coverage at all, so this one settles on the seed probe.
		row(22, 3, 4, { imageDate: YM }),
	];
	const respond = (c) => (c.lat === 3 ? NO_IMAGES : coverage(hidden)(c));
	const full = runProcedure(rows(), respond);
	assert.equal(full.patches.length, 1);
	assert.deepEqual(full.failed, [22]);

	// Aborts after the seed round, so 22's verdict stands and 21 never converges.
	const cut = runProcedure(rows(), respond, { abortAfter: 3 });
	assert.deepEqual(cut.patches, []);
	assert.deepEqual(cut.failed, [22]);
	assert.equal(cut.progress, 1);
	assert.ok(cut.calls.length < full.calls.length);
});

test("a round asks for every live row at once", () => {
	const hidden = lo + 500000;
	const widths = [];
	const { patches } = runProcedure(
		[1, 2, 3].map((id) => row(id, id, 0, { imageDate: YM })),
		coverage(hidden),
		{ onRound: (width) => widths.push(width) },
	);
	assert.equal(patches.length, 3);
	// Seed: one probe per row. Then four cuts for each row still searching.
	assert.equal(widths[0], 3);
	assert.equal(widths[1], 12);

	// Rounds, not requests, are what a batch costs: three rows take the same number of
	// round trips as one. A per-row loop would triple this.
	const alone = [];
	runProcedure([row(1, 1, 0, { imageDate: YM })], coverage(hidden), {
		onRound: (width) => alone.push(width),
	});
	assert.equal(widths.length, alone.length);
});

test("rows without a usable imageDate are skipped silently", () => {
	const { patches, calls, failed, progress } = runProcedure(
		[
			row(31, 1, 2, null),
			row(32, 1, 2, { imageDate: null, panoType: "x" }),
			row(33, 1, 2, { imageDate: 202106 }),
		],
		() => FOUND,
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, []);
	assert.equal(calls.length, 0);
	assert.equal(progress, 0);
});

test("a malformed imageDate fails the row without a request", () => {
	const { calls, failed } = runProcedure([row(34, 1, 2, { imageDate: "2021-13" })], () => FOUND);
	assert.equal(calls.length, 0);
	assert.deepEqual(failed, [34]);
});

test("request body matches the JS implementation byte for byte", () => {
	for (const [lat, lng] of [
		[48.8584, 2.2945],
		[-33.9, 151.2],
		[12, -7],
		[0, 0],
		[-0.000125, 100.5],
	]) {
		const { calls } = runProcedure([row(41, lat, lng, { imageDate: YM })], coverage(lo + 777777));
		assert.equal(calls[0].body, jsBody(lat, lng, lo, hi), `whole-window body for ${lat},${lng}`);
		for (const c of calls.slice(1)) {
			assert.equal(c.body, jsBody(lat, lng, c.start, c.end), `cut body for ${lat},${lng}`);
		}
		assert.equal(calls[0].req.method, "POST");
		assert.equal(calls[0].req.headers["content-type"], "application/json+protobuf");
		assert.equal(
			calls[0].req.url,
			"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch",
		);
	}
});

test("a non-2xx response fails the row instead of reading as no coverage", () => {
	const { patches, failed, calls } = runProcedure([row(51, 1, 2, { imageDate: YM })], (c) =>
		c.n === 0 ? FOUND : { status: 503, body: "" },
	);
	assert.deepEqual(patches, []);
	assert.deepEqual(failed, [51]);
	assert.ok(calls.length >= 2);
});

test("query resolves one point, answering null when it is not a candidate", () => {
	const hidden = Date.UTC(2021, 5, 15, 12, 34, 56) / 1000;
	install(coverage(hidden));
	const found = bundle.query({ op: "resolve", lat: 1, lng: 2, imageDate: YM });
	assert.ok(Math.abs(found - hidden) <= 1, `hidden ${hidden}, found ${found}`);

	const state = install(() => NO_IMAGES);
	assert.equal(bundle.query({ op: "resolve", lat: 1, lng: 2, imageDate: YM }), null);
	assert.equal(state.calls.length, 1);
	// A query reports nothing: `fail` and `progress` belong to a run's row accounting.
	assert.deepEqual(state.failed, []);
	assert.equal(state.progress, 0);

	install(() => FOUND);
	assert.throws(
		() => bundle.query({ op: "label", lat: 1, lng: 2, imageDate: YM }),
		/unknown query op/,
	);
	assert.throws(
		() => bundle.query({ op: "resolve", lat: 1, lng: 2, imageDate: "2021-13" }),
		/bad imageDate/,
	);
});
