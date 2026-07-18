/** Ported from lookaround-map `js/enums.js` (MIT) — viewer-facing subset. */

export const CoverageType = Object.freeze({
	Car: 2,
	Trekker: 3,
});

export const CameraType = Object.freeze({
	BigCam: 0,
	SmallCam: 1,
	LowCam: 2,
	Backpack: 3,
});

export const Face = Object.freeze({
	Back: 0,
	Left: 1,
	Front: 2,
	Right: 3,
	Top: 4,
	Bottom: 5,
});

export const InitialOrientation = Object.freeze({
	North: 0,
	Road: 1,
});

export const ImageFormat = Object.freeze({
	JPEG: 0,
	HEIC: 1,
});

export const AdditionalMetadata = Object.freeze({
	Orientation: "ori",
	CameraMetadata: "cam",
	Elevation: "ele",
	TimeZone: "tz",
});

export type InitialOrientationValue =
	(typeof InitialOrientation)[keyof typeof InitialOrientation];
export type ImageFormatValue = (typeof ImageFormat)[keyof typeof ImageFormat];
