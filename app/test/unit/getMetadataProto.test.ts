import { describe, it, expect } from "vitest";
import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataResponse,
	readGetMetadataRequest,
	writeGetMetadataRequest,
} from "@/lib/proto/getmetadata.gen";
import {
	buildGetMetadataRequest,
	decodeMetadataResponse,
	imageDateOf,
	parseMetadata,
	parseMetadataArray,
	centerHeading,
	cameraFrame,
	mergeTimelines,
	allUnofficial,
} from "@/lib/sv/getMetadata";
import type { Pano } from "@/types";
import { imageKeyToPanoId } from "@/lib/sv/panoId";
import {
	BIN_CAR,
	JSON_CAR,
	BIN_SCOUT,
	JSON_SCOUT,
	BIN_DEAD,
	JSON_DEAD,
} from "./fixtures/getMetadataFixtures";

const decode = (b64: string) =>
	readGetMetadataResponse(new PbfReader(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));

// float32 fields arrive as exact f32 in binary but 7-significant-digit decimals in JSON
const f32 = (a: number | null, b: number | null) => {
	if (a === null || b === null) expect(a).toBe(b);
	else expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(a) * 1e-6);
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Positional reads of the json+protobuf response — the ground truth the binary parse
 *  has to agree with, field for field. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function expectParityWithJson(b64: string, json: any) {
	const r = json[1][0];
	const parsed = parseMetadata(decode(b64).metadata[0])!;
	expect(parsed).not.toBeNull();

	expect(parsed.pano).toBe(imageKeyToPanoId(r[1]));
	expect(parsed.lat).toBe(r[5][0][1][0][2]);
	expect(parsed.lng).toBe(r[5][0][1][0][3]);
	f32(parsed.altitude, Number(r[5][0][1][1]?.[0]) || 0);
	const pov = r[5][0][1][2];
	f32(parsed.pov?.heading ?? null, pov ? (pov[0] ?? 0) : null);
	f32(parsed.pov?.tilt ?? null, pov ? (pov[1] ?? 0) : null);
	f32(parsed.pov?.roll ?? null, pov ? (pov[2] ?? 0) : null);
	expect(parsed.countryCode).toBe(r[5][0][1][4] || null);
	expect(parsed.panoFrontend).toBe(r[1][0]);
	expect(parsed.source).toBe(r[6]?.[5]?.[2] ?? null);
	expect(parsed.copyright).toBe(r[4]?.[0]?.[0]?.[0]?.[0] ?? "");
	expect(imageDateOf(parsed)).toBe(
		r[6]?.[7]?.[0] > 0 ? `${pad(r[6][7][0], 4)}-${pad(r[6][7][1] ?? 0, 2)}` : "",
	);
	expect(parsed.worldSize).toEqual({ width: r[2][2][1], height: r[2][2][0] });
	expect(parsed.tileSize).toEqual({ width: r[2][3][1][1], height: r[2][3][1][0] });

	const refs = r[5][0][3]?.[0] ?? [];
	const jsonLinks = r[5][0][6] ?? [];
	const parsedLinks = parsed.links;
	expect(parsedLinks).toHaveLength(jsonLinks.length);
	jsonLinks.forEach((l: any, i: number) => {
		expect(parsedLinks[i].pano).toBe(refs[l[0]] ? imageKeyToPanoId(refs[l[0]][0]) : "");
		f32(parsedLinks[i].heading, l[1]?.[3] ?? 0);
	});

	const times = r[5][0][8] ?? [];
	const parsedTimes = parsed.time;
	expect(parsedTimes).toHaveLength(times.length + 1); // + the image's own entry
	for (const e of times) {
		const pano = refs[e[0]] ? imageKeyToPanoId(refs[e[0]][0]) : parsed.pano;
		const match = parsedTimes.find((t) => t.pano === pano)!;
		// Month and day are 1-based on the wire; 0 is the protobuf default meaning absent,
		// and timeline entries routinely omit the day, so both floor to 1.
		const [y, m, d] = [e[1]?.[0] ?? 0, e[1]?.[1] ?? 0, e[1]?.[2] ?? 0];
		expect(match.date).toBe(
			`${pad(y >= 0 && y <= 99 ? y + 1900 : y, 4)}-${pad(m || 1, 2)}-${pad(d || 1, 2)}`,
		);
	}
	expect([...parsedTimes].sort((a, b) => (a.date < b.date ? -1 : 1))).toEqual(parsedTimes);
}

