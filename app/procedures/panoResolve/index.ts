// Pano id from coordinates, Run and Query shapes. A row that already carries a pano id is
// left alone: enrichment fills in what is missing, it does not replace a pano the user
// picked deliberately. A forced run does re-resolve, which is what pinning asks for --
// pinning means "resolve and pin", not "pin whatever is stored".

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { PanoType, type Pano } from "@/types";
import { panosAtCoords, type SearchPreference } from "@/lib/sv/singleImageSearch";

interface RunConfig {
	force?: boolean;
	config?: { radius?: number } | null;
}

let radius = SV_SEARCH_RADIUS;
let force = false;

export function configure(cfg: RunConfig | null): void {
	radius = cfg?.config?.radius ?? SV_SEARCH_RADIUS;
	force = cfg?.force === true;
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	const todo = rows.filter((row) => !row.panoId || force);
	if (todo.length === 0 || mma.aborted()) return [];

	const panos = panosAtCoords(todo, radius);
	// A cancelling run has its requests declined rather than answered; leaving those rows
	// unfinished keeps a cancel from counting them as failures.
	const cancelled = mma.aborted();

	const out: Update<LocationPatch>[] = [];
	todo.forEach((row, i) => {
		const pano = panos[i];
		if (pano) out.push({ id: row.id, patch: { panoId: pano.pano } });
		else if (cancelled) return;
		else mma.fail(row.id);
		mma.progress(1);
	});
	return out;
}

interface AtQuery {
	op?: string;
	points?: { lat: number; lng: number }[];
	radius?: number;
	sources?: PanoType[];
	preference?: SearchPreference;
}

/** Read-only entry: the nearest pano to each of `points`, for callers sampling coverage
 *  rather than patching rows. `{"op":"at","points":[{"lat":..,"lng":..}],"radius":50}`
 *  answers an array aligned to `points`, each entry the whole pano or null. `sources`
 *  narrows which collections are searched. */
export function query(input: AtQuery | null): (Pano | null)[] | { error: string } {
	if (input?.op !== "at") return { error: "panoResolve: unknown query op" };
	const r = typeof input.radius === "number" ? input.radius : SV_SEARCH_RADIUS;
	return panosAtCoords(input.points ?? [], r, input);
}
