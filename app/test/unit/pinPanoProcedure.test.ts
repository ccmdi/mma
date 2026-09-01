/* The pinPano procedure against a stubbed host: the flag patch, the useLatest timeline
 * move, and the failure paths (no pano id, metadata answered null). */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { imageKeyToPanoId } from "@/lib/sv/panoId";
import { BIN_CAR, JSON_CAR, BIN_DEAD } from "./fixtures/getMetadataFixtures";

const app = fileURLToPath(new URL("../..", import.meta.url));
// The bundle is a build artifact, not a checked-in one.
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "pinPano"], { cwd: app });
/* eslint-disable @typescript-eslint/no-explicit-any */
const mod: any = await import(
	new URL("../../src-tauri/procedures/pinPano.js", import.meta.url).href
);

const b64Bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const CAR_PANO = imageKeyToPanoId(JSON_CAR[1][0][1] as [number, string]);
const LOAD_AS_PANO_ID = 1;

function withHost<T>(body: string | null, run: () => T) {
	const failed: number[] = [];
	let fetches = 0;
	(globalThis as any).mma = {
		fetchMany: (reqs: unknown[]) => {
			fetches += reqs.length;
			return reqs.map(() => ({ status: 200, body: body ? b64Bytes(body) : new Uint8Array() }));
		},
		log: () => {},
		progress: () => {},
		fail: (id: number) => failed.push(id),
		aborted: () => false,
	};
	return { out: run(), failed, fetches: () => fetches };
}

describe("pinPano procedure", () => {
	it("pins an unpinned row by setting the flag, without any request", () => {
		mod.configure(null);
		const { out, failed, fetches } = withHost(null, () =>
			mod.run([{ id: 1, lat: 0, lng: 0, panoId: "abc", flags: 0 }]),
		);
		expect(out).toEqual([{ id: 1, patch: { flags: LOAD_AS_PANO_ID } }]);
		expect(failed).toEqual([]);
		expect(fetches()).toBe(0);
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
		const { out, failed } = withHost(BIN_CAR, () =>
			mod.run([{ id: 7, lat: 0, lng: 0, panoId: CAR_PANO, flags: LOAD_AS_PANO_ID }]),
		);
		expect(failed).toEqual([]);
		expect(out).toHaveLength(1);
		// The car fixture's newest official capture is the pano itself (2021-09).
		expect(out[0]).toEqual({
			id: 7,
			patch: { panoId: CAR_PANO, flags: LOAD_AS_PANO_ID },
		});
	});

	it("useLatest fails a row whose metadata answers null", () => {
		mod.configure({ force: true, config: { useLatest: true } });
		const { out, failed } = withHost(BIN_DEAD, () =>
			mod.run([{ id: 9, lat: 0, lng: 0, panoId: "dead", flags: 0 }]),
		);
		expect(out).toEqual([]);
		expect(failed).toEqual([9]);
	});
});
