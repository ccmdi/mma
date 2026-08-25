// Drives the built bundle directly. The point-in-polygon lookup itself is the host's,
// so only this module's own rules are worth pinning here.
import { test } from "node:test";
import assert from "node:assert/strict";

const bundle = await import(
	new URL("../../../src-tauri/procedures/subdivision.js", import.meta.url).href
);

const row = (id, lat, lng) => ({
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
	extra: null,
});

/** Runs the procedure with a stubbed `mma.classify` answering from `names` (keyed by
 *  "lat,lng"); a missing key is the host's "outside every feature". */
function runProc(rows, names, { abort = false } = {}) {
	const calls = [];
	const progress = [];
	globalThis.mma = {
		classify(dataset, lat, lng) {
			calls.push({ dataset, lat, lng });
			return names[`${lat},${lng}`] ?? null;
		},
		progress: (units) => progress.push(units),
		fail: () => assert.fail("subdivision must not fail a row"),
		aborted: () => abort,
		log: () => {},
		fetch: () => assert.fail("subdivision must not fetch"),
		fetchMany: () => assert.fail("subdivision must not fetch"),
		sidecar: () => assert.fail("subdivision must not call a sidecar"),
	};
	const patches = bundle.run(rows);
	for (const p of patches) {
		assert.deepEqual(Object.keys(p.patch), ["extra"], "patches must be LocationPatch-shaped");
	}
	return { patches: patches.map((p) => ({ id: p.id, patch: p.patch.extra })), calls, progress };
}

test("run is the module's only entry point", () => {
	assert.deepEqual(Object.keys(bundle).sort(), ["run"]);
});

test("patches only the rows the host classifies", () => {
	const { patches, calls, progress } = runProc(
		[row(1, 47.3769, 8.5417), row(2, 0, -140), row(3, 48.8566, 2.3522)],
		{ "47.3769,8.5417": "Zürich", "48.8566,2.3522": "Île-de-France" },
	);

	assert.deepEqual(patches, [
		{ id: 1, patch: { subdivision: "Zürich" } },
		{ id: 3, patch: { subdivision: "Île-de-France" } },
	]);
	// An unclassified point is a skip, not a failure: still one progress unit each.
	assert.deepEqual(progress, [1, 1, 1]);
	assert.deepEqual(
		calls.map((c) => c.dataset),
		["adm1", "adm1", "adm1"],
	);
	assert.deepEqual(calls[0], { dataset: "adm1", lat: 47.3769, lng: 8.5417 });
});

test("names that would break the merge patch survive the round trip", () => {
	const name = 'A "quoted" \ name';
	const { patches } = runProc([row(7, 1, 2)], { "1,2": name });
	assert.deepEqual(patches, [{ id: 7, patch: { subdivision: name } }]);
});

test("an aborted run stops before the first row", () => {
	const { patches, calls } = runProc([row(1, 1, 2)], { "1,2": "X" }, { abort: true });
	assert.deepEqual(patches, []);
	assert.deepEqual(calls, []);
});
