/* The panoResolve procedure end to end, against a stubbed host. Two things are pinned:
 * the patch a `run` emits (which the collect sink hands to `panoDownload` as its `value`),
 * and that `query {op:"at"}` answers whole panos, not ids -- the coordinate search carries
 * the metadata, so a caller that needs both must not have to fetch twice. */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BIN_CAR, JSON_CAR } from "./fixtures/getMetadataFixtures";

const app = fileURLToPath(new URL("../..", import.meta.url));
// The bundle is a build artifact, not a checked-in one.
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "panoResolve"], { cwd: app });
/* eslint-disable @typescript-eslint/no-explicit-any */
const mod: any = await import(
	new URL("../../src-tauri/procedures/panoResolve.js", import.meta.url).href
);

/** The image key the car fixture carries, as a location search would answer it. */
const PANO = JSON_CAR[1][0][1][1] as string;
const searchBody = new TextEncoder().encode(JSON.stringify([[0], JSON_CAR[1][0]]));

function withHost<T>(run: () => T): T {
	(globalThis as any).mma = {
		fetchMany: (reqs: unknown[]) => reqs.map(() => ({ status: 200, body: searchBody })),
		log: () => {},
		progress: () => {},
		fail: () => {},
		aborted: () => false,
	};
	return run();
}

describe("panoResolve procedure", () => {
	it("patches a row with the pano id the search found", () => {
		mod.configure(null);
		const out = withHost(() => mod.run([{ id: 7, lat: 1, lng: 2, panoId: null }]));
		expect(out).toEqual([{ id: 7, patch: { panoId: PANO } }]);
	});

	it("leaves a row that already carries a pano id alone", () => {
		mod.configure(null);
		const out = withHost(() => mod.run([{ id: 7, lat: 1, lng: 2, panoId: "kept" }]));
		expect(out).toEqual([]);
	});

	it("re-resolves a stored pano when the run is forced, which is what pinning asks for", () => {
		mod.configure({ force: true });
		const out = withHost(() => mod.run([{ id: 7, lat: 1, lng: 2, panoId: "stale" }]));
		expect(out).toEqual([{ id: 7, patch: { panoId: PANO } }]);
	});

	it("answers whole panos from the `at` query, not ids", () => {
		mod.configure(null);
		const [pano] = withHost(() => mod.query({ op: "at", points: [{ lat: 1, lng: 2 }] })) as any[];
		expect(pano.pano).toBe(PANO);
		// The metadata rides along: no second lookup to learn the timeline or the camera.
		expect(pano.time.length).toBeGreaterThan(0);
		expect(pano.worldSize.height).toBeGreaterThan(0);
	});

	it("rejects an unknown query op rather than guessing", () => {
		expect(withHost(() => mod.query({ op: "nope" }))).toEqual({
			error: "panoResolve: unknown query op",
		});
	});
});

// BIN_CAR is imported so the fixture pair stays in step; the binary half is covered by
// getMetadataProto.test.ts.
void BIN_CAR;
