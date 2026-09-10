// Street View metadata, Run shape: the host fetches every pano, this maps the answers onto
// the eight metadata `extra` fields.

import type {
	Location,
	Pano,
	Update,
	LocationPatch_Deserialize as LocationPatch,
} from "@/bindings.gen";
import { SVMETA_FIELDS } from "@/lib/sv/constants";

// --- derivation ---

/** How a pano becomes each field this provider produces. */
const DERIVE: Record<(typeof SVMETA_FIELDS)[number], (p: Pano) => unknown> = {
	altitude: (p) => p.altitude,
	countryCode: (p) => p.countryCode,
	cameraType: (p) => p.cameraType,
	panoType: (p) => String(p.panoFrontend),
	// Capture-time driving direction in degrees, per Google.
	drivingDirection: (p) => (p.pov ? p.centerHeading : null),
	uploaderName: (p) => p.uploaderName,
	// `YYYY-MM`; null when the pano carries no date.
	imageDate: (p) => p.imageDate || null,
	coverageDates: (p) => p.coverageDates,
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
	const answers = mma.panos((input.panoIds ?? []).map((panoId) => ({ panoId })));
	return answers.map((a) => (a.state === "found" ? a.pano : null));
}

// --- run ---

export function run(rows: Location[]): Update<LocationPatch>[] {
	const answers = mma.panos(rows.map((r) => ({ panoId: r.panoId ?? "" })));
	const out: Update<LocationPatch>[] = [];
	for (let i = 0; i < rows.length; i++) {
		const a = answers[i];
		if (a.state === "skipped") continue;
		const row = rows[i];
		// notFound on an answered id query is a pano that no longer exists: a failure,
		// or the row would be silently retried on every run forever.
		if (a.state !== "found") mma.fail(row.id);
		else {
			const extra: Record<string, unknown> = {};
			for (const key of SVMETA_FIELDS) {
				if (fields === null || fields.has(key)) extra[key] = DERIVE[key](a.pano);
			}
			if (Object.keys(extra).length > 0) out.push({ id: row.id, patch: { extra } });
		}
		mma.progress(1);
	}
	return out;
}
