import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataRequest,
	writeGetMetadataRequest,
	type GetMetadataRequest,
} from "@/lib/proto/getmetadata.gen";
import { imageKeyToPanoId } from "@/lib/sv/panoId";
import { SVMETA_FIELDS } from "@/lib/sv/getMetadata";
import { KNOWN_FIELDS } from "@/bindings.consts";
import {
	BIN_CAR,
	JSON_CAR,
	BIN_SCOUT,
	JSON_SCOUT,
	BIN_DEAD,
	JSON_DEAD,
} from "./fixtures/getMetadataFixtures";

/* Two layers are pinned here: the svMeta module's `metadata` query against live binary
 * captures (with the json+protobuf form of the same responses as ground truth), and the
 * JS wrapper that turns the query's plain JSON back into the shape callers read. */

const app = fileURLToPath(new URL("../..", import.meta.url));
// The bundle is a build artifact, not a checked-in one.
execFileSync(process.execPath, ["scripts/build-procedures.mjs", "svMeta"], { cwd: app });
const { query, run, configure } = await import(
	new URL("../../src-tauri/procedures/svMeta.js", import.meta.url).href
);

const b64Bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** One pano as the `metadata` query answers it; the same capture answers every request. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function queryMetadata(panoIds: string[], body: Uint8Array): any[] {
	(globalThis as any).mma = {
		fetchMany: (reqs: unknown[]) => reqs.map(() => ({ status: 200, body })),
		log: () => {},
		progress: () => {},
		fail: () => {},
		aborted: () => false,
	};
	return JSON.parse(JSON.stringify(query({ op: "metadata", panoIds })));
}

// float32 fields arrive as exact f32 in binary but 7-significant-digit decimals in JSON
const f32 = (a: number | null, b: number | null) => {
	if (a === null || b === null) expect(a).toBe(b);
	else expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(a) * 1e-6);
};

/** Positional reads of the json+protobuf response, as ground truth for the query. */
function expectParityWithJson(b64: string, json: any) {
	const r = json[1][0];
	const [p] = queryMetadata(["ignored"], b64Bytes(b64));
	expect(p).not.toBeNull();

	expect(p.pano).toBe(imageKeyToPanoId(r[1]));
	expect(p.lat).toBe(r[5][0][1][0][2]);
	expect(p.lng).toBe(r[5][0][1][0][3]);
	expect(p.description).toBe((r[3]?.[2] ?? []).map((d: any) => d[0]).join(", "));
	f32(p.altitude, Number(r[5][0][1][1]?.[0]) || 0);
	f32(p.pov?.heading ?? null, r[5][0][1][2]?.[0] ?? null);
	expect(p.countryCode).toBe(r[5][0][1][4] || null);
	expect(p.panoFrontend).toBe(r[1][0]);
	expect(p.levelId).toBe(r[5][0][1][3] ? (r[5][0][1][3][0] ?? 0) : null);
	expect(p.source).toBe(r[6]?.[5]?.[2] ?? null);
	expect(p.copyright).toBe(r[4]?.[0]?.[0]?.[0]?.[0] ?? "");
	expect(
		p.date
			? `${String(p.date.year).padStart(4, "0")}-${String(p.date.month).padStart(2, "0")}`
			: "",
	).toBe(
		r[6]?.[7]?.[0] > 0
			? `${String(r[6][7][0]).padStart(4, "0")}-${String(r[6][7][1] ?? 0).padStart(2, "0")}`
			: "",
	);
	expect(p.worldSize).toEqual({ width: r[2][2][1], height: r[2][2][0] });
	expect(p.tileSize).toEqual({ width: r[2][3][1][1], height: r[2][3][1][0] });

	const refs = r[5][0][3]?.[0] ?? [];
	const links = r[5][0][6] ?? [];
	expect(p.links).toHaveLength(links.length);
	links.forEach((l: any, i: number) => {
		expect(p.links[i].pano).toBe(refs[l[0]] ? imageKeyToPanoId(refs[l[0]][0]) : "");
		f32(p.links[i].heading, l[1]?.[3] ?? 0);
	});

	// The timeline carries the image's own capture on top of the historical entries.
	// `[year, month, day]` is 1-based with 0 for absent, read straight off the response.
	const times = r[5][0][8] ?? [];
	expect(p.time).toHaveLength(times.length + 1);
	const pad = (n: number, w: number) => String(n).padStart(w, "0");
	for (const e of times) {
		const pano = refs[e[0]] ? imageKeyToPanoId(refs[e[0]][0]) : p.pano;
		const match = p.time.find((t: any) => t.pano === pano)!;
		const [y, m, d] = [e[1]?.[0] ?? 0, e[1]?.[1] || 1, e[1]?.[2] || 1];
		expect(match.date).toBe(`${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`);
	}
}

describe("svMeta metadata query", () => {
	it("matches json+protobuf ground truth for car coverage (links, time, relations)", () => {
		expectParityWithJson(BIN_CAR, JSON_CAR);
	});

	it("matches json+protobuf ground truth for alleycat coverage", () => {
		expectParityWithJson(BIN_SCOUT, JSON_SCOUT);
		const [p] = queryMetadata(["ignored"], b64Bytes(BIN_SCOUT));
		expect(p.source).toBe("scout");
	});

	it("answers null for the envelope status nonexistent panos get", () => {
		expect(JSON_DEAD[0][0]).toBe(3);
		expect(queryMetadata(["dead"], b64Bytes(BIN_DEAD))).toEqual([null]);
	});

	it("round-trips the binary request through the schema", () => {
		const req: GetMetadataRequest = {
			context: { productId: "apiv3", language: "en" },
			locale: { language: "en", regionCode: "US" },
			key: [
				{ key: { frontend: 2, id: "20C-1_sANr4OMdhTDM2N-g" } },
				{ key: { frontend: 10, id: "userUpload" } },
			],
			spec: { component: [1, 2, 3, 4, 8, 6] },
		};
		const writer = new PbfWriter();
		writeGetMetadataRequest(req, writer);
		const decoded = readGetMetadataRequest(new PbfReader(writer.finish()));
		expect(decoded).toEqual(req);
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
		(globalThis as any).mma = {
			fetchMany: (reqs: unknown[]) => reqs.map(() => ({ status: 200, body: b64Bytes(BIN_CAR) })),
			log: () => {},
			progress: () => {},
			fail: () => {},
			aborted: () => false,
		};
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
		const failed: number[] = [];
		(globalThis as any).mma = {
			fetchMany: (reqs: unknown[]) => reqs.map(() => ({ status: 200, body: b64Bytes(BIN_DEAD) })),
			log: () => {},
			progress: () => {},
			fail: (id: number) => failed.push(id),
			aborted: () => false,
		};
		configure(null);
		const out = run([{ id: 4, lat: 0, lng: 0, panoId: "gone", extra: null }]);
		expect(out).toEqual([]);
		expect(failed).toEqual([4]);
	});
});
