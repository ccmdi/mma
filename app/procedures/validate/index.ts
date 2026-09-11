// Street View coverage validation. Run shape: metadata for the stored pano, a coordinate
// lookup as comparison and fallback, then the unofficial, badcam and timeline checks. It
// answers with a ValidationState per row and writes nothing -- the run declares the collect sink.
//
// The batch moves through four phases, each issuing every lookup it needs in one
// `mma.panos`, so a batch of any size costs a fixed number of rounds.

import type { Location, Pano, PanoAnswer, Update } from "@/bindings.gen";
import type { ValidateConfig } from "@/lib/sv/validate";
import { isOfficialPano, isUnofficial, newestOfficialPano } from "@/lib/sv/panoId";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { isPinned } from "@/types";
import { ValidationState } from "@/bindings.consts";

interface RunConfig {
	config?: Partial<ValidateConfig> | null;
}

let radius = SV_SEARCH_RADIUS;
let checkPinned = true;

export function configure(cfg: RunConfig | null): void {
	radius = cfg?.config?.radius ?? SV_SEARCH_RADIUS;
	checkPinned = cfg?.config?.checkPinned ?? true;
}

/** A capture worth keeping: anything else is what the badcam check is looking past. */
function isGoodCam(m: Pano): boolean {
	return m.cameraType === "gen4" || m.cameraType === "gen2";
}

/** The resolved pano, or null when it is unknown or its request failed. */
function metaOf(a: PanoAnswer | undefined): Pano | null {
	return a?.state === "found" ? a.pano : null;
}

interface RowState {
	row: Location;
	pinned: boolean;
	data: Pano | null;
	coordData: Pano | null;
	entries: Pano["time"];
	state: ValidationState;
	settled: boolean;
}

export function run(rows: Location[]): Update<ValidationState>[] {
	if (rows.length === 0 || mma.aborted()) return [];

	const storedMeta = mma.panos(rows.map((r) => ({ panoId: r.panoId ?? "" })));
	if (mma.aborted()) return [];

	const items: RowState[] = rows.map((row, i) => ({
		row,
		pinned: isPinned(row),
		data: metaOf(storedMeta[i]),
		coordData: null,
		entries: [],
		state: ValidationState.Ok,
		settled: false,
	}));

	// The coordinate is the comparison (pinned rows included under checkPinned) and the
	// fallback for a pinned row whose pano broke.
	const needCoord = items.filter((it) => checkPinned || !it.pinned || it.data === null);
	// The search answers their metadata too, so there is no second lookup.
	const coordPanos = mma
		.panos(needCoord.map((it) => ({ lat: it.row.lat, lng: it.row.lng, radius })))
		.map(metaOf);
	if (mma.aborted()) return [];

	needCoord.forEach((it, i) => {
		const m = coordPanos[i];
		if (!it.pinned || it.data !== null) {
			it.coordData = m;
			return;
		}
		// Pinned to a pano: a broken one is worth reporting, but the coordinate still
		// decides whether there is coverage at all.
		if (it.row.panoId) it.state = ValidationState.PanoIdBroke;
		it.data = m;
	});

	const badcam: RowState[] = [];
	for (const it of items) {
		if (it.data === null) it.data = it.coordData;
		if (it.data === null) {
			it.state = ValidationState.NotFound;
			it.settled = true;
		} else if (isUnofficial(it.data)) {
			it.state = ValidationState.Unofficial;
			it.settled = true;
		} else {
			it.entries = it.data.time;
			if ((checkPinned || !it.pinned) && it.data.cameraType === "badcam") badcam.push(it);
		}
	}

	const camMeta = mma.panos(badcam.flatMap((it) => it.entries.map((e) => ({ panoId: e.panoId }))));
	if (mma.aborted()) return [];

	let at = 0;
	for (const it of badcam) {
		let better = false;
		for (let k = 0; k < it.entries.length; k++) {
			const m = metaOf(camMeta[at++]);
			if (m && isGoodCam(m)) better = true;
		}
		if (better) {
			it.state = ValidationState.GoodcamAvailable;
			it.settled = true;
		}
	}

	for (const it of items) {
		if (it.settled || it.data === null) continue;
		if (it.coordData !== null && it.coordData.id !== it.data.id) {
			it.state = it.pinned ? ValidationState.UpdateAvailable : ValidationState.UpdateApplied;
			continue;
		}
		// The stored pano is a known official capture, but not the newest one.
		const storedIsOfficial = it.entries.some(
			(e) => e.panoId === it.row.panoId && isOfficialPano(e.panoId),
		);
		if (storedIsOfficial && newestOfficialPano(it.entries)?.panoId !== it.row.panoId) {
			it.state = it.pinned ? ValidationState.UpdateAvailable : ValidationState.UpdateApplied;
		}
	}

	return items.map((it) => ({ id: it.row.id, patch: it.state }));
}
