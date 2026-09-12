// Pano id from coordinates, Run and Query shapes. A row that already carries a pano id is
// left alone: enrichment fills in what is missing, it does not replace a pano the user
// picked deliberately. A forced run does re-resolve, which is what pinning asks for --
// pinning means "resolve and pin", not "pin whatever is stored".

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import type { Pano } from "@/bindings.gen";
import type { PanoType, RankingStrategy } from "@/bindings.consts";

interface RunConfig {
	force?: boolean;
	config?: { radius?: number; sources?: PanoType[] } | null;
}

let radius = SV_SEARCH_RADIUS;
let force = false;
let sources: PanoType[] | undefined;

export function configure(cfg: RunConfig | null): void {
	radius = cfg?.config?.radius ?? SV_SEARCH_RADIUS;
	force = cfg?.force === true;
	sources = cfg?.config?.sources ?? undefined;
}

export function run(rows: Location[]): Update<LocationPatch>[] {
	const todo = rows.filter((row) => force || !row.panoId);
	if (todo.length === 0 || mma.aborted()) return [];

	const answers = mma.panos(
		todo.map((row) => ({ lat: row.lat, lng: row.lng, radius, ...(sources ? { sources } : {}) })),
	);

	const out: Update<LocationPatch>[] = [];
	todo.forEach((row, i) => {
		const a = answers[i];
		if (a.state === "found") out.push({ id: row.id, patch: { panoId: a.pano.id } });
		// A skipped answer is a cancelled run's declined request: neither a result nor
		// a failure, so the row stays untouched.
		else if (a.state === "skipped") return;
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
	preference?: RankingStrategy;
}

/** Read-only entry: the nearest pano to each of `points`, for callers sampling coverage
 *  rather than patching rows. `{"op":"at","points":[{"lat":..,"lng":..}],"radius":50}`
 *  answers an array aligned to `points`, each entry the whole pano or null. `sources`
 *  narrows which collections are searched. */
export function query(input: AtQuery | null): (Pano | null)[] | { error: string } {
	if (input?.op !== "at") return { error: "panoResolve: unknown query op" };
	const r = typeof input.radius === "number" ? input.radius : SV_SEARCH_RADIUS;
	const queries = (input.points ?? []).map((p) => ({
		lat: p.lat,
		lng: p.lng,
		radius: r,
		sources: input.sources,
		preference: input.preference,
	}));
	return mma.panos(queries).map((a) => (a.state === "found" ? a.pano : null));
}
