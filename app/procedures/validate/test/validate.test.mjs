// Drives the built bundle against a stubbed host: one `mma.panos` answers the stored
// panos and the timeline round by id, and the coordinate lookups by search query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pano, panos as panosStub } from "../../panoStub.mjs";

const { run } = await import(
	new URL("../../../src-tauri/procedures/validate.js", import.meta.url).href
);

// --- ValidationFlag ---

const OK = 0;
const NEWER = 1;
const OFF_DEFAULT = 2;
const DEFAULT_STALE = 4;
const PANO_ID_BROKE = 8;
const UNOFFICIAL = 16;
const GOODCAM_AVAILABLE = 32;
const NOT_FOUND = 64;

const PINNED = 1;

// --- Fixtures ---

const A = "aaaaaaaaaaaaaaaaaaaaaA";
const B = "bbbbbbbbbbbbbbbbbbbbbQ";
const C = "cccccccccccccccccccccg";
const LONG = "ddddddddddddddddddddddddw";

const pad = (n) => String(n).padStart(2, "0");
const civil = (d) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/** A pano as the host decodes one, with per-case overrides. The timeline carries the
 *  image's own capture alongside the entries `timeline` names, ascending. */
function meta(id, over = {}) {
	const date = over.date ?? { year: 2021, month: 6, day: 15 };
	const height = over.height ?? 8192;
	const time = [...(over.timeline ?? []), { panoId: id, date }]
		.map((t) => ({ panoId: t.panoId, date: civil(t.date) }))
		.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
	return pano({
		id,
		lat: over.lat ?? 1,
		lng: over.lng ?? 2,
		countryCode: over.countryCode ?? "JP",
		copyright: over.copyright ?? "© 2021 Google",
		worldSize: { width: 16384, height },
		cameraType: over.cameraType ?? (height === 8192 ? "gen4" : "gen2"),
		pov: { heading: 123.5, tilt: 90, roll: 0 },
		centerHeading: 123.5,
		time,
		date,
		imageDate: `${date.year}-${pad(date.month)}`,
		coverageDates: time.map((t) => t.date.slice(0, 7)),
	});
}

/** A gen2 capture in a country and month the badcam table covers. */
const badcam = (id, over = {}) =>
	meta(id, {
		height: 6656,
		countryCode: "GB",
		date: { year: 2021, month: 6, day: 1 },
		cameraType: "badcam",
		...over,
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

/** Drives `run` over `rows`.
 *  `panos` maps a pano id to its decoded `Pano`; a pano that is absent answers as
 *  unknown, and one listed in `failing` is a request that never came back.
 *  `coords` maps "lat,lng" to the pano the coordinate lookup finds.
 *  `abortAfter` makes `aborted()` true once that many requests have been answered. */
function runProcedure(
	rows,
	{ panos = {}, coords = {}, failing = [], abortAfter = Infinity, config = null } = {},
) {
	const metaCalls = [];
	const coordCalls = [];
	let progress = 0;
	let hostCalls = 0;
	const requests = () => metaCalls.flat().length + coordCalls.length;

	const answer = panosStub(
		(id) => (failing.includes(id) ? "fail" : (panos[id] ?? null)),
		(query) => {
			const call = { lat: query.lat, lng: query.lng, radius: query.radius };
			coordCalls.push(call);
			// A search answers the pano's metadata with it, so the row never asks again.
			const found = coords[`${call.lat},${call.lng}`];
			return found ? { state: "found", pano: panos[found] ?? meta(found) } : { state: "notFound" };
		},
	);

	globalThis.mma = {
		panos(queries) {
			const active = queries.filter((q) => !("panoId" in q) || q.panoId);
			if (active.length > 0) hostCalls++;
			const asked = [...new Set(queries.map((q) => q.panoId).filter(Boolean))];
			if (asked.length > 0) metaCalls.push(asked);
			return answer(queries);
		},
		log() {},
		progress(units) {
			progress += units;
		},
		fail() {},
		aborted: () => requests() >= abortAfter,
	};

	const raw = run(rows.map(toRow), { fields: [], force: false, config });
	for (const a of raw) {
		assert.deepEqual(Object.keys(a).sort(), ["flags", "id", "pinned"]);
		assert.equal(typeof a.flags, "number");
	}
	const answers = raw.map((a) => ({ id: a.id, patch: a.flags }));
	return { answers, raw, metaCalls, coordCalls, progress, hostCalls };
}

/** One row at (1, 2), with the state of a single answer. */
function stateOf(row, opts) {
	const { answers, ...rest } = runProcedure([{ id: 1, lat: 1, lng: 2, ...row }], opts);
	assert.equal(answers.length, 1);
	assert.equal(answers[0].id, 1);
	return { state: answers[0].patch, ...rest };
}

// --- Coverage ---

test("an unpinned row whose coordinate agrees is ok", () => {
	const { state } = stateOf({ panoId: A }, { panos: { [A]: meta(A) }, coords: { "1,2": A } });
	assert.equal(state, OK);
});

test("a row with no coverage anywhere is not found", () => {
	const { state, coordCalls } = stateOf({ panoId: null }, { coords: {} });
	assert.equal(state, NOT_FOUND);
	assert.equal(coordCalls.length, 1);
});

test("a stored pano that no longer resolves is not found when the coordinate is empty", () => {
	const { state } = stateOf({ panoId: A }, { panos: {}, coords: {} });
	assert.equal(state, NOT_FOUND);
});

test("a pinned row whose pano is gone but has coverage reports the broken pano", () => {
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{ panos: { [B]: meta(B) }, coords: { "1,2": B } },
	);
	assert.equal(state, PANO_ID_BROKE);
});

test("a pinned row with nothing at the coordinate is not found", () => {
	const { state } = stateOf({ panoId: A, flags: PINNED }, { panos: {}, coords: {} });
	assert.equal(state, NOT_FOUND);
});

test("a failed metadata request counts as a missing pano", () => {
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{ panos: { [A]: meta(A) }, failing: [A], coords: {} },
	);
	assert.equal(state, NOT_FOUND);
});

