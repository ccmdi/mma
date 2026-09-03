/**
 * Google's GetMetadata RPC: request builder, response parse, camera-type detection and
 * the batching driver every metadata-backed procedure shares. Binary protobuf both ways;
 * field numbers live in `@/lib/proto/getmetadata.proto`.
 *
 * Leaf module: a procedure bundle reaches this through esbuild, so nothing here may
 * import React, the store, opensv or the command proxy. `fetchMetadata` and the request
 * builders below run against the procedure host (`mma`) and only work inside a procedure;
 * the parse and detection halves are pure and the app calls them directly.
 */

import { PbfReader, PbfWriter } from "pbf";
import {
	readGetMetadataResponse,
	writeGetMetadataRequest,
	type GetMetadataRequest,
	type ImageMetadata,
	type PanoDate,
} from "@/lib/proto/getmetadata.gen";
import type { CameraFrame, Pano } from "@/types";
import type { KNOWN_FIELDS } from "@/bindings.consts";
import { PanoType } from "@/bindings.consts";
import { readImageMetadata as readImageMetadataArray } from "@/lib/proto/getmetadata.array.gen";
import { imageKeyToPanoId, isOfficialPano, panoIdToImageKey } from "@/lib/sv/panoId";
import type { ProcedureRequest } from "@/lib/data/procedureHost";
import type { CameraType } from "@/bindings.gen";

export const GET_METADATA_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetMetadata";

/** 200 is GetMetadata's hard per-request cap. */
export const META_BATCH_SIZE = 200;

// --- request ---

