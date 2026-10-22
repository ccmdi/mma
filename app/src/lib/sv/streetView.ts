import type { Location, Pano, PanoAnswer } from "@/bindings.gen";
import {
	LocationFlag,
	PanoType,
	type CameraType,
	type CapturePick,
	type RankingStrategy,
} from "@/bindings.consts";
import {
	createLocation,
	isPinned,
	type LatLng,
	type PanoView,
	type Selector,
	type Tag,
} from "@/types";
import { Edit } from "@/store/edit";
import { all, has, panoIdSelector } from "@/store/selections";
import { Provider } from "@/lib/data/provider";
import { Procedure, type BatchOutcome, type BulkOpts } from "@/lib/data/procedure";
import { cmd } from "@/lib/commands";
import { angularDelta, distMeters, reverseHeading } from "@/lib/geo/geo";
import { fetchPanoDotsWithIds } from "@/lib/geo/photometa";
import { latLngToWorld, worldToTile } from "@/lib/geo/mercator";
import { cancellable } from "@/lib/runs";
import { t } from "@/lib/i18n";
import {
	headingRoadProvider,
	panoResolveProvider,
	svMetaProvider,
	type RoadDirection,
} from "@/lib/sv/providers";
import { SV_SEARCH_RADIUS, isOfficialPano, isUnofficial } from "@/lib/sv/rules";
import { runConcurrent } from "@/lib/util/concurrent";
import { fileTimestamp } from "@/lib/util/format";
import { toast } from "@/lib/util/toast";
import { bestBy, downloadBlob, mmaBufUrl, schemeBase } from "@/lib/util/util";
import { canvasToBlob, perspectiveView } from "@/lib/util/image";

/** How a coordinate search runs: how far it reaches, which collections it searches, and
 *  whether it picks the nearest or the best pano. `onPano` sees each point's answer the
 *  moment its search resolves, ahead of the full array. */
export interface SearchOpts {
	radius?: number;
	sources?: PanoType[];
	preference?: RankingStrategy;
	signal?: AbortSignal;
	onPano?: (index: number, pano: Pano | null) => void;
}

/** How a bulk pin settles each location's pano before pinning it. */
export interface PinOpts extends BulkOpts {
	/** Resolve pano ids first; off, only locations that already carry one are pinned. */
	resolve?: boolean;
	/** Move each resolved pano to this capture of its timeline. */
	capture?: CapturePick | null;
	/** Re-resolve already pinned locations too. */
	force?: boolean;
}

/** What a bulk pin did: the locations newly pinned, the ones whose pano could not be
 *  resolved, and how many pano ids the resolve wrote. */
export interface PinOutcome extends BatchOutcome {
	resolved: number;
}

/** View a Google Maps link should open at. */
export type MapsPanoView = PanoView & Pick<Location, "lat" | "lng">;

export type PanoRenderMode = "equirectangular" | "perspective" | "thumbnail" | "tile";

export interface PanoDownloadConfig {
	mode: PanoRenderMode;
	zoom: number;
	tileX: number;
	tileY: number;
}

export interface BulkDownloadResult extends BatchOutcome {
	/** Temp file (single image or ZIP) ready for the export save dialog; null when nothing downloaded. */
	output: { path: string; name: string } | null;
}

/** Preference order under `preferHigherQuality`, lower first. `null` means the type is not a candidate at that setting. */
const CAMERA_RANK: Record<CameraType, number | null> = {
	gen4: 0,
	gen2: 1,
	tripod: 2,
	badcam: 3,
	gen1: 4,
	trekker: null,
};

interface RankOpts {
	userUploaded?: "allow" | "avoid" | "ignore";
	preferHigherQuality?: boolean;
}

/** The candidates a click may land on, best first: unranked camera types are dropped under
 *  `preferHigherQuality`, then user uploads sink, camera quality decides, and the newest
 *  capture breaks the tie. */