test("a pinned row whose coordinate agrees with its pano is ok", () => {
	const { state, coordCalls } = stateOf(
		{ panoId: A, flags: PINNED },
		{ panos: { [A]: meta(A) }, coords: { "1,2": A } },
	);
	assert.equal(state, OK);
	assert.equal(coordCalls.length, 1);
});

// --- Unofficial ---

test("a pano id longer than 22 characters is unofficial", () => {
	const { state } = stateOf({ panoId: LONG, flags: PINNED }, { panos: { [LONG]: meta(LONG) } });
	assert.equal(state, UNOFFICIAL);
});

test("a user-photo copyright is unofficial", () => {
	for (const copyright of ["Photo by Someone", "USER-UPLOADED panorama", "user uploaded photo"]) {
		const { state } = stateOf(
			{ panoId: A, flags: PINNED },
			{ panos: { [A]: meta(A, { copyright }) } },
		);
		assert.equal(state, UNOFFICIAL, copyright);
	}
});

test("a Google copyright is not unofficial", () => {
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{ panos: { [A]: meta(A, { copyright: "© 2021 Google" }) } },
	);
	assert.equal(state, OK);
});

// --- Badcam ---

test("a badcam capture with a better camera in its timeline reports one", () => {
	const { state, metaCalls } = stateOf(
		{ panoId: A },
		{
			panos: {
				[A]: badcam(A, { timeline: [{ panoId: B, date: { year: 2019, month: 5, day: 1 } }] }),
				[B]: meta(B),
			},
			coords: { "1,2": A },
		},
	);
	assert.equal(state, GOODCAM_AVAILABLE);
	// The timeline goes out as one request: the stored pano and its older capture.
	assert.deepEqual(metaCalls.at(-1), [B, A]);
});

test("a badcam capture with no better camera falls through to the timeline checks", () => {
	const { state } = stateOf(
		{ panoId: A },
		{
			panos: {
				[A]: badcam(A, { timeline: [{ panoId: B, date: { year: 2019, month: 5, day: 1 } }] }),
				[B]: badcam(B),
			},
			coords: { "1,2": A },
		},
	);
	// A is the newest official capture and the stored one, so nothing is out of date.
	assert.equal(state, OK);
});

test("a pinned badcam row with a better camera in its timeline reports one", () => {
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{
			panos: {
				[A]: badcam(A, { timeline: [{ panoId: B, date: { year: 2019, month: 5, day: 1 } }] }),
				[B]: meta(B),
			},
			coords: { "1,2": A },
		},
	);
	assert.equal(state, GOODCAM_AVAILABLE);
});

