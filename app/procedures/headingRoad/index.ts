// Heading along the road, Run shape: "forwards" faces the driving direction, "backwards"
// the opposite.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import { reverseHeading } from "@/lib/geo/geo";
import { centerHeading, fetchMetadata, indexPanos } from "@/lib/sv/getMetadata";

let backwards = false;

export function configure(cfg: { config?: { direction?: string } | null } | null): void {
	backwards = cfg?.config?.direction === "backwards";
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	const out: Update<LocationPatch>[] = [];
	const index = indexPanos(rows.map((r) => r.panoId ?? ""));
	const fetched = fetchMetadata(index.unique);

	for (let i = 0; i < rows.length; i++) {
		if (mma.aborted()) break;
		const row = rows[i];
		const slot = index.slot[i];
		// No pano id means no driving direction to read.
		if (slot < 0) {
			mma.fail(row.id);
			mma.progress(1);
			continue;
		}
		if (!fetched.done[slot]) continue;
		const meta = fetched.metas[slot];
		if (fetched.failed[slot] || !meta) {
			mma.fail(row.id);
			mma.progress(1);
			continue;
		}
		if (meta.pov) {
			const dir = centerHeading(meta);
			out.push({ id: row.id, patch: { heading: backwards ? reverseHeading(dir) : dir } });
		}
		mma.progress(1);
	}
	return out;
}