function rankCandidates(candidates: Pano[], opts: RankOpts): Pano[] {
	const userUploaded = opts.userUploaded ?? "allow";
	let filtered = candidates;
	if (userUploaded === "ignore") filtered = filtered.filter((c) => !isUnofficial(c));
	if (opts.preferHigherQuality) {
		filtered = filtered.filter((c) => c.cameraType == null || CAMERA_RANK[c.cameraType] !== null);
	}

	return [...filtered].sort((x, y) => {
		if (userUploaded === "avoid") {
			const xu = isUnofficial(x);
			const yu = isUnofficial(y);
			if (xu && !yu) return 1;
			if (!xu && yu) return -1;
		}
		if (opts.preferHigherQuality) {
			const xc = x.cameraType;
			const yc = y.cameraType;
			if (xc != null && yc == null) return -1;
			if (xc == null && yc != null) return 1;
			if (xc != null && yc != null) {
				const xi = CAMERA_RANK[xc] ?? Infinity;
				const yi = CAMERA_RANK[yc] ?? Infinity;
				if (xi < yi) return -1;
				if (xi > yi) return 1;
			}
		}
		if (userUploaded === "allow") return 0;
		const xd = x.imageDate || "9999-99";
		const yd = y.imageDate || "9999-99";
		return -xd.localeCompare(yd);
	});
}

/** Nearest pano via photometa tile dots, a coverage source neither RPC exposes. */
async function photometaSnap(click: LatLng, radius: number): Promise<Pano | null> {
	try {
		const wc = latLngToWorld(click);
		const tile = worldToTile(wc.x, wc.y, 17);
		const dots = await fetchPanoDotsWithIds(tile);
		if (!dots.length) return null;
		const scored = dots
			.map((d) => ({ panoId: d.panoId, dist: distMeters(click, { lat: d.lat, lng: d.lng }) }))
			.filter((d) => d.dist < radius);
		const best = bestBy(scored, (a, b) => a.dist < b.dist);
		if (!best) return null;
		const [pano] = await StreetView.metadata([best.panoId]);
		return pano;
	} catch {
		return null;
	}
}

function fovForZoom(zoom: number): number {
	return (360 / Math.PI) * Math.atan(0.75 * Math.pow(2, 1 - zoom));
}

// Routed through the Tauri `gmaps` URI-scheme handler (server-side proxy to
// www.google.com), so it works in dev and release.
const BATCH_URL = `${schemeBase("gmaps")}maps/_/MapsWizUi/data/batchexecute`;

const DOWNLOAD_CONCURRENCY = 4;

/** A panorama stitched at `zoom` and cropped to its imagery, as a JPEG. */
function panoUrl(panoId: string, zoom: number): string {
	return `${schemeBase("pano")}${panoId}/${zoom}`;
}

async function fetchImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
	try {
		const resp = await fetch(url, { signal });
		return resp.ok ? await resp.blob() : null;
	} catch {
		return null;
	}
}

/** A `pano:` image under a run of its own, so an abort stops its tile fetches too. */
function fetchPanoImage(url: string, signal?: AbortSignal): Promise<Blob | null> {
	return cancellable(signal, false, (runId) =>
		fetchImage(runId === null ? url : `${url}?run=${runId}`, signal),
	).catch(() => null);
}

/** Render one location's image per the configured mode. Null on failure. */
async function renderLocationImage(
	loc: Location,
	panoId: string,
	meta: Pano | null,
	config: PanoDownloadConfig,
	signal?: AbortSignal,
): Promise<{ blob: Blob; fileName: string } | null> {
	if (config.mode === "thumbnail") {
		const url = new URL(StreetView.thumbnailUrl(panoId, loc.heading, 1024, 768));
		url.searchParams.set("pitch", String(loc.pitch));
		const blob = await fetchImage(url.toString(), signal);
		return blob ? { blob, fileName: `${panoId}.png` } : null;
	}

	if (config.mode === "tile") {
		const blob = await fetchPanoImage(
			`${panoUrl(panoId, config.zoom)}/${config.tileX}/${config.tileY}`,
			signal,
		);
		return blob
			? { blob, fileName: `${panoId}_z${config.zoom}_x${config.tileX}_y${config.tileY}.jpg` }
			: null;
	}

	const pano = await fetchPanoImage(panoUrl(panoId, config.zoom), signal);
	if (!pano) return null;
	if (config.mode === "equirectangular") return { blob: pano, fileName: `${panoId}.jpg` };

	const bitmap = await createImageBitmap(pano);
	const perspective = perspectiveView(
		bitmap,
		125,
		loc.heading - (meta ? meta.centerHeading : 0),
		loc.pitch,
		1920,
		1080,
	);
	bitmap.close();
	const blob = await canvasToBlob(perspective).catch(() => null);
	return blob && { blob, fileName: `${panoId}.png` };
}

