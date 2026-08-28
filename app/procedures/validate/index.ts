// Street View coverage validation, Run shape. Port of `validateOne` in
// app/src/lib/sv/validate.ts: metadata for the stored pano, a coordinate lookup as
// fallback (or as the comparison when the row is not pinned), then the unofficial,
// badcam and timeline checks. It answers with a ValidationState per row and writes
// nothing -- the run declares the collect sink.
//
// The batch moves through four phases, each issuing every request it needs in one
// `mma.fetchMany`, so a batch of any size costs a fixed number of rounds.

import type { Location, Update } from "@/bindings.gen";
import {
	detectCameraType,
	fetchMetadata,
	indexPanos,
	type FetchedMetadata,
} from "@/lib/sv/getMetadata";
import { isOfficialPano, isUnofficial, newestOfficialPano } from "@/lib/sv/panoId";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { panosAtCoords } from "@/lib/sv/singleImageSearch";
import type { Pano } from "@/types";
import { LocationFlag, ValidationState } from "@/bindings.consts";

interface RunConfig {
	config?: { radius?: number } | null;
}

let radius = SV_SEARCH_RADIUS;

export function configure(cfg: RunConfig | null): void {
	radius = cfg?.config?.radius ?? SV_SEARCH_RADIUS;
}

/** A capture worth keeping: anything else is what the badcam check is looking past. */
function isGoodCam(m: Pano): boolean {
	const cam = detectCameraType(m);
	return cam === "gen4" || cam === "gen2";
}

/** Metadata at one slot, or null when the pano is unknown or its request failed -- the
 *  two cases the JS `.catch(() => [null])` collapsed together. */
function metaAt(f: FetchedMetadata, slot: number): Pano | null {
	return slot >= 0 && f.done[slot] && !f.failed[slot] ? f.metas[slot] : null;
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

	const stored = indexPanos(rows.map((r) => r.panoId ?? ""));
	const storedMeta = fetchMetadata(stored.unique);
	if (mma.aborted()) return [];

	const items: RowState[] = rows.map((row, i) => ({
		row,
		pinned: (row.flags & LocationFlag.LoadAsPanoId) !== 0,
		data: metaAt(storedMeta, stored.slot[i]),
		coordData: null,
		entries: [],
		state: ValidationState.Ok,
		settled: false,
	}));

	// A pinned row keeps its stored pano when it resolves; every other row needs the
	// coordinate, as a fallback when pinned and as the comparison when not.
	const needCoord = items.filter((it) => !it.pinned || it.data === null);
	// The search answers their metadata too, so there is no second lookup.
	const coordPanos =
		needCoord.length > 0
			? panosAtCoords(
					needCoord.map((it) => it.row),
					radius,
				)
			: [];
	if (mma.aborted()) return [];

	needCoord.forEach((it, i) => {
		const m = coordPanos[i];
		if (!it.pinned) {
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
			if (!it.pinned && detectCameraType(it.data) === "badcam") badcam.push(it);
		}
	}

	const cams = indexPanos(badcam.flatMap((it) => it.entries.map((e) => e.pano)));
	const camMeta = fetchMetadata(cams.unique);
	if (mma.aborted()) return [];

	let at = 0;
	for (const it of badcam) {
		let better = false;
		for (let k = 0; k < it.entries.length; k++) {
			const m = metaAt(camMeta, cams.slot[at++]);
			if (m && isGoodCam(m)) better = true;
		}
		if (better) {
			it.state = ValidationState.GoodcamAvailable;
			it.settled = true;
		}
	}

	for (const it of items) {
		if (it.settled || it.data === null) continue;
		// Only set when the row is not pinned, so this is the "the coordinate moved" case.
		if (it.coordData !== null && it.coordData.pano !== it.data.pano) {
			it.state = ValidationState.UpdateApplied;
			continue;
		}
		// The stored pano is a known official capture, but not the newest one.
		const storedIsOfficial = it.entries.some(
			(e) => e.pano === it.row.panoId && isOfficialPano(e.pano),
		);
		if (storedIsOfficial && newestOfficialPano(it.entries)?.pano !== it.row.panoId) {
			it.state = it.pinned ? ValidationState.UpdateAvailable : ValidationState.UpdateApplied;
		}
	}

	mma.progress(items.length);
	return items.map((it) => ({ id: it.row.id, patch: it.state }));
}
