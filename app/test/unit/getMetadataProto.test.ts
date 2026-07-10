import { describe, it, expect } from "vitest";
import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataResponse,
	readGetMetadataRequest,
	writeGetMetadataRequest,
	type GetMetadataRequest,
} from "@/lib/sv/proto/getmetadata.gen";
import { parseResult, imageKeyToPanoId } from "@/lib/sv/svMeta";
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

/** Positional reads of the json+protobuf response — the pre-proto parseResult semantics. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function expectParityWithJson(b64: string, json: any) {
	const r = json[1][0];
	const parsed = parseResult(decode(b64).metadata[0])!;
	expect(parsed).not.toBeNull();

	expect(parsed.location!.pano).toBe(imageKeyToPanoId(r[1]));
	expect(parsed.location!.latLng.lat()).toBe(r[5][0][1][0][2]);
	expect(parsed.location!.latLng.lng()).toBe(r[5][0][1][0][3]);
	f32(parsed.extra!.altitude, Number(r[5][0][1][1]?.[0]) || 0);
	f32(parsed.extra!.drivingDirection, r[5][0][1][2]?.[0] ?? null);
	expect(parsed.extra!.countryCode).toBe(r[5][0][1][4] || null);
	expect(parsed.extra!.panoType).toBe(r[1][0]);
	expect(parsed.extra!._source).toBe(r[6]?.[5]?.[2] ?? null);
	expect(parsed.copyright).toBe(r[4]?.[0]?.[0]?.[0]?.[0] ?? "");
	expect(parsed.imageDate).toBe(
		r[6]?.[7]?.[0] > 0
			? `${String(r[6][7][0]).padStart(4, "0")}-${String(r[6][7][1] ?? 0).padStart(2, "0")}`
			: "",
	);
	expect(parsed.tiles!.worldSize).toEqual({ width: r[2][2][1], height: r[2][2][0] });
	expect(parsed.tiles!.tileSize).toEqual({ width: r[2][3][1][1], height: r[2][3][1][0] });

	const refs = r[5][0][3]?.[0] ?? [];
	const links = r[5][0][6] ?? [];
	expect(parsed.links).toHaveLength(links.length);
	links.forEach((l: any, i: number) => {
		expect(parsed.links![i].pano).toBe(refs[l[0]] ? imageKeyToPanoId(refs[l[0]][0]) : "");
		f32(parsed.links![i].heading, l[1]?.[3] ?? 0);
	});

	const times = r[5][0][8] ?? [];
	expect(parsed.time).toHaveLength(times.length + 1); // + current pano entry
	for (const e of times) {
		const pano = refs[e[0]] ? imageKeyToPanoId(refs[e[0]][0]) : parsed.location!.pano;
		const match = parsed.time!.find((t) => t.pano === pano)!;
		expect(match.date.getTime()).toBe(
			new Date(e[1]?.[0] ?? 0, e[1]?.[1] ?? 0, e[1]?.[2] ?? 0).getTime(),
		);
	}
}

describe("GetMetadata proto parsing", () => {
	it("matches json+protobuf ground truth for car coverage (links, time, relations)", () => {
		expectParityWithJson(BIN_CAR, JSON_CAR);
	});

	it("matches json+protobuf ground truth for alleycat coverage", () => {
		expectParityWithJson(BIN_SCOUT, JSON_SCOUT);
		expect(parseResult(decode(BIN_SCOUT).metadata[0])!.extra!._source).toBe("scout");
	});

	it("reports envelope status 3 for nonexistent panos", () => {
		const resp = decode(BIN_DEAD);
		expect(resp.status?.code).toBe(JSON_DEAD[0][0]);
		expect(resp.status?.code).toBe(3);
		expect(resp.metadata).toHaveLength(0);
	});

	it("yields null for absent or non-OK results", () => {
		expect(parseResult(undefined)).toBeNull();
		expect(parseResult({ status: { code: 3 }, information: [] } as never)).toBeNull();
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