/** Google Street View: coverage lookups and pano metadata, search radii, pinning locations to
 *  their panos and turning them along the road, links into Google Maps, and panorama
 *  downloads. @api @unstable */
export const StreetView = {
	/** Metres a coordinate search reaches by default. */
	searchRadius: SV_SEARCH_RADIUS,
	/** Metres the viewer searches for official coverage when a pano's own timeline holds none. */
	officialFallbackRadius: 25,
	/** Metres a jump to a typed-in coordinate searches. */
	jumpRadius: 100,
	/** Whether a pano id names official Google coverage. */
	isOfficial: isOfficialPano,

	/** A pano's stack merged with another's, for the all-unofficial case where the multi-year
	 *  history lives on official coverage nearby. Entries are keyed by pano id and later
	 *  sources win, so pass the pano itself last. Ascending by date, as every timeline is. */
	mergeTimelines: (sources: (Pano | null)[]): Pano["time"] => {
		const merged = new Map<string, Pano["time"][number]>();
		for (const p of sources) for (const t of p?.time ?? []) merged.set(t.panoId, t);
		return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	},

	/** True when nothing in the timeline is official coverage, an empty stack included, so
	 *  the multi-year history lives on official coverage nearby rather than on these panos. */
	allUnofficial: (time: Pano["time"]): boolean => time.every((t) => !isOfficialPano(t.panoId)),

	/** Full pano metadata for one or more panos, aligned to `panoIds`, null where a pano does
	 *  not exist. Rejects when a lookup fails, so a failure is never taken for a missing pano.
	 *  Duplicates are deduped and large batches are split automatically. */
	metadata: async (panoIds: string[], signal?: AbortSignal): Promise<(Pano | null)[]> => {
		if (panoIds.length === 0) return [];
		const answers = await Procedure.query<PanoAnswer[]>(
			svMetaProvider.procedure,
			{ op: "metadata", panoIds },
			{ signal },
		);
		if (!Array.isArray(answers)) throw new Error(`svMeta query answered ${typeof answers}`);
		if (answers.some((a) => a.state === "failed")) throw new Error("Street View lookup failed");
		return panoIds.map((_, i) => {
			const answer = answers[i];
			return answer?.state === "found" ? answer.pano : null;
		});
	},

	/** The nearest pano to each point, aligned to `points`, null where there is no coverage. */
	panosAt: async (
		points: LatLng[],
		{ radius = SV_SEARCH_RADIUS, signal, onPano, ...search }: SearchOpts = {},
	): Promise<(Pano | null)[]> => {
		if (points.length === 0) return [];
		const answers = await Procedure.query<(Pano | null)[], PanoAnswer>(
			panoResolveProvider.procedure,
			{ op: "at", points, radius, ...search },
			{
				signal,
				onPartial:
					onPano &&
					((entries) => {
						for (const e of entries) onPano(e.id, e.value.state === "found" ? e.value.pano : null);
					}),
			},
		);
		if (!Array.isArray(answers)) throw new Error(`panoResolve query answered ${typeof answers}`);
		return points.map((_, i) => answers[i] ?? null);
	},

	/** The pano a location should display: the one it is pinned to when that still resolves,
	 *  otherwise whatever sits at its coordinates. */
	resolve: async (loc: Location): Promise<Pano | null> => {
		if (isPinned(loc)) {
			const [pinned] = await StreetView.metadata([loc.panoId]);
			if (pinned) return pinned;
		}
		const [here] = await StreetView.panosAt([{ lat: loc.lat, lng: loc.lng }]);
		return here;
	},

	/** Metres of map a search covers at `zoom` and latitude `lat`. */
	radiusAtZoom: (lat: number, zoom: number): number =>
		(4 * (156543.03392 * Math.cos((lat * Math.PI) / 180))) / 2 ** zoom,

	/** The radius (m) a map click searches for coverage: the zoom/lat extent, floored by
	 *  `minRadius` (the per-map searchRadius) or the default search radius. */
	clickRadius: (lat: number, zoom: number, minRadius?: number): number =>
		Math.max(minRadius ?? SV_SEARCH_RADIUS, Math.round(StreetView.radiusAtZoom(lat, zoom))),

	/** The heading a new location starts at, from the pano's road links and a direction preference. */
	initialHeading: (
		data: Pano,
		opts?: { pointAlongRoad?: boolean; preferDirection?: string | null },
	): number => {
		if (!opts?.pointAlongRoad) return 0;
		const center = data.centerHeading;
		const dir = opts.preferDirection;
		if (dir === "forwards" || !dir) {
			if (!dir && data.links && data.links.length > 0 && data.links[0].heading != null) {
				return data.links[0].heading;
			}
			return center;
		}
		if (dir === "backwards") return reverseHeading(center);
		if (data.links && data.links.length > 0) {
			let link = data.links[0];
			if (dir === "random") {
				link = data.links[Math.floor(Math.random() * data.links.length)];
			} else {
				const target: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };
				const t = target[dir];
				if (t != null) {
					link =
						bestBy(
							data.links,
							(a, b) => angularDelta(a.heading ?? 0, t) < angularDelta(b.heading ?? 0, t),
						) ?? link;
				}
			}
			if (link.heading != null) return link.heading;
		}
		return center;
	},

	/** The location a map click lands on: the best panorama near the click, its heading, and
	 *  whether it must be pinned because it is not the default coverage there. */
	lookup: async (
		lat: number,
		lng: number,
		zoom: number,
		opts: {
			preferOfficial?: boolean;
			onlyOfficial?: boolean;
			pointAlongRoad?: boolean;
			preferDirection?: string | null;
			defaultPanoId?: boolean;
			preferHigherQuality?: boolean;
			radius?: number;
			minRadius?: number;
		},
	): Promise<Location | null> => {
		const radius = opts.radius ?? StreetView.clickRadius(lat, zoom, opts.minRadius);
		const click = { lat, lng };
		const userUploaded: "ignore" | "avoid" | "allow" = opts.onlyOfficial
			? "ignore"
			: opts.preferOfficial
				? "avoid"
				: "allow";

		// Each probe is one request, and answers the pano's metadata with it. All three are
		// nearest searches; only the collections differ.
		const [[iRes], [aRes], oRes, sRes] = await Promise.all([
			StreetView.panosAt([click], { radius }),
			StreetView.panosAt([click], { radius, sources: [PanoType.Official] }),
			photometaSnap(click, radius),
			userUploaded === "allow"
				? StreetView.panosAt([click], {
						radius,
						sources: [PanoType.Unknown, PanoType.UserUploaded],
					}).then(([p]) => p)
				: null,
		]);

		const candidates: Pano[] = [];
		const push = (e: Pano | null) => {
			if (!e?.id) return;
			if (!candidates.some((c) => c.id === e.id)) candidates.push(e);
		};

		if (iRes && sRes) {
			const di = distMeters(click, { lat: iRes.lat, lng: iRes.lng });
			const ds = distMeters(click, { lat: sRes.lat, lng: sRes.lng });
			push(di > ds ? sRes : iRes);
		} else {
			push(iRes);
		}
		push(aRes);
		push(oRes);
		push(sRes);

		const official = candidates.find((c) => !isUnofficial(c));
		if (official?.time.length) {
			// The whole historical stack, in one request.
			const stack = await StreetView.metadata(official.time.map((t) => t.panoId)).catch(() => []);
			for (const p of stack) push(p);
		}

		const chosen = rankCandidates(candidates, {
			userUploaded,
			preferHigherQuality: opts.preferHigherQuality,
		})[0];
		if (!chosen) return null;

		const [verify] = await StreetView.panosAt([{ lat: chosen.lat, lng: chosen.lng }]);
		const isDefault = verify !== null && verify.id === chosen.id;

		return createLocation({
			lat: chosen.lat,
			lng: chosen.lng,
			heading: StreetView.initialHeading(chosen, opts),
			panoId: chosen.id || null,
			flags: !isDefault || opts.defaultPanoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
		});
	},

	/** Walk linked panoramas from a starting pano in the given heading direction, returning
	 *  the locations along the road, up to `maxSteps`. */
	follow: async (startPanoId: string, heading: number, maxSteps = 50): Promise<Location[]> => {
		const visited = new Set<string>([startPanoId]);
		const results: Location[] = [];
		let currentPanoId = startPanoId;
		let currentHeading = heading;

		for (let i = 0; i < maxSteps; i++) {
			const [data] = await StreetView.metadata([currentPanoId]);
			const links = data?.links;
			if (!links || links.length === 0) break;

			const usable = links
				.filter((l) => l.panoId && !visited.has(l.panoId))
				.map((l) => ({ pano: l.panoId, heading: l.heading ?? 0 }));
			const best = bestBy(
				usable,
				(a, b) => angularDelta(a.heading, currentHeading) < angularDelta(b.heading, currentHeading),
			);
			if (!best || angularDelta(best.heading, currentHeading) > 90) break;

			visited.add(best.pano);
			const [nextData] = await StreetView.metadata([best.pano]);
			if (!nextData) break;

			results.push(
				createLocation({
					lat: nextData.lat,
					lng: nextData.lng,
					heading: best.heading,
					panoId: best.pano,
					flags: LocationFlag.LoadAsPanoId,
				}),
			);

			currentPanoId = best.pano;
			currentHeading = best.heading;
		}
		return results;
	},

	/** A small preview image of a pano facing `heading`. */
	thumbnailUrl: (panoId: string, heading: number, width = 320, height = 180): string => {
		const url = new URL("https://streetviewpixels-pa.googleapis.com/v1/thumbnail?w=320&h=180");
		url.searchParams.set("panoid", panoId);
		url.searchParams.set("cb_client", "maps_sv.share");
		url.searchParams.set("w", String(width));
		url.searchParams.set("h", String(height));
		url.searchParams.set("yaw", String(heading));
		url.searchParams.set("pitch", "0");
		url.searchParams.set("thumbfov", "90");
		return url.toString();
	},

	/** Pin every location in the selector to its pano id, resolving pano ids first when asked. */
	pin: async (selector: Selector, opts: PinOpts = {}): Promise<PinOutcome> => {
		const { resolve = true, capture = null, force = false, ...runOpts } = opts;
		let resolved = 0;
		let failed: number[] = [];
		if (resolve) {
			const target = force ? selector : all(selector, panoIdSelector(false));
			// A pin searches official coverage only: the closest pano can be a photosphere.
			const result = await Provider.run(
				[
					{
						provider: panoResolveProvider,
						select: target,
						config: { sources: [PanoType.Official], ...(capture ? { capture } : {}) },
						force: force || capture !== null,
					},
				],
				selector,
				runOpts,
			);
			resolved = result.panoResolve?.succeeded ?? 0;
			failed = result.panoResolve?.failed ?? [];
		}
		if (runOpts.signal?.aborted) return { succeeded: 0, failed, resolved };
		const pinned = await Edit.work(all(selector, has("panoId")), {
			kind: "set",
			key: "loadAsPanoId",
			value: true,
		});
		return { succeeded: pinned.changed, failed: [...failed, ...pinned.failed], resolved };
	},

	/** Pan every heading in the selector along the road. */
	panHeading: async (
		selector: Selector,
		direction: RoadDirection,
		opts: BulkOpts = {},
	): Promise<BatchOutcome> => {
		const result = await Provider.run(
			[{ provider: panoResolveProvider }, { provider: headingRoadProvider, config: { direction } }],
			selector,
			opts,
		);
		return result.headingRoad ?? Procedure.noWork();
	},

	/** A google.com/maps Street View link aimed at `view`. Official panos embed a thumbnail
	 *  (`!6s`) so the link unfurls with a preview; unofficial ones have none to point at. */
	mapsUrl: (view: MapsPanoView): URL => {
		const { lat, lng, heading, pitch, panoId } = view;
		const fov = fovForZoom(view.zoom);

		let data: string;
		if (isOfficialPano(panoId)) {
			const thumb = new URL("https://streetviewpixels-pa.googleapis.com/v1/thumbnail");
			thumb.searchParams.set("panoid", panoId);
			thumb.searchParams.set("cb_client", "maps_sv.share");
			thumb.searchParams.set("w", "900");
			thumb.searchParams.set("h", "600");
			thumb.searchParams.set("yaw", String(heading));
			thumb.searchParams.set("pitch", String(-pitch));
			thumb.searchParams.set("thumbfov", fov.toFixed(0));
			data = `!3m5!1e1!3m3!1s${panoId}!2e0!6s${encodeURIComponent(thumb.toString())}`;
		} else {
			data = `!3m4!1e1!3m2!1s${panoId}!2e0`;
		}

		const url = new URL(
			`https://www.google.com/maps/@${lat},${lng},3a,${fov.toFixed(1)}y,${heading.toFixed(2)}h,${(pitch + 90).toFixed(2)}t/data=${data}`,
		);
		url.searchParams.set("coh", "235716");
		url.searchParams.set("entry", "tts");
		return url;
	},

	/** Carry a location's tags (and its lat/lng load mode) on a Maps link, so importing it back
	 *  reconstructs them. */
	appendLinkTags: (url: URL, loc: Location, tagsById: Record<number, Tag>): void => {
		for (const id of loc.tags) {
			const name = tagsById[id]?.name;
			if (name) url.searchParams.append("extra[tags]", name);
		}
		if (!isPinned(loc)) url.searchParams.set("extra[loadMode]", "latLng");
	},

	/** Copy a Maps link to the clipboard, shortened unless `long`. */
	copyLink: async (url: URL, { long = false }: { long?: boolean } = {}): Promise<void> => {
		const longStr = url.toString();
		if (long) {
			await navigator.clipboard.writeText(longStr).catch(() => {});
			return;
		}
		try {
			await navigator.clipboard.writeText(await StreetView.shortenLink(longStr));
		} catch {
			await navigator.clipboard.writeText(longStr).catch(() => {});
		}
	},

	/** A Maps link shortened through Google's own shortener, or the link unchanged when that fails. */
	shortenLink: async (longUrl: string): Promise<string> => {
		const innerPayload = JSON.stringify([
			longUrl,
			[null, null, null, null, null, null, 81],
			null,
			null,
			null,
			1,
		]);
		const outerPayload = JSON.stringify([
			[["/MapsUrlService.CreateShortUrl", innerPayload, null, "generic"]],
		]);

		const params = new URLSearchParams({
			rpcids: "ExM4R",
			"source-path": new URL(longUrl).pathname + new URL(longUrl).search,
			hl: "en",
		});
		const body = new URLSearchParams({ "f.req": outerPayload });
		const res = await fetch(`${BATCH_URL}?${params}`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
			body,
			mode: "cors",
			credentials: "omit",
		});

		if (!res.ok) return longUrl;

		const text = await res.text();
		const lines = text.split("\n").filter((l) => l.startsWith("["));
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				const inner = parsed?.[0]?.[2];
				if (typeof inner === "string") {
					const result = JSON.parse(inner);
					if (typeof result?.[0] === "string" && result[0].startsWith("http")) {
						return result[0];
					}
				}
			} catch {
				// ignored
			}
		}

		return longUrl;
	},

	/** Download the full panorama as a single stitched JPEG. Toasts on success/failure. */
	download: async (panoId: string, zoom = 5): Promise<void> => {
		const blob = await fetchImage(panoUrl(panoId, zoom));
		if (blob) {
			downloadBlob(blob, `${panoId}.jpg`);
			toast(t("Panorama downloaded"));
		} else {
			toast(t("Panorama download failed"));
		}
	},

	/** Download panoramas for `locations`, uploading each image into a session dir (via
	 *  mma-buf POST) that is packaged into a single file or Stored ZIP. */
	downloadAll: async (
		locations: Location[],
		config: PanoDownloadConfig,
		opts: BulkOpts = {},
	): Promise<BulkDownloadResult> => {
		const { signal, onProgress } = opts;
		const saved: number[] = [];
		const failed: number[] = [];
		// A hand-run of sequential phases: the bar resets per phase, one part names it.
		const report = (label: string) => (done: number, total: number) =>
			onProgress?.(done, total, [{ label, done, total, failed: 0, finished: false }]);

		const needResolve = locations.filter((l) => !l.panoId);
		const resolvedMap = new Map<number, string>();
		if (needResolve.length > 0) {
			const resolving = report(t("Resolving pano IDs"));
			resolving(0, needResolve.length);
			// The same procedure enrichment runs, borrowed for its answers: a download must
			// not move the panorama the user's location points at.
			const run = await Procedure.run(
				panoResolveProvider.procedure,
				{ type: "Locations", locations: needResolve.map((l) => l.id), name: null },
				{
					id: "panoResolve",
					sink: "collect",
					signal,
					onProgress: (d, total) => resolving(d, total),
				},
			);
			for (const { id, value } of run.collected ?? []) {
				const panoId = value?.panoId;
				if (typeof panoId === "string" && panoId) resolvedMap.set(id, panoId);
			}
			failed.push(...needResolve.filter((l) => !resolvedMap.has(l.id)).map((l) => l.id));
		}

		const pending = locations.flatMap((loc) => {
			const panoId = loc.panoId ?? resolvedMap.get(loc.id);
			return panoId ? [{ loc, panoId }] : [];
		});
		if (pending.length === 0) {
			return { succeeded: saved.length, failed, output: null };
		}

		// A perspective view turns by its pano's center heading; no other mode reads metadata.
		const metaMap = new Map<string, Pano>();
		if (config.mode === "perspective") {
			report(t("Fetching metadata"))(0, pending.length);
			const unique = [...new Set(pending.map((p) => p.panoId))];
			const datas = await StreetView.metadata(unique, signal);
			datas.forEach((d, i) => {
				if (d) metaMap.set(unique[i], d);
			});
		}

		const session = await cmd.storeUploadBegin();
		let done = 0;
		let singleName: string | null = null;

		const usedNames = new Set<string>();
		const uniqueName = (name: string) => {
			if (!usedNames.has(name)) {
				usedNames.add(name);
				return name;
			}
			const dot = name.lastIndexOf(".");
			const stem = name.slice(0, dot);
			const ext = name.slice(dot);
			let i = 2;
			while (usedNames.has(`${stem}_${i}${ext}`)) i++;
			const suffixed = `${stem}_${i}${ext}`;
			usedNames.add(suffixed);
			return suffixed;
		};

		try {
			const downloading = report(t("Downloading"));
			downloading(0, pending.length);
			await runConcurrent(
				pending,
				async ({ loc, panoId }) => {
					const image = await renderLocationImage(
						loc,
						panoId,
						metaMap.get(panoId) ?? null,
						config,
						signal,
					);
					let ok = false;
					if (image) {
						const fileName = uniqueName(image.fileName);
						const res = await fetch(mmaBufUrl(`${session}/${fileName}`), {
							method: "POST",
							body: image.blob,
						});
						ok = res.ok;
						if (ok) singleName = fileName;
					}
					(ok ? saved : failed).push(loc.id);
					done++;
					downloading(done, pending.length);
				},
				{ concurrency: DOWNLOAD_CONCURRENCY, signal },
			);
		} catch (e) {
			await cmd.storeUploadAbort(session).catch(() => {});
			throw e;
		}

		if (saved.length === 0) {
			await cmd.storeUploadAbort(session).catch(() => {});
			return { succeeded: saved.length, failed, output: null };
		}

		const path = await cmd.storeUploadFinish(session);
		const name = saved.length === 1 && singleName ? singleName : `panoramas-${fileTimestamp()}.zip`;
		return { succeeded: saved.length, failed, output: { path, name } };
	},
};
