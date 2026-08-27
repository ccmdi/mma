// Drives the built bundle directly, with `mma.sidecar` stubbed to answer with canned
// detect lines.
import { test } from "node:test";
import assert from "node:assert/strict";

const host = { lines: [], abort: false, calls: [], failed: [], progress: [] };
globalThis.mma = {
	sidecar(pluginId, command, payload, onLine) {
		host.calls.push({ pluginId, command, payload });
		for (const line of host.lines) onLine?.(line);
		return host.lines;
	},
	progress: (units) => host.progress.push(units),
	fail: (id) => host.failed.push(id),
	aborted: () => host.abort,
	log: () => {},
	fetch: () => {
		throw new Error("copyright must not fetch");
	},
	classify: () => {
		throw new Error("copyright must not classify");
	},
};

const { run, query } = await import(new URL("../procedure.js", import.meta.url).href);

function runProc(rows, lines, { abort = false } = {}) {
	Object.assign(host, { lines, abort, calls: [], failed: [], progress: [] });
	const patches = run(rows.map((r) => ({ panoId: null, extra: null, ...r })));
	for (const p of patches) {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patches must be LocationPatch-shaped");
	}
	return {
		patches: patches.map((p) => ({ id: p.id, patch: p.patch.extra })),
		calls: host.calls,
		failed: host.failed,
		progress: host.progress,
	};
}

test("one sidecar call per batch, over the distinct panoIds", () => {
	const { calls, patches } = runProc(
		[
			{ id: 1, panoId: "pA" },
			{ id: 2, panoId: "pB" },
			{ id: 3, panoId: "pA" },
			{ id: 4 },
		],
		[
			JSON.stringify({ panoId: "pA", year: 2019 }),
			JSON.stringify({ panoId: "pB", year: 2022, text: "Google 2022" }),
		],
	);

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		pluginId: "copyright",
		command: "detect",
		payload: '{"panoIds":["pA","pB"]}',
	});
	// Rows without a panoId never reach the sidecar and never get a patch.
	assert.deepEqual(patches, [
		{ id: 1, patch: { copyrightYear: 2019 } },
		{ id: 3, patch: { copyrightYear: 2019 } },
		{ id: 2, patch: { copyrightYear: 2022 } },
	]);
});

test("an error line fails every row sharing that pano", () => {
	const { patches, failed, progress } = runProc(
		[
			{ id: 1, panoId: "pA" },
			{ id: 2, panoId: "pA" },
			{ id: 3, panoId: "pB" },
		],
		[
			JSON.stringify({ panoId: "pA", year: null, error: "tile fetch failed" }),
			JSON.stringify({ panoId: "pB", year: 2021 }),
		],
	);

	assert.deepEqual(patches, [{ id: 3, patch: { copyrightYear: 2021 } }]);
	assert.deepEqual(failed, [1, 2]);
	assert.deepEqual(progress, [1, 1, 1]);
});

test("a null year is neither a patch nor a failure, and progress lines are ignored", () => {
	const { patches, failed, progress } = runProc(
		[{ id: 1, panoId: "pA" }],
		[
			JSON.stringify({ done: 0, total: 1 }),
			JSON.stringify({ panoId: "pA", year: null }),
			JSON.stringify({ panoId: "unknown", year: 1999 }),
		],
	);

	assert.deepEqual(patches, []);
	assert.deepEqual(failed, []);
	assert.deepEqual(progress, [1]);
});

test("a line that is not JSON is skipped, not thrown on", () => {
	const { patches, progress } = runProc(
		[{ id: 1, panoId: "pA" }],
		["starting detect", JSON.stringify({ panoId: "pA", year: 2020 })],
	);
	assert.deepEqual(patches, [{ id: 1, patch: { copyrightYear: 2020 } }]);
	assert.deepEqual(progress, [1]);
});

test("no usable rows means no sidecar call", () => {
	const { calls, patches } = runProc([{ id: 1 }, { id: 2 }], []);
	assert.deepEqual(calls, []);
	assert.deepEqual(patches, []);
});

test("an aborted run never reaches the sidecar", () => {
	const { calls, patches } = runProc([{ id: 1, panoId: "pA" }], [], { abort: true });
	assert.deepEqual(calls, []);
	assert.deepEqual(patches, []);
});

test("a copyright year older than the capture is not written", () => {
	const { patches, failed, progress } = runProc(
		[
			{ id: 1, panoId: "pA", extra: { imageDate: "2022-05" } },
			{ id: 2, panoId: "pA", extra: { imageDate: "2019-01" } },
			{ id: 3, panoId: "pA", extra: { imageDate: "2018-01" } },
			{ id: 4, panoId: "pA" },
		],
		[JSON.stringify({ panoId: "pA", year: 2019 })],
	);
	// Only the row captured after the stamp is dropped; equal years still count.
	assert.deepEqual(patches, [
		{ id: 2, patch: { copyrightYear: 2019 } },
		{ id: 3, patch: { copyrightYear: 2019 } },
		{ id: 4, patch: { copyrightYear: 2019 } },
	]);
	assert.deepEqual(failed, []);
	assert.deepEqual(progress, [1, 1, 1, 1]);
});

test("query label answers one display label per value", () => {
	assert.deepEqual(query({ op: "label", field: "copyrightYear", values: ["2019", "2022"] }), [
		"\u00a9 2019",
		"\u00a9 2022",
	]);
});

test("query label of no values is an empty array", () => {
	assert.deepEqual(query({ op: "label", field: "copyrightYear", values: [] }), []);
});

test("query rejects another field or op", () => {
	assert.throws(() => query({ op: "label", field: "other", values: ["1"] }), /unknown/);
	assert.throws(() => query({ op: "nope" }), /unknown/);
});
