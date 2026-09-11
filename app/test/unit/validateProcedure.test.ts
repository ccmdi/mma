/* The validate procedure's notion of "pinned" is the shared `isPinned` predicate: the
 * LoadAsPanoId flag alone does not pin a row that carries no pano id. With pinned checks
 * off, the badcam/goodcam check runs only for an unpinned row, so its verdict is the
 * observable. */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Pano, PanoAnswer, PanoQuery } from "@/bindings.gen";
import { ValidationState } from "@/bindings.consts";
import { CAR_PANO } from "./fixtures/pano";

const app = fileURLToPath(new URL("../..", import.meta.url));
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "validate"], { cwd: app });
/* eslint-disable @typescript-eslint/no-explicit-any */
const mod: any = await import(
	new URL("../../src-tauri/procedures/validate.js", import.meta.url).href
);

const BADCAM: Pano = { ...CAR_PANO, cameraType: "badcam" };
const found = (pano: Pano): PanoAnswer => ({ state: "found", pano });

/** A host whose coordinate search finds the badcam capture and whose timeline lookups
 *  answer the good gen2 one. Records the queries of each `mma.panos` round. */
function withHost<T>(run: () => T): { out: T; rounds: PanoQuery[][] } {
	const rounds: PanoQuery[][] = [];
	(globalThis as any).mma = {
		panos: (queries: PanoQuery[]) => {
			rounds.push(queries);
			return queries.map((q: any) => {
				if (q.panoId === undefined) return found(BADCAM); // the coordinate search
				if (!q.panoId) return { state: "notFound" };
				return rounds.length === 1 ? found(BADCAM) : found(CAR_PANO);
			});
		},
		log: () => {},
		progress: () => {},
		fail: () => {},
		aborted: () => false,
	};
	return { out: run(), rounds };
}

const row = (panoId: string) => ({
	id: 1,
	lat: CAR_PANO.lat,
	lng: CAR_PANO.lng,
	panoId,
	flags: 1,
	tags: [],
});

describe("validate procedure", () => {
	const configured = (run: () => unknown) => {
		mod.configure({ fields: [], force: false, config: { checkPinned: false } });
		try {
			return withHost(run);
		} finally {
			mod.configure(null);
		}
	};

	it("treats a flagged row with no pano id as unpinned", () => {
		const { out, rounds } = configured(() => mod.run([row("")]));
		expect(out).toEqual([{ id: 1, patch: ValidationState.GoodcamAvailable }]);
		// The timeline round only happens for a row the procedure considers unpinned.
		expect(rounds[2]).toHaveLength(CAR_PANO.time.length);
	});

	it("skips the goodcam round for a genuinely pinned row", () => {
		const { out, rounds } = configured(() => mod.run([row(CAR_PANO.id)]));
		expect(out).toEqual([{ id: 1, patch: ValidationState.Ok }]);
		expect(rounds[2]).toHaveLength(0);
	});
});
