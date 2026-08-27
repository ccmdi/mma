// Pin to pano id, Run shape: set the LoadAsPanoId flag so the location always loads the
// same panorama, and with `useLatest` move it to the newest official pano in the capture
// timeline first.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import { fetchMetadata, indexPanos } from "@/lib/sv/getMetadata";
import { newestOfficialPano } from "@/lib/sv/panoId";
import { isPinnedToPano } from "@/types";
import { LocationFlag } from "@/bindings.consts";

let useLatest = false;
let force = false;

export function configure(
	cfg: { force?: boolean; config?: { useLatest?: boolean } | null } | null,
): void {
	force = cfg?.force === true;
	useLatest = cfg?.config?.useLatest === true;
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	const out: Update<LocationPatch>[] = [];
	// Without `useLatest` every slot is empty, so this issues no requests at all.
	const index = indexPanos(
		rows.map((r) => (useLatest && (!isPinnedToPano(r) || force) ? (r.panoId ?? "") : "")),
	);
	const fetched = fetchMetadata(index.unique);

	for (let i = 0; i < rows.length; i++) {
		if (mma.aborted()) break;
		const row = rows[i];
		if (isPinnedToPano(row) && !force) continue;
		if (!row.panoId) {
			mma.fail(row.id);
			mma.progress(1);
			continue;
		}
		const flags = row.flags | LocationFlag.LoadAsPanoId;

		if (!useLatest) {
			out.push({ id: row.id, patch: { flags } });
			mma.progress(1);
			continue;
		}

		const slot = index.slot[i];
		if (slot < 0 || !fetched.done[slot]) continue;
		const meta = fetched.metas[slot];
		const latest = meta ? newestOfficialPano(meta.time) : null;
		if (!latest) mma.fail(row.id);
		else out.push({ id: row.id, patch: { panoId: latest.pano, flags } });
		mma.progress(1);
	}
	return out;
}
