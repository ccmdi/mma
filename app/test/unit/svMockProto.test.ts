import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PbfReader, PbfWriter } from "pbf";
import { readGetMetadataResponse, writeGetMetadataRequest } from "@/lib/sv/proto/getmetadata.gen";
import { parseResult } from "@/lib/sv/svMeta";
import { installSvMock } from "../e2e/svMock";

/* The e2e SV mock hand-encodes binary protobuf (it runs self-contained in the webview).
 * This pins its wire output to the real schema reader so the two can't drift apart. */

const RU_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const GM_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata?alt=proto";

const g = globalThis as Record<string, unknown>;
let hadWindow = false;
let prevWindow: unknown;

beforeAll(() => {
	hadWindow = "window" in g;
	prevWindow = g.window;
	g.window = {
		fetch: async () => new Response("passthrough"),
		// minimal google.maps so patchSVS succeeds synchronously (no polling interval leaks)
		google: {
			maps: {
				StreetViewService: { prototype: {} },
				StreetViewPanorama: { prototype: {} },
				event: { trigger: () => undefined },
			},
		},
	};
	installSvMock();
});

afterAll(() => {
	if (hadWindow) g.window = prevWindow;
	else delete g.window;
});

async function fetchMock(panoIds: string[]) {
	const w = g.window as { fetch: typeof fetch };
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
	const res = await w.fetch(GM_URL, { method: "POST", body: writer.finish() });
	const bin = new Uint8Array(await res.arrayBuffer());
	return readGetMetadataResponse(new PbfReader(bin));
}

describe("svMock binary GetMetadata", () => {
	it("encodes fixture panos decodable by the schema reader", async () => {
		const resp = await fetchMock([RU_PANO]);
		expect(resp.status?.code).toBe(0);
		const parsed = parseResult(resp.metadata[0])!;
		expect(parsed).not.toBeNull();
		expect(parsed.location!.pano).toBe(RU_PANO);
		expect(parsed.location!.latLng.lat()).toBeCloseTo(52.10947502806108, 9);
		expect(parsed.location!.latLng.lng()).toBeCloseTo(34.90131410856584, 9);
		expect(parsed.extra!.countryCode).toBe("RU");
		expect(parsed.extra!.altitude).toBeCloseTo(142, 3);
		expect(parsed.imageDate).toBe("2021-09");
		expect(parsed.tiles!.worldSize).toEqual({ width: 16384, height: 8192 });
	});

	it("encodes dead panos as non-OK results", async () => {
		const resp = await fetchMock(["DEAD_PANO", RU_PANO]);
		expect(resp.metadata).toHaveLength(2);
		expect(parseResult(resp.metadata[0])).toBeNull();
		expect(parseResult(resp.metadata[1])).not.toBeNull();
	});
});
