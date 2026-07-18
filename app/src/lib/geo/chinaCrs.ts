/**
 * China coordinate transforms (gcoord-style).
 * Used at the Baidu / Tencent API boundary.
 *
 * Note: Google Maps / opensv in mainland China expose GCJ-02 map coordinates.
 * Prefer `gcj02ToBd09Mc` / `bd09McToGcj02` at that boundary. The WGS84 helpers
 * are for true GPS / overseas inputs only.
 */

export type LngLat = readonly [lng: number, lat: number];

const { sin, cos, sqrt, abs, atan2, PI, log, tan, atan, exp } = Math;

const A = 6378245;
const EE = 0.006693421622965823;
const BAIDU_FACTOR = (PI * 3000.0) / 180.0;

/** Rough China bbox used by GCJ-02 / BD-09 transforms. */
export function isInChinaBbox(lng: number, lat: number): boolean {
	return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x: number, y: number): number {
	let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(abs(x));
	ret += ((20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2) / 3;
	ret += ((20 * sin(y * PI) + 40 * sin((y / 3) * PI)) * 2) / 3;
	ret += ((160 * sin((y / 12) * PI) + 320 * sin((y * PI) / 30)) * 2) / 3;
	return ret;
}

function transformLon(x: number, y: number): number {
	let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(abs(x));
	ret += ((20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2) / 3;
	ret += ((20 * sin(x * PI) + 40 * sin((x / 3) * PI)) * 2) / 3;
	ret += ((150 * sin((x / 12) * PI) + 300 * sin((x / 30) * PI)) * 2) / 3;
	return ret;
}

function delta(lon: number, lat: number): LngLat {
	let dLon = transformLon(lon - 105, lat - 35);
	let dLat = transformLat(lon - 105, lat - 35);
	const radLat = (lat / 180) * PI;
	let magic = sin(radLat);
	magic = 1 - EE * magic * magic;
	const sqrtMagic = sqrt(magic);
	dLon = (dLon * 180) / ((A / sqrtMagic) * cos(radLat) * PI);
	dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
	return [dLon, dLat];
}

export function wgs84ToGcj02(coord: LngLat): LngLat {
	const [lon, lat] = coord;
	if (!isInChinaBbox(lon, lat)) return [lon, lat];
	const d = delta(lon, lat);
	return [lon + d[0], lat + d[1]];
}

export function gcj02ToWgs84(coord: LngLat): LngLat {
	const [lon, lat] = coord;
	if (!isInChinaBbox(lon, lat)) return [lon, lat];
	let wgsLon = lon;
	let wgsLat = lat;
	let temp = wgs84ToGcj02([wgsLon, wgsLat]);
	let dx = temp[0] - lon;
	let dy = temp[1] - lat;
	while (abs(dx) > 1e-6 || abs(dy) > 1e-6) {
		wgsLon -= dx;
		wgsLat -= dy;
		temp = wgs84ToGcj02([wgsLon, wgsLat]);
		dx = temp[0] - lon;
		dy = temp[1] - lat;
	}
	return [wgsLon, wgsLat];
}

export function bd09ToGcj02(coord: LngLat): LngLat {
	const [lon, lat] = coord;
	const x = lon - 0.0065;
	const y = lat - 0.006;
	const z = sqrt(x * x + y * y) - 0.00002 * sin(y * BAIDU_FACTOR);
	const theta = atan2(y, x) - 0.000003 * cos(x * BAIDU_FACTOR);
	return [z * cos(theta), z * sin(theta)];
}

export function gcj02ToBd09(coord: LngLat): LngLat {
	const [lon, lat] = coord;
	const z = sqrt(lon * lon + lat * lat) + 0.00002 * sin(lat * BAIDU_FACTOR);
	const theta = atan2(lat, lon) + 0.000003 * cos(lon * BAIDU_FACTOR);
	return [z * cos(theta) + 0.0065, z * sin(theta) + 0.006];
}

const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const LLBAND = [75, 60, 45, 30, 15, 0];
const MC2LL = [
	[
		1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796,
		-187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653,
		17337981.2,
	],
	[
		-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846,
		-1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375,
		10260144.86,
	],
	[
		-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277,
		7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475,
		6856817.37,
	],
	[
		-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744,
		0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561,
		4482777.06,
	],
	[
		3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901,
		-0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332,
		2555164.4,
	],
	[
		2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032,
		-0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364,
		826088.5,
	],
];
const LL2MC = [
	[
		-0.0015702102444, 111320.7020616939, 1704480524535203, -10338987376042340, 26112667856603880,
		-35149669176653700, 26595700718403920, -10725012454188240, 1800819912950474, 82.5,
	],
	[
		0.0008277824516172526, 111320.7020463578, 647795574.6671607, -4082003173.641316,
		10774905663.51142, -15171875531.51559, 12053065338.62167, -5124939663.577472, 913311935.9512032,
		67.5,
	],
	[
		0.00337398766765, 111320.7020202162, 4481351.045890365, -23393751.19931662, 79682215.47186455,
		-115964993.2797253, 97236711.15602145, -43661946.33752821, 8477230.501135234, 52.5,
	],
	[
		0.00220636496208, 111320.7020209128, 51751.86112841131, 3796837.749470245, 992013.7397791013,
		-1221952.21711287, 1340652.697009075, -620943.6990984312, 144416.9293806241, 37.5,
	],
	[
		-0.0003441963504368392, 111320.7020576856, 278.2353980772752, 2485758.690035394,
		6070.750963243378, 54821.18345352118, 9540.606633304236, -2710.55326746645, 1405.483844121726,
		22.5,
	],
	[
		-0.0003218135878613132, 111320.7020701615, 0.00369383431289, 823725.6402795718, 0.46104986909093,
		2351.343141331292, 1.58060784298199, 8.77738589078284, 0.37238884252424, 7.45,
	],
];

function transformBand(x: number, y: number, factors: number[]): LngLat {
	const cc = abs(y) / factors[9];
	let xt = factors[0] + factors[1] * abs(x);
	let yt =
		factors[2] +
		factors[3] * cc +
		factors[4] * Math.pow(cc, 2) +
		factors[5] * Math.pow(cc, 3) +
		factors[6] * Math.pow(cc, 4) +
		factors[7] * Math.pow(cc, 5) +
		factors[8] * Math.pow(cc, 6);
	xt *= x < 0 ? -1 : 1;
	yt *= y < 0 ? -1 : 1;
	return [xt, yt];
}

export function bd09ToBd09Mc(coord: LngLat): LngLat {
	const [lng, lat] = coord;
	let factors = LL2MC[LL2MC.length - 1];
	for (let i = 0; i < LLBAND.length; i++) {
		if (abs(lat) > LLBAND[i]) {
			factors = LL2MC[i];
			break;
		}
	}
	return transformBand(lng, lat, factors);
}

export function bd09McToBd09(coord: LngLat): LngLat {
	const [x, y] = coord;
	let factors = MC2LL[MC2LL.length - 1];
	for (let i = 0; i < MCBAND.length; i++) {
		if (y >= MCBAND[i]) {
			factors = MC2LL[i];
			break;
		}
	}
	return transformBand(x, y, factors);
}

/** WGS84 (true GPS) → Baidu SV API meters (BD-09MC). Not for Google CN map clicks. */
export function wgs84ToBd09Mc(coord: LngLat): LngLat {
	return bd09ToBd09Mc(gcj02ToBd09(wgs84ToGcj02(coord)));
}

/** Baidu SV API meters (BD-09MC) → WGS84 (true GPS). Not for Google CN map display. */
export function bd09McToWgs84(coord: LngLat): LngLat {
	return gcj02ToWgs84(bd09ToGcj02(bd09McToBd09(coord)));
}

/**
 * Google Maps in mainland China exposes GCJ-02 coordinates.
 * Use these at the Baidu API / coverage boundary when the map host is Google.
 */
export function gcj02ToBd09Mc(coord: LngLat): LngLat {
	return bd09ToBd09Mc(gcj02ToBd09(coord));
}

export function bd09McToGcj02(coord: LngLat): LngLat {
	return bd09ToGcj02(bd09McToBd09(coord));
}

/** Web Mercator helpers (EPSG:3857 meters ↔ WGS84). */
const R2D = 180 / PI;
const D2R = PI / 180;
const A3857 = 6378137.0;
const MAXEXTENT = 20037508.342789244;

export function wgs84ToEpsg3857(lonLat: LngLat): LngLat {
	const adjusted =
		abs(lonLat[0]) <= 180 ? lonLat[0] : lonLat[0] - (lonLat[0] < 0 ? -1 : 1) * 360;
	const xy: [number, number] = [
		A3857 * adjusted * D2R,
		A3857 * log(tan(PI * 0.25 + 0.5 * lonLat[1] * D2R)),
	];
	xy[0] = Math.min(MAXEXTENT, Math.max(-MAXEXTENT, xy[0]));
	xy[1] = Math.min(MAXEXTENT, Math.max(-MAXEXTENT, xy[1]));
	return xy;
}

export function epsg3857ToWgs84(xy: LngLat): LngLat {
	return [(xy[0] * R2D) / A3857, (PI * 0.5 - 2.0 * atan(exp(-xy[1] / A3857))) * R2D];
}