test("a better camera and newer coverage are both reported", () => {
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{
			panos: {
				[A]: badcam(A, {
					date: { year: 2019, month: 5, day: 1 },
					timeline: [{ panoId: B, date: { year: 2021, month: 6, day: 1 } }],
				}),
				[B]: meta(B),
			},
		},
	);
	assert.equal(state, GOODCAM_AVAILABLE | NEWER);
});

// --- Updates ---

test("an unpinned row whose coordinate answers a newer pano reports newer coverage", () => {
	const { state } = stateOf(
		{ panoId: A },
		{
			panos: { [A]: meta(A), [B]: meta(B, { date: { year: 2024, month: 3, day: 1 } }) },
			coords: { "1,2": B },
		},
	);
	assert.equal(state, NEWER);
});

test("a pinned row whose coordinate answers a newer pano is newer and off default", () => {
	// A republished area: the stored pano still resolves but a new graph sits at the coordinate.
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{
			panos: { [A]: meta(A), [B]: meta(B, { date: { year: 2024, month: 3, day: 1 } }) },
			coords: { "1,2": B },
		},
	);
	assert.equal(state, NEWER | OFF_DEFAULT);
});

test("a pin ahead of a lagging default is off default, not newer", () => {
	// The row is pinned to the newest graph; the coordinate's default is an older official
	// pano. Different id, but nothing newer exists.
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{
			panos: {
				[A]: meta(A, { date: { year: 2026, month: 2, day: 1 } }),
				[B]: meta(B, { date: { year: 2023, month: 5, day: 1 } }),
			},
			coords: { "1,2": B },
		},
	);
	assert.equal(state, OFF_DEFAULT);
});

test("a pin whose row sits on a neighbouring frame is judged at the pin's own position", () => {
	const { state, coordCalls } = stateOf(
		{ panoId: A, flags: PINNED },
		{
			panos: { [A]: meta(A, { lat: 1.0001, lng: 2 }), [B]: meta(B) },
			coords: { "1,2": B, "1.0001,2": A },
		},
	);
	assert.equal(state, OK);
	assert.deepEqual(
		coordCalls.map((c) => [c.lat, c.lng]),
		[[1.0001, 2]],
	);
});

test("a stored pano that does not resolve is searched at the row's position", () => {
	const { coordCalls } = stateOf({ panoId: A, flags: PINNED }, { panos: {}, coords: { "1,2": B } });
	assert.deepEqual(
		coordCalls.map((c) => [c.lat, c.lng]),
		[[1, 2]],
	);
});

test("an unofficial pano at the coordinate is off default, not newer or stale", () => {
	// The nearest hit can be a photosphere; only official coverage counts as newer.
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{ panos: { [A]: meta(A), [LONG]: meta(LONG) }, coords: { "1,2": LONG } },
	);
	assert.equal(state, OFF_DEFAULT);
});

test("an unpinned row is never off default", () => {
	const { state } = stateOf(
		{ panoId: A },
		{ panos: { [A]: meta(A), [LONG]: meta(LONG) }, coords: { "1,2": LONG } },
	);
	assert.equal(state, OK);
});

test("a pinned row on an older official capture reports newer coverage", () => {
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{
			panos: {
				[A]: meta(A, {
					date: { year: 2019, month: 5, day: 1 },
					timeline: [{ panoId: B, date: { year: 2021, month: 6, day: 1 } }],
				}),
			},
		},
	);
	assert.equal(state, NEWER);
});

test("a pin on a default that is not the newest is newer and stale, not off default", () => {
	const older = meta(A, {
		date: { year: 2019, month: 5, day: 1 },
		timeline: [{ panoId: B, date: { year: 2021, month: 6, day: 1 } }],
	});
	const { state } = stateOf(
		{ panoId: A, flags: PINNED },
		{ panos: { [A]: older }, coords: { "1,2": A } },
	);
	assert.equal(state, NEWER | DEFAULT_STALE);
});

test("a default behind its own timeline is stale for a row with no stored pano", () => {
	const older = meta(A, {
		date: { year: 2019, month: 5, day: 1 },
		timeline: [{ panoId: B, date: { year: 2021, month: 6, day: 1 } }],
	});
	const { state } = stateOf({ panoId: null }, { panos: { [A]: older }, coords: { "1,2": A } });
	assert.equal(state, DEFAULT_STALE);
});

