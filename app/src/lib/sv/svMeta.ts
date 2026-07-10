/* eslint-disable @typescript-eslint/no-explicit-any */
import { isOfficialPano } from "@/lib/sv/panoId";
import { PanoType } from "@/types";
import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataResponse,
	writeGetMetadataRequest,
	type GetMetadataRequest,
	type ImageMetadata,
} from "@/lib/sv/proto/getmetadata.gen";

const RPC_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata";

const BADCAM_THRESHOLDS = new Map<string, (d: Date, lat: number) => boolean>([
	["BD", (d) => d > new Date(2021, 3)],
	["EC", (d) => d > new Date(2022, 2)],
	["FI", (d) => d > new Date(2020, 8)],
	["IN", (d) => d > new Date(2021, 9)],
	["KH", (d) => d > new Date(2022, 9)],
	["LB", (d) => d > new Date(2021, 0)],
	["LK", (d) => d > new Date(2021, 1)],
	["NG", (d) => d > new Date(2021, 5)],
	["NP", (d) => d > new Date(2020, 0)],
	["US", (d, lat) => lat > 52 && d > new Date(2019, 0)],
	["VN", (d) => d > new Date(2020, 0)],
	...[
		"AT",
		"BG",
		"CZ",
		"DK",
		"EE",
		"ES",
		"FR",
		"GB",
		"GR",
		"HR",
		"IT",
		"LT",
		"LV",
		"PL",
		"PT",
		"RO",
		"SE",
	].map(
		(cc) => [cc, (d: Date) => d > new Date(2021, 0)] as [string, (d: Date, lat: number) => boolean],
	),
	["CY", () => true],
	["ST", () => true],
]);

/** Map panorama tile worldSize height to camera generation. */
export function cameraTypeFromHeight(height: number): CameraType {
	switch (height) {
		case 1664:
			return "gen1";
		case 6656:
			return "gen2";
		case 8192:
			return "gen4";
		default:
			return null;
	}
}

/**
 * Best-effort: limited by Google's own tagging. Known edge cases:
 * - _source "scout" = the special-collects pipeline (trekker/snowmobile/museum tripod),
 *   not literally "trekker"; ~2012-2014 collects are tagged sloppily both ways
 *   (tripods without _levelId read as trekker, trekkers with _levelId read as tripod).
 * - Modern Google-ops on-foot gen4 collects are tagged "launch" like cars, so they read as gen4.
 * - scout only refines plain gen2/gen4 results; badcam/tripod/gen1 take precedence
 *   (indoor tripods are also scout).
 */
export function detectCameraType(data: google.maps.StreetViewResolvedPanoramaData): CameraType {
	const scout = data.extra?._source === "scout";
	const base = cameraTypeFromHeight(data.tiles.worldSize.height);
	if (base !== "gen2") return base === "gen4" && scout ? "trekker" : base;
	const imgDate = data.imageDate ? new Date(data.imageDate) : null;
	if (imgDate && imgDate.getFullYear() > 2000) {
		const cc = data.extra?.countryCode;
		const check = cc && BADCAM_THRESHOLDS.get(cc);
		if (check && check(imgDate, data.location.latLng.lat())) return "badcam";
	}
	if (data.extra?._levelId != null) return "tripod";
	return scout ? "trekker" : "gen2";
}

/* Pano ID → imageKey array for protobuf request */
export function panoIdToImageKey(panoId: string): [number, string] {
	if (panoId.startsWith("F:")) return [3, panoId.slice(2)];
	if (isOfficialPano(panoId)) return [2, panoId];
	// Base64url-encoded binary protobuf ImageKey (user-uploaded, etc.) — {1: type, 2: id}
	try {
		const b64 = panoId.replace(/\.+$/, "").replace(/-/g, "+").replace(/_/g, "/");
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const pbf = new PbfReader(bytes);
		let type = 2;
		let id = panoId;
		let field;
		while ((field = pbf.nextField())) {
			if (field === 1) type = pbf.readVarint();
			else if (field === 2) id = pbf.readString();
			else pbf.skip(pbf.type);
		}
		return [type, id];
	} catch {
		return [2, panoId];
	}
}

