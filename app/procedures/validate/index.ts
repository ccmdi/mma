// Street View coverage validation. Run shape: metadata for the stored pano, a coordinate
// lookup at that pano's position (the row's, when it does not resolve) as comparison and
// fallback, then the unofficial, badcam and timeline checks. It answers each row with the
// ValidationFlags that apply and whether it is pinned, and writes
// nothing -- the run declares the collect sink.
//
// The batch moves through three phases, each issuing every lookup it needs in one
// `mma.panos`, so a batch of any size costs a fixed number of rounds.

import type { ProcedureConfig } from "@/bindings.gen";
import type { Location, Pano, PanoAnswer } from "@/bindings.gen";
import type { ValidationAnswer } from "@/lib/sv/validationCategories";
import { isPinned } from "@/types";
import { CapturePick, ValidationFlag } from "@/bindings.consts";
import type { ValidateConfig } from "@/lib/sv/providers";
import {
	SV_SEARCH_RADIUS,
	capturedAfter,
	isOfficialPano,
	isUnofficial,
	pickCapture,
} from "@/lib/sv/rules";

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
	/** The pano the row shows: its stored pano, or the default when that does not load. */
	data: Pano | null;
	coordData: Pano | null;
	pinned: boolean;
	flags: number;
}

/** The official capture `p` is not the newest in its own timeline. */
function behindOwnTimeline(p: Pano): boolean {
	return isOfficialPano(p.id) && pickCapture(p.time, CapturePick.Newest)?.panoId !== p.id;
}

export function run(
	rows: Location[],
	cfg: ProcedureConfig<Partial<ValidateConfig>>,
): ({ id: number } & ValidationAnswer)[] {
	const radius = cfg.config?.radius ?? SV_SEARCH_RADIUS;
	if (rows.length === 0 || mma.aborted()) return [];

	const storedMeta = mma.panos(rows.map((r) => ({ panoId: r.panoId ?? "" })));
	if (mma.aborted()) return [];
	// The search answers the default's metadata too, so there is no second lookup.
	const coordMeta = mma.panos(
		rows.map((r, i) => {
			const at = metaOf(storedMeta[i]) ?? r;
			return { lat: at.lat, lng: at.lng, radius };
		}),
	);
	if (mma.aborted()) return [];

	const items: RowState[] = rows.map((row, i) => {
		const stored = metaOf(storedMeta[i]);
		const coordData = metaOf(coordMeta[i]);
		const pinned = isPinned(row);
		let flags: number = ValidationFlag.None;
		if (pinned && stored === null && coordData !== null) flags |= ValidationFlag.PanoIdBroke;
		if (pinned && stored !== null && coordData !== null && stored.id !== coordData.id) {
			flags |= ValidationFlag.OffDefault;
		}
		if (coordData !== null && !isUnofficial(coordData) && behindOwnTimeline(coordData)) {
			flags |= ValidationFlag.DefaultStale;
		}
		return { row, data: stored ?? coordData, coordData, pinned, flags };
	});

	const checked: RowState[] = [];
	for (const it of items) {
		if (it.data === null) it.flags = ValidationFlag.NotFound;
		else if (isUnofficial(it.data)) it.flags |= ValidationFlag.Unofficial;
		else checked.push(it);
	}
	const badcam = checked.filter((it) => it.data!.cameraType === "badcam");

	const camMeta = mma.panos(
		badcam.flatMap((it) => it.data!.time.map((e) => ({ panoId: e.panoId }))),
	);
	if (mma.aborted()) return [];

	let at = 0;
	for (const it of badcam) {
		let better = false;
		for (let k = 0; k < it.data!.time.length; k++) {
			const m = metaOf(camMeta[at++]);
			if (m && isGoodCam(m)) better = true;
		}
		if (better) it.flags |= ValidationFlag.GoodcamAvailable;
	}

	for (const it of checked) {
		const data = it.data!;
		// Only newer official coverage counts: the nearest hit can be a photosphere, an
		// adjacent road, or a default lagging behind the stored pano.
		const defaultNewer =
			it.coordData !== null &&
			!isUnofficial(it.coordData) &&
			it.coordData.id !== data.id &&
			capturedAfter(it.coordData, data);
		const storedBehind = data.id === it.row.panoId && behindOwnTimeline(data);
		if (defaultNewer || storedBehind) it.flags |= ValidationFlag.Newer;
	}

	return items.map((it) => ({ id: it.row.id, flags: it.flags, pinned: it.pinned }));
}