export function buildGetMetadataRequest(panoIds: string[]): GetMetadataRequest {
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

export function encodeGetMetadataRequest(panoIds: string[]): Uint8Array {
	const w = new PbfWriter();
	writeGetMetadataRequest(buildGetMetadataRequest(panoIds), w);
	return w.finish().slice();
}

// --- response ---

export function parseMetadata(m: ImageMetadata | undefined): Pano | null {
	return m?.status?.code === 1 ? parseImage(m) : null;
}

/** The decode without the status gate; a location search reports its own codes. */
function parseImage(m: ImageMetadata): Pano | null {
	const info = m.information[0];
	if (!info) return null;

	const loc = info.location;
	const pano = m.pano ? imageKeyToPanoId([m.pano.frontend, m.pano.id]) : "";
	const parts = (m.description?.description ?? []).map((p) => p.text);
	const relations = (info.relations?.pano ?? []).map((p) =>
		p.key ? imageKeyToPanoId([p.key.frontend, p.key.id]) : "",
	);

	return {
		pano,
		// An image with no key of its own is official coverage. Google can report a frontend
		// outside the three we name, so this is an assertion, not a guarantee.
		panoFrontend: (m.pano?.frontend || PanoType.Official) as PanoType,
		worldSize: {
			width: m.tiles?.worldSize?.width ?? 0,
			height: m.tiles?.worldSize?.height ?? 0,
		},
		tileSize: {
			width: m.tiles?.tileSize?.tileSize?.width ?? 0,
			height: m.tiles?.tileSize?.tileSize?.height ?? 0,
		},
		copyright: m.attribution?.item?.[0]?.name?.name ?? "",
		description: parts.join(", "),
		shortDescription: parts[0] ?? "",
		uploaderName: m.attribution?.author?.[0]?.name?.text || null,
		lat: loc?.location?.lat ?? 0,
		lng: loc?.location?.lng ?? 0,
		altitude: loc?.altitude?.meters || 0,
		pov: loc?.pov ?? null,
		countryCode: loc?.countryCode || null,
		levelId: loc?.level?.id ?? null,
		links: info.link.map((l) => ({
			pano: relations[l.target] ?? "",
			heading: l.properties?.heading ?? 0,
		})),
		// A capture with no date has no place in a history ordered by date.
		time: info.time
			.map((t) => ({ pano: relations[t.target] || pano, date: civilDate(t.date) }))
			.concat({ pano, date: civilDate(m.date?.date) })
			.filter((t) => t.date !== "")
			.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
		date: m.date?.date ?? null,
		source: m.date?.sourceInfo?.source || null,
	};
}

/** Every image in a response, aligned to the request. Empty when the response as a whole
 *  reports no coverage (status 3 or 5), which writes off the request the same way. */
export function decodeMetadataResponse(body: Uint8Array): (Pano | null)[] {
	const resp = readGetMetadataResponse(new PbfReader(body));
	const code = resp.status?.code;
	if (code === 3 || code === 5) return [];
	return resp.metadata.map(parseMetadata);
}

// --- array-JSON ---

/* SingleImageSearch answers the same `ImageMetadata`, as array-JSON: index i is field i+1. */

/** A `Pano` from array-JSON. */
export function parseMetadataArray(a: unknown): Pano | null {
	return parseMetadata(readImageMetadataArray(a));
}

/** As above, for a caller that checked the status itself. */
export function parseImageArray(a: unknown): Pano | null {
	return parseImage(readImageMetadataArray(a));
}

// --- dates ---

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** "" for no date at all. Two-digit years are 19xx; month and day of 0 are the protobuf
 *  default meaning absent, and timeline entries routinely omit the day, so both floor to 1. */
function civilDate(d: PanoDate | null | undefined): string {
	if (!d || d.year <= 0) return "";
	const y = d.year;
	return [
		pad(y <= 99 ? y + 1900 : y, 4),
		pad(d.month > 0 ? d.month : 1, 2),
		pad(d.day > 0 ? d.day : 1, 2),
	].join("-");
}

/** The image's own capture month as `YYYY-MM`, "" when it carries no date. */
export function imageDateOf(m: Pick<Pano, "date">): string {
	const d = m.date;
	return d && d.year > 0 ? `${pad(d.year, 4)}-${pad(d.month, 2)}` : "";
}

/** Every capture month in the timeline, ascending. */
export function coverageDates(p: Pano): string[] {
	return p.time.map((t) => t.date.slice(0, 7));
}

/** The capture history to show for a pano: its own stack merged with the stacks of the panos
 *  beside it, since a partly-official stack carries only part of the history. Entries are
 *  keyed by pano id and later sources win, so pass the pano itself last. */
export function mergeTimelines(sources: (Pano | null | undefined)[]): Pano["time"] {
	const merged = new Map<string, Pano["time"][number]>();
	for (const p of sources) for (const t of p?.time ?? []) merged.set(t.pano, t);
	return [...merged.values()];
}

/** True when nothing in the timeline is official coverage, so the multi-year history lives
 *  on official coverage nearby rather than on these panos. */
export function allUnofficial(time: Pano["time"]): boolean {
	return time.length > 0 && time.every((t) => !isOfficialPano(t.pano));
}

/** The heading at the horizontal centre of the image, which is also the driving direction
 *  on car coverage. The Maps JS API reports this as both `centerHeading` and `originHeading`. */
export function centerHeading(p: Pano): number {
	return p.pov?.heading ?? 0;
}

/** The camera's frame: the heading it faces and its pitch off level, in degrees. */
export function cameraFrame(p: Pano): CameraFrame {
	const heading = centerHeading(p);
	const pitch = 90 - (p.pov?.tilt ?? 90);
	return { heading, pitch: pitch * Math.cos(((heading - (p.pov?.roll ?? 0)) * Math.PI) / 180) };
}

/** How a pano becomes `extra` fields, one derivation per key. The keys are the Rust
 *  field table's, so the filter, the enrichment picker and this projection agree by
 *  construction; the svMeta provider offers exactly these. */
export const SVMETA = {
	altitude: (p) => p.altitude,
	countryCode: (p) => p.countryCode,
	cameraType: (p) => detectCameraType(p),
	panoType: (p) => p.panoFrontend,
	// Capture-time driving direction in degrees, per Google.
	drivingDirection: (p) => (p.pov ? centerHeading(p) : null),
	uploaderName: (p) => p.uploaderName,
	// `YYYY-MM`; null when the pano carries no date.
	imageDate: (p) => imageDateOf(p) || null,
	coverageDates: (p) => coverageDates(p),
} satisfies Partial<Record<(typeof KNOWN_FIELDS)[number]["key"], (p: Pano) => unknown>>;

/** Only to declare what the svMeta provider produces. */
export const SVMETA_FIELDS = Object.keys(SVMETA) as (keyof typeof SVMETA)[];

/** The `extra` merge patch a pano writes onto a row carrying `extra`: `SVMETA`
 *  narrowed to `fields` (null = all), plus nulls for `datetime` and `timezone` when the
 *  row holds an exact date for a different capture month. Those nulls bypass the field
 *  narrowing: a stale exact date is wrong whether or not the run asked for one. An absent
 *  `extra.imageDate` counts as a different month. */
export function metadataPatch(
	p: Pano,
	extra: Record<string, unknown> | null | undefined,
	fields: ReadonlySet<string> | null,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, derive] of Object.entries(SVMETA)) {
		if (fields === null || fields.has(key)) patch[key] = derive(p);
	}
	if (extra?.datetime != null && extra.imageDate !== (imageDateOf(p) || null)) {
		patch.datetime = null;
		patch.timezone = null;
	}
	return patch;
}

// --- camera type ---

