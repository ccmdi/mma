/** Ported from lookaround-map `js/util/misc.js` (MIT) — viewer subset. */
import type { LookaroundPano } from "../api";
import { CameraType, CoverageType } from "./enums";

export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
	return Math.abs(a - b) < epsilon;
}

/** Infer camera hardware from projection params (lookaround-map). */
export function inferCameraType(pano: LookaroundPano): number {
	if (pano.coverageType === CoverageType.Trekker) return CameraType.Backpack;

	const cy = pano.cameraMetadata?.[0]?.cy;
	if (cy == null) return CameraType.BigCam;

	if (approxEqual(cy, 0.27488935)) return CameraType.BigCam;
	if (approxEqual(cy, 0.30543262)) {
		if (pano.timestamp != null && pano.timestamp > 1_704_067_200_000) return CameraType.SmallCam;
		if (pano.timezone === "Europe/Zurich") return CameraType.LowCam;
		return CameraType.SmallCam;
	}
	if (approxEqual(cy, 0.36215582)) return CameraType.LowCam;
	return CameraType.BigCam;
}

/**
 * Correct known-bad Apple projection params (lookaround-map Api.#fixProjectionIfNecessary).
 */
export function fixProjectionIfNecessary(pano: LookaroundPano): LookaroundPano {
	const cams = pano.cameraMetadata;
	if (!cams?.length) return pano;

	let next = cams;

	if (
		pano.coverageType === CoverageType.Trekker &&
		cams[0]?.cy != null &&
		!approxEqual(cams[0].cy, 0.305432619)
	) {
		next = cams.map((c, i) => {
			if (i < 4) return { ...c, cy: 0.305432619, fovH: 1.832595715 };
			if (i === 5) return { ...c, fovS: 2.129301687, fovH: 2.268928028 };
			return c;
		});
	} else if (
		pano.coverageType === CoverageType.Car &&
		cams[0]?.cy != null &&
		approxEqual(cams[0].cy, 0.30543262) &&
		pano.timestamp != null &&
		pano.timestamp < 1_704_067_200_000 &&
		pano.timezone !== "Europe/Zurich"
	) {
		next = cams.map((c, i) =>
			i < 4 ? { ...c, cy: 0.27488935, fovH: 1.6144296 } : c,
		);
	} else if (
		pano.coverageType === CoverageType.Car &&
		pano.lat > 29.640968 &&
		pano.lat < 30.207505 &&
		pano.lon > -90.450698 &&
		pano.lon < -89.676162 &&
		pano.timestamp != null &&
		pano.timestamp > 1_706_749_261_000 &&
		pano.timestamp < 1_711_933_261_000
	) {
		next = cams.map((c, i) =>
			i < 4 ? { ...c, cy: 0.305432619, fovH: 1.832595715 } : c,
		);
	}

	return next === cams ? pano : { ...pano, cameraMetadata: next };
}
