import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IdQuery, Pano, PanoAnswer } from "@/bindings.gen";
import { SVMETA_FIELDS } from "@/lib/sv/constants";
import { KNOWN_FIELDS } from "@/bindings.consts";
import { CAR_PANO } from "./fixtures/pano";

/* Two layers are pinned here: what the svMeta module makes of the panos the host hands it,
 * and the JS wrapper that turns the query's plain JSON back into the shape callers read. */

const app = fileURLToPath(new URL("../..", import.meta.url));
// The bundle is a build artifact, not a checked-in one.
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "svMeta"], { cwd: app });
const { query, run, configure } = await import(
	new URL("../../src-tauri/procedures/svMeta.js", import.meta.url).href
);

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Installs a host answering every non-empty pano id with `answer`. */
function installHost(answer: Pano | null, opts: { failed?: boolean } = {}) {
	const failed: number[] = [];
	(globalThis as any).mma = {
		panos: (queries: IdQuery[]): PanoAnswer[] =>
			queries.map((q) => {
				if (!q.panoId) return { state: "skipped" };
				if (opts.failed === true) return { state: "failed" };
				return answer ? { state: "found", pano: answer } : { state: "notFound" };
			}),
		log: () => {},
		progress: () => {},
		fail: (id: number) => failed.push(id),
		aborted: () => false,
	};
	return failed;
}

describe("svMeta metadata query", () => {
	it("answers the panos the host found, aligned to the request", () => {
		installHost(CAR_PANO);
		const out = JSON.parse(JSON.stringify(query({ op: "metadata", panoIds: ["a", "b"] })));
		expect(out).toEqual([CAR_PANO, CAR_PANO]);
	});

	it("answers null for a pano the host reached no verdict on", () => {
		installHost(CAR_PANO);
		expect(JSON.parse(JSON.stringify(query({ op: "metadata", panoIds: [""] })))).toEqual([null]);
		installHost(CAR_PANO, { failed: true });
		expect(JSON.parse(JSON.stringify(query({ op: "metadata", panoIds: ["a"] })))).toEqual([null]);
	});

	it("rejects an unknown query op rather than guessing", () => {
		installHost(null);
		expect(query({ op: "nope" })).toEqual({ error: "svMeta: unknown query op" });
	});
});

// --- the JS wrapper over the query ---

const { procedureQuery } = vi.hoisted(() => ({ procedureQuery: vi.fn() }));
vi.mock("@/lib/commands", () => ({ cmd: { procedureQuery } }));

const ANSWER = {
	copyright: "© 2026 Google",
	location: {
		latLng: { lat: 52.5, lng: 13.4 },
		pano: "pA",
		description: "Main Street, Berlin",
		shortDescription: "Main Street",
	},
	imageDate: "2021-06",
	links: [{ pano: "pB", heading: 90 }],
	time: [{ pano: "pB", date: "2019-06-01" }],
	tiles: { worldSize: { width: 16384, height: 8192 }, tileSize: { width: 512, height: 512 } },
	extra: {
		altitude: 34,
		panoType: 2,
		cameraType: "gen4",
		countryCode: "DE",
		uploaderName: null,
		drivingDirection: 12,
		_levelId: null,
		_source: "launch",
		imageDate: "2021-06",
		coverageDates: ["2019-06", "2021-06"],
	},
};

describe("svMetadata", () => {
	// A bare arrow would return the mock itself, which vitest then runs as a cleanup hook.
	beforeEach(() => {
		procedureQuery.mockReset();
	});

	it("asks the svMeta procedure and hands back its answer as it stands", async () => {
		const { svMetadata } = await import("@/lib/sv/query");
		procedureQuery.mockResolvedValue(JSON.stringify([ANSWER]));

		const [data] = await svMetadata(["pA"]);
		expect(procedureQuery).toHaveBeenCalledWith(
			"res://procedures/svMeta.js",
			JSON.stringify({ op: "metadata", panoIds: ["pA"] }),
			null,
			expect.any(Number),
		);
		// Plain JSON, not a live opensv object: no accessors, no Dates.
		expect(data).toEqual(ANSWER);
		expect((data as any)!.location.latLng).toEqual({ lat: 52.5, lng: 13.4 });
		expect(data!.time[0].date).toBe("2019-06-01");
	});

	it("keeps nulls aligned to the requested panos and never queries an empty list", async () => {
		const { svMetadata } = await import("@/lib/sv/query");
		expect(await svMetadata([])).toEqual([]);
		expect(procedureQuery).not.toHaveBeenCalled();

		procedureQuery.mockResolvedValue(JSON.stringify([null, ANSWER]));
		const out = await svMetadata(["dead", "pA"]);
		expect(out[0]).toBeNull();
		expect((out[1] as any)!.location.pano).toBe("pA");
	});

	it("rejects an answer that is not an array", async () => {
		const { svMetadata } = await import("@/lib/sv/query");
		procedureQuery.mockResolvedValue('{"error":"svMeta: unknown query op"}');
		await expect(svMetadata(["pA"])).rejects.toThrow(/svMeta query/);
	});

	it("sends every pano in one query -- the procedure does the splitting", async () => {
		const { svMetadata } = await import("@/lib/sv/query");
		procedureQuery.mockImplementation((_w: string, input: string) =>
			Promise.resolve(JSON.stringify(JSON.parse(input).panoIds.map(() => ANSWER))),
		);
		const panoIds = Array.from({ length: 500 }, (_, i) => `p${i}`);
		const out = await svMetadata(panoIds);
		expect(out).toHaveLength(500);
		expect(procedureQuery).toHaveBeenCalledTimes(1);
		expect(JSON.parse(procedureQuery.mock.calls[0][1]).panoIds).toHaveLength(500);
		expect(out.every((d) => (d as any)?.location.pano === "pA")).toBe(true);
	});
});

describe("the svMeta run pass", () => {
	it("derives every field as the type the field table declares", () => {
		installHost(CAR_PANO);
		configure(null);
		const [out] = run([{ id: 1, lat: 0, lng: 0, panoId: "pA", extra: null }]);
		const extra = out.patch.extra as Record<string, unknown>;
		const defs = Object.fromEntries(KNOWN_FIELDS.map((f) => [f.key, f]));
		for (const key of SVMETA_FIELDS) {
			const value = extra[key];
			expect(value, key).not.toBeUndefined();
			if (value === null) continue;
			switch (defs[key].type) {
				case "number":
					expect(typeof value, key).toBe("number");
					break;
				case "string":
					expect(typeof value, key).toBe("string");
					break;
				case "enum":
					expect(defs[key].values, key).toContain(value);
					break;
				case "month":
					expect(value, key).toMatch(/^\d{4}-\d{2}$/);
					break;
				case "array":
					expect(Array.isArray(value), key).toBe(true);
					break;
				default:
					throw new Error(`no type check for ${key}: ${defs[key].type}`);
			}
		}
	});

	it("fails a row whose pano no longer exists instead of silently retrying it forever", () => {
		const failed = installHost(null);
		configure(null);
		const out = run([{ id: 4, lat: 0, lng: 0, panoId: "gone", extra: null }]);
		expect(out).toEqual([]);
		expect(failed).toEqual([4]);
	});
});
