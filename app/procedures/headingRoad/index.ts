// Heading along the road, Run shape: "forwards" faces the driving direction, "backwards"
// the opposite.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import { reverseHeading } from "@/lib/geo/geo";

let backwards = false;

export function configure(cfg: { config?: { direction?: string } | null } | null): void {
	backwards = cfg?.config?.direction === "backwards";
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	const out: Update<LocationPatch>[] = [];
	const answers = mma.panos(rows.map((r) => ({ panoId: r.panoId ?? "" })));

	for (let i = 0; i < rows.length; i++) {
		if (mma.aborted()) break;
		const row = rows[i];
		const a = answers[i];
		if (a.state === "skipped") continue;
		if (a.state !== "found") {
			mma.fail(row.id);
			mma.progress(1);
			continue;
		}
		if (a.pano.pov) {
			const dir = a.pano.centerHeading;
			out.push({ id: row.id, patch: { heading: backwards ? reverseHeading(dir) : dir } });
		}
		mma.progress(1);
	}
	return out;
}