test("an unpinned row on an older official capture reports newer coverage and a stale default", () => {
	const { state } = stateOf(
		{ panoId: A },
		{
			panos: {
				[A]: meta(A, {
					date: { year: 2019, month: 5, day: 1 },
					timeline: [{ panoId: B, date: { year: 2021, month: 6, day: 1 } }],
				}),
			},
			coords: { "1,2": A },
		},
	);
	assert.equal(state, NEWER | DEFAULT_STALE);
});

test("a stored pano that is not in the timeline is left alone", () => {
	const { state } = stateOf(
		{ panoId: C, flags: PINNED },
		{
			panos: {
				[C]: meta(A, {
					date: { year: 2019, month: 5, day: 1 },
					timeline: [{ panoId: B, date: { year: 2021, month: 6, day: 1 } }],
				}),
			},
		},
	);
	assert.equal(state, OK);
});

// --- Batch behaviour ---

test("an answer says whether its row was pinned", () => {
	const { raw } = runProcedure(
		[
			{ id: 1, lat: 1, lng: 2, panoId: A },
			{ id: 2, lat: 1, lng: 2, panoId: A, flags: PINNED },
			{ id: 3, lat: 1, lng: 2, panoId: null, flags: PINNED },
		],
		{ panos: { [A]: meta(A) }, coords: { "1,2": A } },
	);
	assert.deepEqual(
		raw.map((a) => a.pinned),
		[false, true, false],
	);
});

test("every row is answered in order, once", () => {
	const rows = [
		{ id: 7, lat: 1, lng: 2, panoId: A },
		{ id: 8, lat: 3, lng: 4, panoId: null },
		{ id: 9, lat: 1, lng: 2, panoId: A, flags: PINNED },
	];
	const { answers } = runProcedure(rows, {
		panos: { [A]: meta(A) },
		coords: { "1,2": A },
	});
	assert.deepEqual(answers, [
		{ id: 7, patch: OK },
		{ id: 8, patch: NOT_FOUND },
		{ id: 9, patch: OK },
	]);
});

test("a batch costs the same host rounds however many rows it carries", () => {
	const rows = (n) =>
		Array.from({ length: n }, (_, i) => ({ id: i + 1, lat: 1, lng: 2, panoId: A }));
	const opts = { panos: { [A]: meta(A) }, coords: { "1,2": A } };

	// Stored metadata, then the coordinate lookups, which answer their own metadata.
	const one = runProcedure(rows(1), opts);
	assert.equal(one.hostCalls, 2);

	const many = runProcedure(rows(40), opts);
	assert.equal(many.hostCalls, one.hostCalls);
	assert.equal(many.answers.length, 40);
	assert.equal(many.coordCalls.length, 40, "every row still gets its own lookup");
	assert.deepEqual(
		many.answers.map((a) => a.patch),
		Array(40).fill(OK),
	);
});

test("badcam rows across a batch share one timeline round", () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, lat: 1, lng: 2, panoId: A }));
	const { answers, metaCalls, hostCalls } = runProcedure(rows, {
		panos: {
			[A]: badcam(A, { timeline: [{ panoId: B, date: { year: 2019, month: 5, day: 1 } }] }),
			[B]: meta(B),
		},
		coords: { "1,2": A },
	});
	assert.equal(hostCalls, 3, "one extra round for the timeline, not one per row");
	assert.deepEqual(metaCalls.at(-1), [B, A], "the shared timeline is asked for once");
	assert.deepEqual(
		answers.map((a) => a.patch),
		Array(5).fill(GOODCAM_AVAILABLE),
	);
});

test("the coordinate lookup uses the configured radius", () => {
	const { coordCalls } = stateOf({ panoId: null }, { config: { radius: 25 } });
	assert.equal(coordCalls[0].radius, 25);
});

test("the coordinate lookup defaults to 50 metres", () => {
	const { coordCalls } = stateOf({ panoId: null }, {});
	assert.equal(coordCalls[0].radius, 50);
});

test("an aborted run answers no row it could not decide", () => {
	const rows = [
		{ id: 1, lat: 1, lng: 2, panoId: A },
		{ id: 2, lat: 1, lng: 2, panoId: A },
	];
	const { answers } = runProcedure(rows, {
		panos: { [A]: meta(A) },
		coords: { "1,2": A },
		abortAfter: 1,
	});
	assert.deepEqual(answers, [], "a cancelled run must not report undecided rows as not found");
});