/** Convert protobuf imageKey [type, id] back to a pano ID string. */
export function imageKeyToPanoId(key: any[]): string {
	if (!key || !key[1]) return "";
	const type = key[0] ?? 2;
	const id: string = key[1];
	if (type === 2 || type === 0) return id;
	if (type === 3) return `F:${id}`;
	// Other types (e.g. 10 = USER_UPLOADED): encode as binary protobuf ImageKey + base64url
	const pbf = new PbfWriter();
	pbf.writeVarintField(1, type);
	pbf.writeStringField(2, id);
	const buf = pbf.finish();
	return btoa(String.fromCharCode(...buf))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function buildGetMetadataRequest(panoIds: string[]): GetMetadataRequest {
	return {
		context: { productId: "apiv3", language: "en" },
		locale: { language: "en", regionCode: "US" },
		key: panoIds.map((id) => {
			const [frontend, keyId] = panoIdToImageKey(id);
			return { key: { frontend, id: keyId } };
		}),
		spec: { component: [1, 2, 3, 4, 8, 6] },
	};
}

export function parseResult(
	m: ImageMetadata | undefined,
): google.maps.StreetViewResolvedPanoramaData | null {
	if (!m || m.status?.code !== 1) return null;

	const info = m.information[0];
	if (!info) return null;

	const locData = info.location;
	const panoRefs = info.relations?.pano ?? [];

	const lat = locData?.location?.lat ?? 0;
	const lng = locData?.location?.lng ?? 0;
	const altitude = locData?.altitude?.meters || 0;
	// pov.heading is the driving direction (same value as tiles.centerHeading)
	const drivingDirection = locData?.pov?.heading ?? null;
	const countryCode = locData?.countryCode || null;
	const levelId = locData?.level?.id ?? null;
	// "launch" = car, "scout" = trekker/alleycat
	const source = m.date?.sourceInfo?.source || null;

	const incDate = m.date?.date;
	const imageDate =
		incDate && incDate.year > 0
			? `${String(incDate.year).padStart(4, "0")}-${String(incDate.month).padStart(2, "0")}`
			: "";

	const panoId = m.pano ? imageKeyToPanoId([m.pano.frontend, m.pano.id]) : "";
	const refPanoId = (ref?: { key?: { frontend: number; id: string } }) =>
		ref?.key ? imageKeyToPanoId([ref.key.frontend, ref.key.id]) : "";

	const copyrightName = m.attribution?.item?.[0]?.name?.name ?? "";
	const uploaderName = m.attribution?.author?.[0]?.name?.text || null;
	const description = (m.description?.description ?? []).map((p) => p.text).join(", ");

	const worldW = m.tiles?.worldSize?.width ?? 0;
	const worldH = m.tiles?.worldSize?.height ?? 0;
	const tileW = m.tiles?.tileSize?.tileSize?.width ?? 0;
	const tileH = m.tiles?.tileSize?.tileSize?.height ?? 0;

	const time = info.time
		.map((e) => ({
			pano: refPanoId(panoRefs[e.target]) || panoId,
			date: new Date(e.date?.year ?? 0, e.date?.month ?? 0, e.date?.day ?? 0),
		}))
		.concat({
			pano: panoId,
			date: new Date(incDate?.year ?? 0, incDate?.month ?? 0, incDate?.day ?? 0),
		})
		.sort((a, b) => a.date.getTime() - b.date.getTime());

	const parsedLinks = info.link.map((l) => ({
		pano: refPanoId(panoRefs[l.target]),
		heading: l.properties?.heading ?? 0,
	}));

	const data = {
		copyright: copyrightName,
		location: {
			latLng: { lat: () => lat, lng: () => lng },
			pano: panoId,
			description,
		},
		imageDate,
		links: parsedLinks,
		time,
		tiles: {
			worldSize: { width: worldW, height: worldH },
			tileSize: { width: tileW, height: tileH },
		},
		extra: {
			altitude,
			panoType: m.pano?.frontend || PanoType.Official,
			cameraType: null as CameraType,
			countryCode,
			uploaderName,
			drivingDirection,
			_levelId: levelId,
			_source: source,
		},
	} as google.maps.StreetViewResolvedPanoramaData;

	data.extra!.cameraType = detectCameraType(data);
	return data;
}

/** Fetch full pano metadata directly from Google's internal RPC (bypasses StreetViewService). */
export async function fetchSvMetadata(
	panoIds: string[],
): Promise<(google.maps.StreetViewResolvedPanoramaData | null)[]> {
	if (panoIds.length === 0) return [];
	const writer = new PbfWriter();
	writeGetMetadataRequest(buildGetMetadataRequest(panoIds), writer);
	// Binary protobuf both ways: the response format mirrors the request content-type
	const res = await fetch(RPC_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-protobuf",
			"x-user-agent": "grpc-web-javascript/0.1",
		},
		body: writer.finish().slice(),
		mode: "cors",
		credentials: "omit",
	});
	if (!res.ok) return panoIds.map(() => null);
	const resp = readGetMetadataResponse(new PbfReader(new Uint8Array(await res.arrayBuffer())));
	const statusCode = resp.status?.code;
	if (statusCode === 3 || statusCode === 5) return panoIds.map(() => null);
	return resp.metadata.map(parseResult);
}
