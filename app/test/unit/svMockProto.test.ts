import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { svMockCore } from "../e2e/svMockCore";
import { startSvStub } from "../e2e/svStubServer";

/* The e2e SV mock hand-encodes binary protobuf (it runs self-contained in the webview) and
 * nothing in JS reads protobuf back. So the mock is pinned byte-for-byte to the fixtures in
 * `app/src-tauri/src/sv/testdata/`, which `pano.test.rs` decodes with the reader the app
 * actually runs; the Node stub -- which serves the Rust engine -- is pinned to the same bytes. */

const RU_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const GM_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata?alt=proto";

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`../../src-tauri/src/sv/testdata/${name}`, import.meta.url)));

/** A GetMetadata request for a dead pano and the fixture pano, as the Rust encoder builds it. */
const REQUEST = fixture("svmock.request.pb");
const RESPONSE = fixture("svmock.getmetadata.pb");

describe("svMock binary GetMetadata", () => {
	it("answers the pinned bytes the decoder is tested against", () => {
		const reply = svMockCore().respond(GM_URL, REQUEST)!;
		expect(new Uint8Array(reply.body as Uint8Array)).toEqual(RESPONSE);
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

/** The body the host encodes for a location search (pinned byte-for-byte in `sv/pano.test.rs`). */
function locationSearch(lat: number, lng: number, radius = 50): Uint8Array {
	return new TextEncoder().encode(
		`[["apiv3"],[[null,null,${lat},${lng}],${radius}],[null,null,null,null,null,null,null,null,[2],null,[[[2,true,2],[3,true,2],[10,true,2]]]],[[1,2,3,4,8,6]]]`,
	);
}

/** The body the host encodes for exactDate's coverage probe (pinned in `sv/pano.test.rs`). */
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
				{ method: "POST", body: REQUEST as BodyInit },
			);
			expect(new Uint8Array(await meta.arrayBuffer())).toEqual(RESPONSE);

			const sis = await fetch(
				`${base}/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch`,
				{ method: "POST", body: timeProbe(52.10947502806108, 34.90131410856584, 100, 200) as BodyInit },
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