describe("GetMetadata proto parsing", () => {
	it("matches json+protobuf ground truth for car coverage (links, time, relations)", () => {
		expectParityWithJson(BIN_CAR, JSON_CAR);
	});

	it("matches json+protobuf ground truth for alleycat coverage", () => {
		expectParityWithJson(BIN_SCOUT, JSON_SCOUT);
		expect(parseMetadata(decode(BIN_SCOUT).metadata[0])!.source).toBe("scout");
	});

	it("reports envelope status 3 for nonexistent panos", () => {
		const resp = decode(BIN_DEAD);
		expect(resp.status?.code).toBe(JSON_DEAD[0][0]);
		expect(resp.status?.code).toBe(3);
		expect(resp.metadata).toHaveLength(0);
		const bytes = Uint8Array.from(atob(BIN_DEAD), (c) => c.charCodeAt(0));
		expect(decodeMetadataResponse(bytes)).toEqual([]);
	});

	it("yields null for absent or non-OK results", () => {
		expect(parseMetadata(undefined)).toBeNull();
		expect(parseMetadata({ status: { code: 3 }, information: [] } as never)).toBeNull();
		expect(parseMetadata({ status: { code: 1 }, information: [] } as never)).toBeNull();
	});

	it("round-trips the binary request through the schema", () => {
		const req = buildGetMetadataRequest(["20C-1_sANr4OMdhTDM2N-g", "F:abc"]);
		expect(req.key).toEqual([
			{ key: { frontend: 2, id: "20C-1_sANr4OMdhTDM2N-g" } },
			{ key: { frontend: 3, id: "abc" } },
		]);
		const writer = new PbfWriter();
		writeGetMetadataRequest(req, writer);
		expect(readGetMetadataRequest(new PbfReader(writer.finish()))).toEqual(req);
	});
});

/** Deep equality that lets floats differ by their encodings: binary carries the exact f32,
 *  array-JSON carries seven significant digits of it. */
function expectSamePano(a: unknown, b: unknown, path = ""): void {
	if (typeof a === "number" && typeof b === "number") {
		expect(Math.abs(a - b), path).toBeLessThanOrEqual(Math.abs(a) * 1e-6);
		return;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		expect(Array.isArray(a) && Array.isArray(b), path).toBe(true);
		expect((a as unknown[]).length, path).toBe((b as unknown[]).length);
		(a as unknown[]).forEach((v, i) => expectSamePano(v, (b as unknown[])[i], `${path}[${i}]`));
		return;
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		expect(Object.keys(a).sort(), path).toEqual(Object.keys(b).sort());
		for (const k of Object.keys(a)) {
			expectSamePano((a as never)[k], (b as never)[k], `${path}.${k}`);
		}
		return;
	}
	expect(a, path).toBe(b);
}

describe("array-JSON parses to the same Pano as binary", () => {
	// SingleImageSearch answers the same `ImageMetadata` message in array-JSON. If the two
	// readers ever disagree, a coordinate-sourced pano silently differs from a keyed one.
	it("agrees on car coverage", () => {
		expectSamePano(parseMetadataArray(JSON_CAR[1][0]), parseMetadata(decode(BIN_CAR).metadata[0]));
	});

	it("agrees on alleycat coverage", () => {
		expectSamePano(
			parseMetadataArray(JSON_SCOUT[1][0]),
			parseMetadata(decode(BIN_SCOUT).metadata[0]),
		);
	});
});

describe("derivations over a Pano", () => {
	const pano = (over: Partial<Pano> = {}): Pano =>
		({ pano: "p", time: [], pov: null, ...over }) as unknown as Pano;

	// The Maps JS API assembles `tiles` from `location.pov`; opensv encodes
	// `centerHeading`/`originHeading` from pov.heading and `originPitch` as tilt - 90.
	it("reads the camera frame off the pov", () => {
		const p = pano({ pov: { heading: 227.98, tilt: 89.98, roll: 0.81 } });
		expect(centerHeading(p)).toBe(227.98);
		const frame = cameraFrame(p);
		expect(frame.heading).toBe(227.98);
		// tilt 89.98 is 0.02 above level, and the yaw correction is ~cos(227) here
		expect(frame.pitch).toBeCloseTo(0.02 * Math.cos(((227.98 - 0.81) * Math.PI) / 180), 6);
	});

	it("treats a pano with no pov as level and north-facing", () => {
		expect(centerHeading(pano())).toBe(0);
		expect(cameraFrame(pano())).toEqual({ heading: 0, pitch: 0 });
	});

	// The date picker merges the viewed pano's stack with its neighbour's, because a
	// partly-official stack carries only part of the history. Later sources win.
	it("merges timelines with later sources winning", () => {
		const a = pano({ time: [{ pano: "x", date: "2011-01-01" }] });
		const b = pano({
			time: [
				{ pano: "x", date: "2022-06-01" },
				{ pano: "y", date: "2019-05-01" },
			],
		});
		expect(mergeTimelines([a, b])).toEqual([
			{ pano: "x", date: "2022-06-01" },
			{ pano: "y", date: "2019-05-01" },
		]);
	});

	it("skips absent sources rather than failing", () => {
		expect(mergeTimelines([null, null])).toEqual([]);
		expect(
			mergeTimelines([null, pano({ time: [{ pano: "x", date: "2020-01-01" }] })]),
		).toHaveLength(1);
	});

	it("flags a timeline with no official coverage, which is what triggers the wider search", () => {
		expect(allUnofficial([{ pano: "F:abc", date: "2020-01-01" }])).toBe(true);
		expect(allUnofficial([{ pano: "-zrYsLR4Fh-cfJG_EMZ1-A", date: "2020-01-01" }])).toBe(false);
		expect(allUnofficial([])).toBe(false);
	});
});
