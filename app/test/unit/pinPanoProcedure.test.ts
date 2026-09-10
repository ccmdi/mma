/* The pinPano procedure against a stubbed host: the flag patch, the useLatest timeline
 * move, and the failure paths (no pano id, metadata answered null). */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IdQuery, Pano, PanoAnswer } from "@/bindings.gen";
import { CAR_PANO } from "./fixtures/pano";

const app = fileURLToPath(new URL("../..", import.meta.url));
// The bundle is a build artifact, not a checked-in one.
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "pinPano"], { cwd: app });
/* eslint-disable @typescript-eslint/no-explicit-any */
const mod: any = await import(
	new URL("../../src-tauri/procedures/pinPano.js", import.meta.url).href
);

const CAR_PANO_ID = CAR_PANO.pano;
const LOAD_AS_PANO_ID = 1;

/** The host's answer for every non-empty id, aligned to the request the way it is on the
 *  real boundary: an empty id is never asked for, so it never reaches a verdict. */
function withHost<T>(answer: Pano | null, run: () => T) {
	const failed: number[] = [];
	let asked = 0;
	(globalThis as any).mma = {
		panos: (queries: IdQuery[]): PanoAnswer[] => {
			asked += queries.filter((q) => q.panoId).length;
			return queries.map((q) => {
				if (!q.panoId) return { state: "skipped" };
				return answer ? { state: "found", pano: answer } : { state: "notFound" };
			});
		},
		log: () => {},
		progress: () => {},
		fail: (id: number) => failed.push(id),
		aborted: () => false,
	};
	return { out: run(), failed, asked: () => asked };
}

describe("pinPano procedure", () => {
	it("pins an unpinned row by setting the flag, without any request", () => {
		mod.configure(null);
		const { out, failed, asked } = withHost(null, () =>
			mod.run([{ id: 1, lat: 0, lng: 0, panoId: "abc", flags: 0 }]),
		);
		expect(out).toEqual([{ id: 1, patch: { flags: LOAD_AS_PANO_ID } }]);
		expect(failed).toEqual([]);
		expect(asked()).toBe(0);
	});

	it("leaves an already-pinned row alone", () => {
		mod.configure(null);
		const { out, failed } = withHost(null, () =>
			mod.run([{ id: 2, lat: 0, lng: 0, panoId: "kept", flags: LOAD_AS_PANO_ID }]),
		);
		expect(out).toEqual([]);
		expect(failed).toEqual([]);
	});

	it("useLatest moves a forced re-pin to the newest official pano in the timeline", () => {
		mod.configure({ force: true, config: { useLatest: true } });
		const { out, failed } = withHost(CAR_PANO, () =>
			mod.run([{ id: 7, lat: 0, lng: 0, panoId: CAR_PANO_ID, flags: LOAD_AS_PANO_ID }]),
		);
		expect(failed).toEqual([]);
		// The car fixture's newest official capture is the pano itself.
		expect(out).toEqual([{ id: 7, patch: { panoId: CAR_PANO_ID, flags: LOAD_AS_PANO_ID } }]);
	});

	it("useLatest fails a row whose metadata answers null", () => {
		mod.configure({ force: true, config: { useLatest: true } });
		const { out, failed } = withHost(null, () =>
			mod.run([{ id: 9, lat: 0, lng: 0, panoId: "dead", flags: 0 }]),
		);
		expect(out).toEqual([]);
		expect(failed).toEqual([9]);
	});
});