const BADCAM_THRESHOLDS = new Map<string, (ym: string, lat: number) => boolean>([
	["BD", (ym) => ym > "2021-04"],
	["EC", (ym) => ym > "2022-03"],
	["FI", (ym) => ym > "2020-09"],
	["IN", (ym) => ym > "2021-10"],
	["KH", (ym) => ym > "2022-10"],
	["LB", (ym) => ym > "2021-01"],
	["LK", (ym) => ym > "2021-02"],
	["NG", (ym) => ym > "2021-06"],
	["NP", (ym) => ym > "2020-01"],
	["US", (ym, lat) => lat > 52 && ym > "2019-01"],
	["VN", (ym) => ym > "2020-01"],
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
		(cc) => [cc, (ym: string) => ym > "2021-01"] as [string, (ym: string, lat: number) => boolean],
	),
	["CY", () => true],
	["ST", () => true],
]);

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Map panorama tile worldSize height to camera generation. */
export function cameraTypeFromHeight(height: number): CameraType | null {
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
 * - `source` "scout" = the special-collects pipeline (trekker/snowmobile/museum tripod),
 *   not literally "trekker"; ~2012-2014 collects are tagged sloppily both ways
 *   (tripods without a level read as trekker, trekkers with one read as tripod).
 * - Modern Google-ops on-foot gen4 collects are tagged "launch" like cars, so they read as gen4.
 * - scout only refines plain gen2/gen4 results; badcam/tripod/gen1 take precedence
 *   (indoor tripods are also scout).
 */
export function detectCameraType(m: Pano): CameraType | null {
	const scout = m.source === "scout";
	const base = cameraTypeFromHeight(m.worldSize.height);
	if (base !== "gen2") return base === "gen4" && scout ? "trekker" : base;
	const ym = imageDateOf(m);
	if (YM_RE.test(ym) && ym > "2000-12") {
		const check = m.countryCode ? BADCAM_THRESHOLDS.get(m.countryCode) : undefined;
		if (check?.(ym, m.lat)) return "badcam";
	}
	if (m.levelId != null) return "tripod";
	return scout ? "trekker" : "gen2";
}

// --- fetching ---

/** Metadata for a run of panos, aligned to the request. `done` marks a pano the fetch
 *  reached a verdict on; `failed` marks one whose request never came back. */
export interface FetchedMetadata {
	metas: (Pano | null)[];
	done: boolean[];
	failed: boolean[];
}

interface Span {
	start: number;
	len: number;
}

function metadataRequest(panos: string[], span: Span): ProcedureRequest {
	return {
		method: "POST",
		url: GET_METADATA_URL,
		headers: {
			"content-type": "application/x-protobuf",
			"x-user-agent": "grpc-web-javascript/0.1",
		},
		body: encodeGetMetadataRequest(panos.slice(span.start, span.start + span.len)),
	};
}

/** Issues every span of a round together and folds the answers into `out`. A multi-pano
 *  request that fails or decodes all-null is usually one poisoned pano, so those spans come
 *  back to be split and retried in the next round rather than being written off. */
function fetchRound(panos: string[], spans: Span[], out: FetchedMetadata): Span[] {
	const res = mma.fetchMany(spans.map((s) => metadataRequest(panos, s)));
	const retry: Span[] = [];
	for (let i = 0; i < spans.length; i++) {
		const span = spans[i];
		const r = res[i];
		if (!r || r.status < 200 || r.status >= 300) {
			// A cancelling run has its requests declined rather than answered; leaving those
			// rows unfinished keeps a cancel from counting them as failures.
			if (mma.aborted()) continue;
			// A failed request says nothing about which pano is at fault, so split it the
			// same way an all-null decode splits. Only a pano that fails alone is failed.
			if (span.len > 1) {
				const mid = Math.ceil(span.len / 2);
				retry.push({ start: span.start, len: mid });
				retry.push({ start: span.start + mid, len: span.len - mid });
				continue;
			}
			out.done[span.start] = true;
			out.failed[span.start] = true;
			continue;
		}
		const metas = decodeMetadataResponse(r.body);
		if (span.len > 1 && !metas.some((m) => m !== null)) {
			const mid = Math.ceil(span.len / 2);
			retry.push({ start: span.start, len: mid });
			retry.push({ start: span.start + mid, len: span.len - mid });
			continue;
		}
		for (let j = 0; j < span.len; j++) {
			out.metas[span.start + j] = metas[j] ?? null;
			out.done[span.start + j] = true;
		}
	}
	return retry;
}

/** Metadata for every pano, in request order, at most `META_BATCH_SIZE` per request.
 *  Every request a round needs goes to the host in one `fetchMany`: this module decides
 *  what to ask for, the host decides how much of it runs at once. */
export function fetchMetadata(panos: string[]): FetchedMetadata {
	const out: FetchedMetadata = {
		metas: new Array<Pano | null>(panos.length).fill(null),
		done: new Array<boolean>(panos.length).fill(false),
		failed: new Array<boolean>(panos.length).fill(false),
	};
	let round: Span[] = [];
	for (let start = 0; start < panos.length; start += META_BATCH_SIZE) {
		round.push({ start, len: Math.min(META_BATCH_SIZE, panos.length - start) });
	}
	while (round.length > 0 && !mma.aborted()) round = fetchRound(panos, round, out);
	return out;
}

/** Distinct pano ids of `panos`, plus each input's slot in that list (-1 for no id). */
export function indexPanos(panos: string[]): { unique: string[]; slot: number[] } {
	const unique: string[] = [];
	const seen = new Map<string, number>();
	const slot = panos.map((p) => {
		if (!p) return -1;
		let at = seen.get(p);
		if (at === undefined) {
			at = unique.length;
			seen.set(p, at);
			unique.push(p);
		}
		return at;
	});
	return { unique, slot };
}
