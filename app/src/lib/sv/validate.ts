import { hasLoadAsPanoId } from "@/types";
import type { Location } from "@/bindings.gen";
import { ValidationState } from "@/store/selections";
import { fetchSvMetadata } from "./svMeta";
import { isOfficialPano } from "./panoId";
import { getPanoAtCoords, isUnofficial } from "./lookup";
import { runConcurrent } from "@/lib/util/concurrent";

const GOOD_CAM_TYPES = new Set(["gen4", "gen2"]);

export async function validateOne(loc: Location, signal?: AbortSignal): Promise<ValidationState> {
	signal?.throwIfAborted();

	const n = hasLoadAsPanoId(loc);
	let r: google.maps.StreetViewResolvedPanoramaData | null = null;
	let i: google.maps.StreetViewResolvedPanoramaData | null = null;
	let a = ValidationState.Ok;

	// Fetch by pano ID if stored
	if (loc.panoId != null) {
		[r] = await fetchSvMetadata([loc.panoId]).catch(() => [null]);
	}

	if (n) {
		// LoadAsPanoId: if pano lookup failed, mark broke, fall back to coord
		if (r == null) {
			if (loc.panoId != null) a = ValidationState.PanoIdBroke;
			const coordPano = await getPanoAtCoords(loc.lat, loc.lng);
			if (coordPano) [r] = await fetchSvMetadata([coordPano]).catch(() => [null]);
		}
	} else {
		// No LoadAsPanoId: do coord lookup
		const coordPano = await getPanoAtCoords(loc.lat, loc.lng);
		if (coordPano) [i] = await fetchSvMetadata([coordPano]).catch(() => [null]);
	}

	r ??= i;

	if (r == null) return ValidationState.NotFound;
	if (isUnofficial(r)) return ValidationState.Unofficial;

	// Badcam check (only when !n)
	if (!n && r.extra?.cameraType === "badcam" && r.time?.length) {
		const timePanoIds = r.time.map((t) => t.pano);
		const timeResults = await fetchSvMetadata(timePanoIds).catch(() => []);
		if (timeResults.some((t) => t && GOOD_CAM_TYPES.has(t.extra?.cameraType ?? ""))) {
			return ValidationState.GoodcamAvailable;
		}
	}

	// Coord update (only when !n, since i is only set then)
	if (i != null && i.location.pano !== r.location.pano) {
		return ValidationState.UpdateApplied;
	}

	// Timeline check
	const time = r.time ?? [];
	const o = time.filter((t) => isOfficialPano(t.pano));
	const s = o.findIndex((t) => t.pano === loc.panoId);
	if (s !== -1 && s !== o.length - 1) {
		return n ? ValidationState.UpdateAvailable : ValidationState.UpdateApplied;
	}

	return a;
}

export interface ValidationProgress {
	progress: number;
	results: Map<ValidationState, Location[]>;
}

export async function validateLocations(
	locations: Location[],
	opts: {
		signal?: AbortSignal;
		onProgress?: (p: ValidationProgress) => void;
	} = {},
): Promise<Map<ValidationState, Location[]>> {
	const { signal, onProgress } = opts;
	const results = new Map<ValidationState, Location[]>();
	let completed = 0;
	let lastUpdate = 0;

	await runConcurrent(
		locations,
		async (loc) => {
			try {
				const state = await validateOne(loc, signal);
				const list = results.get(state);
				if (list) list.push(loc);
				else results.set(state, [loc]);
			} finally {
				completed++;
				const now = Date.now();
				if (now - lastUpdate > 16) {
					lastUpdate = now;
					onProgress?.({ progress: completed / locations.length, results });
				}
			}
		},
		{ concurrency: 100, signal },
	);

	onProgress?.({ progress: 1, results });
	return results;
}
