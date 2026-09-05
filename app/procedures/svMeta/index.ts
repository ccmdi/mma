// Street View metadata, Run shape: one GetMetadata RPC per <=200 unique panos, then the
// eight metadata `extra` fields. The wire format itself is `@/lib/sv/getMetadata`.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import {
	centerHeading,
	coverageDates,
	detectCameraType,
	fetchMetadata,
	imageDateOf,
	indexPanos,
	SVMETA_FIELDS,
} from "@/lib/sv/getMetadata";
import type { Pano } from "@/types";

// --- derivation ---

/** How a pano becomes each field this provider produces. */
const DERIVE: Record<(typeof SVMETA_FIELDS)[number], (p: Pano) => unknown> = {
	altitude: (p) => p.altitude,
	countryCode: (p) => p.countryCode,
	cameraType: (p) => detectCameraType(p),
	panoType: (p) => (p.panoFrontend == null ? null : String(p.panoFrontend)),
	// Capture-time driving direction in degrees, per Google.
	drivingDirection: (p) => (p.pov ? centerHeading(p) : null),
	uploaderName: (p) => p.uploaderName,
	// `YYYY-MM`; null when the pano carries no date.
	imageDate: (p) => imageDateOf(p) || null,
	coverageDates: (p) => coverageDates(p),
};

// --- configuration ---

/** The `extra` keys the run wants; null until configured, meaning no filtering. */
let fields: Set<string> | null = null;

export function configure(cfg: { fields?: string[] } | null): void {
	fields = Array.isArray(cfg?.fields) ? new Set(cfg.fields) : null;
}

// --- query ---

/** Read-only entry: metadata for arbitrary panos, without a run.
 *  `{"op":"metadata","panoIds":[..]}` answers with an array aligned to `panoIds`. */
export function query(input: { op?: string; panoIds?: string[] }) {
	if (input?.op !== "metadata") return { error: "svMeta: unknown query op" };
	const index = indexPanos(input.panoIds ?? []);
	const fetched = fetchMetadata(index.unique);
	const answers = index.unique.map((_, k) => {
		const meta = fetched.metas[k];
		return fetched.done[k] && !fetched.failed[k] ? meta : null;
	});
	return index.slot.map((slot) => (slot >= 0 ? answers[slot] : null));
}

// --- run ---

export function run(rows: Location[]): Update<LocationPatch>[] {
	const index = indexPanos(rows.map((r) => r.panoId ?? ""));
	const rowsFor: number[][] = index.unique.map(() => []);
	index.slot.forEach((slot, i) => rowsFor[slot].push(i));

	const fetched = fetchMetadata(index.unique);
	const out: Update<LocationPatch>[] = [];
	for (let k = 0; k < index.unique.length; k++) {
		if (!fetched.done[k]) continue;
		const meta = fetched.metas[k];
		for (const i of rowsFor[k]) {
			const row = rows[i];
			// A null answer on a completed request is a pano that no longer exists: a
			// failure, or the row would be silently retried on every run forever.
			if (fetched.failed[k] || !meta) mma.fail(row.id);
			else {
				const extra: Record<string, unknown> = {};
				for (const key of SVMETA_FIELDS) {
					if (fields === null || fields.has(key)) extra[key] = DERIVE[key](meta);
				}
				if (Object.keys(extra).length > 0) out.push({ id: row.id, patch: { extra } });
			}
			mma.progress(1);
		}
	}
	return out;
}
