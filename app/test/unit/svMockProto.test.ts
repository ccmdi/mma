import { describe, it, expect } from "vitest";
import { PbfReader, PbfWriter } from "pbf";
import { readGetMetadataResponse, writeGetMetadataRequest } from "@/lib/proto/getmetadata.gen";
import type { ImageMetadata } from "@/lib/proto/getmetadata.gen";
import { svMockCore } from "../e2e/svMockCore";
import { startSvStub } from "../e2e/svStubServer";

/* The e2e SV mock hand-encodes binary protobuf (it runs self-contained in the webview).
 * This pins its wire output to the real schema reader so the two can't drift apart, and
 * pins the Node stub -- which serves the Rust enrich engine -- to the same builders. */

const RU_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const GM_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata?alt=proto";

function request(panoIds: string[]): Uint8Array {
	const writer = new PbfWriter();
	writeGetMetadataRequest(
		{
			context: { productId: "apiv3", language: "en" },
			locale: { language: "en", regionCode: "US" },
			key: panoIds.map((id) => ({ key: { frontend: 2, id } })),
			spec: { component: [1, 2, 3, 4, 8, 6] },
		},
		writer,
	);
	return writer.finish();
}

function decode(bin: Uint8Array) {
	return readGetMetadataResponse(new PbfReader(bin));
}

function fetchMock(panoIds: string[]) {
	const reply = svMockCore().respond(GM_URL, request(panoIds))!;
	return decode(reply.body as Uint8Array);
}

describe("svMock binary GetMetadata", () => {
	it("encodes fixture panos decodable by the schema reader", () => {
		const resp = fetchMock([RU_PANO]);
		expect(resp.status?.code).toBe(0);
		const m = resp.metadata[0];
		expect(m.status?.code).toBe(1);
		expect(m.pano).toEqual({ frontend: 2, id: RU_PANO });
		const loc = m.information[0].location!;
		expect(loc.location!.lat).toBeCloseTo(52.10947502806108, 9);
		expect(loc.location!.lng).toBeCloseTo(34.90131410856584, 9);
		expect(loc.countryCode).toBe("RU");
		expect(loc.altitude!.meters).toBeCloseTo(142, 3);
		expect(m.date!.date).toMatchObject({ year: 2021, month: 9 });
		expect(m.tiles!.worldSize).toEqual({ width: 16384, height: 8192 });
		expect(m.tiles!.tileSize!.tileSize).toEqual({ width: 512, height: 512 });
	});

	it("encodes dead panos as non-OK results", () => {
		const resp = fetchMock(["DEAD_PANO", RU_PANO]);
		expect(resp.metadata).toHaveLength(2);
		expect(resp.metadata[0].status?.code).not.toBe(1);
		expect(resp.metadata[1].status?.code).toBe(1);
	});

	it("unknown urls are not claimed by the router", () => {
		expect(svMockCore().respond("https://example.com/whatever", null)).toBeNull();
	});
});

/* panoResolve mirrors StreetViewService.getPanorama({location, radius}) onto
 * SingleImageSearch, so the mock has to tell that request apart from exactDate's
 * time-window probe and answer it with an ImageKey the procedure can read back. */
const SIS_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch";

/** The body panoResolve builds (asserted byte-for-byte in its own node:test). */
function locationSearch(lat: number, lng: number, radius = 50): Uint8Array {
	return new TextEncoder().encode(
		`[["apiv3"],[[null,null,${lat},${lng}],${radius}],[null,null,null,null,null,null,null,null,[2],null,[[[2,true,2],[3,true,2],[10,true,2]]]],[[1,2,3,4,8,6]]]`,
	);
}

/** The body exactDate builds for one coverage probe. */
function timeProbe(lat: number, lng: number, start: number, end: number): Uint8Array {
	return new TextEncoder().encode(
		`[["apiv3"],[[null,null,${lat},${lng}],50],[[null,null,null,null,null,null,null,null,null,null,[${start},${end}]],null,null,null,null,null,null,null,[1],null,[[[2,true,2]]]],[[2,6]]]`,
	);
}

/** The reader in plugins/procedure-sdk/assembly/google/singleImageSearch.ts, in JS. */
function locationSearchPanoId(text: string): string {
	const r = JSON.parse(text);
	if (r?.[0]?.[0] !== 0) return "";
	const code = r?.[1]?.[0]?.[0];
	if (code !== 1 && code !== 3) return "";
	const key = r?.[1]?.[1];
	if (!Array.isArray(key) || typeof key[1] !== "string") return "";
	const frontend = key[0] ?? 2;
	if (frontend === 0 || frontend === 2) return key[1];
	if (frontend === 3) return `F:${key[1]}`;
	return "";
}

describe("svMock SingleImageSearch", () => {
	const respond = svMockCore().respond;

	it("answers a location search with the fixture pano at those coords", () => {
		const reply = respond(SIS_URL, locationSearch(52.10947502806108, 34.90131410856584))!;
		expect(locationSearchPanoId(reply.body as string)).toBe(RU_PANO);
	});

	it("answers a location search off-fixture with the synthetic pano", () => {
		const reply = respond(SIS_URL, locationSearch(48.8584, 2.2945))!;
		expect(locationSearchPanoId(reply.body as string)).toBe("MOCK_48.8584_2.2945");
	});

	it("reports no coverage in the ocean", () => {
		const reply = respond(SIS_URL, locationSearch(0, 0))!;
		expect(reply.body).toContain("Search returned no images.");
		expect(locationSearchPanoId(reply.body as string)).toBe("");
	});

	it("still answers the exact-date probe as found, so the bisect converges", () => {
		const reply = respond(SIS_URL, timeProbe(52.10947502806108, 34.90131410856584, 100, 200))!;
		expect(reply.body).not.toContain("Search returned no images.");
		expect(reply.body).not.toContain("MOCK_");
	});
});

/* The engine reaches the mock only through this server, so its responses have to be
 * byte-identical to what the webview mock builds. */
describe("svStubServer", () => {
	it("serves the same three RPCs the webview mock does", async () => {
		const stub = await startSvStub(0, () => {});
		try {
			const base = `http://127.0.0.1:${stub.port}`;
			const meta = await fetch(
				`${base}/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata?alt=proto`,
				{ method: "POST", body: request([RU_PANO]) as BodyInit },
			);
			const served: ImageMetadata = decode(new Uint8Array(await meta.arrayBuffer())).metadata[0];
			expect(served.pano?.id).toBe(RU_PANO);
			expect(served.date!.date).toMatchObject({ year: 2021, month: 9 });

			const sis = await fetch(
				`${base}/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch`,
				{ method: "POST", body: "[]" },
			);
			expect(await sis.text()).not.toContain("Search returned no images.");

			const search = await fetch(
				`${base}/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch`,
				{
					method: "POST",
					body: locationSearch(52.10947502806108, 34.90131410856584) as BodyInit,
				},
			);
			expect(locationSearchPanoId(await search.text())).toBe(RU_PANO);

			const photometa = await fetch(`${base}/maps/photometa/ac/v1?pb=!6m3!1i0!2i0!3i0`);
			expect(await photometa.text()).toContain(")]}'");

			expect(await fetch(`${base}/nope`).then((r) => r.status)).toBe(404);
			expect(stub.hits.filter((h) => h.includes("404"))).toHaveLength(1);
		} finally {
			await stub.close();
		}
	});
});
