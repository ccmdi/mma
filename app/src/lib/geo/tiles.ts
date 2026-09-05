/* eslint-disable @typescript-eslint/no-explicit-any */
// Protobuf tile URL builder
// Constructs Google Maps Vector Tile URLs with protobuf-encoded parameters.

import { resolveSvColorHex, hexToHsl, hslToHex } from "@/lib/util/color";
import { TILE_SIZE } from "@/lib/geo/mercator";

// --- Protobuf encoding primitives ---

function pbEscape(s: string): string {
	return s.replace(/[!*]/g, (c) => `*${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function pbMsg(
	field: number,
	serializer: (arr: any[], out: string[]) => void,
	arr: any[],
	out: string[],
): string[] {
	const start = out.length;
	out.push("");
	serializer(arr, out);
	const count = out.length - start - 1;
	if (count === 0) out.pop();
	else out[start] = `${field}m${count}`;
	return out;
}

function pbSerialize(serializer: (arr: any[], out: string[]) => void, arr: any[]): string {
	const out: string[] = [];
	serializer(arr, out);
	return `!${out.join("!")}`;
}

// --- Enums ---

export const CoverageType = { OFFICIAL: 2, UNKNOWN: 3, USER_UPLOADED: 10 } as const;
export const ImageFormat = { Y: 1, Z: 2 } as const;
export const LayerType = {
	ROADMAP: 0,
	SATELLITE: 1,
	STREETVIEW: 2,
	UNKNOWN: 3,
	TERRAIN: 4,
	TERRAIN_RELIEF: 5,
	TERRAIN_CONTOURS: 6,
} as const;
export const StyleType = {
	NORMAL: 1,
	HIGH_DPI: 2,
	NO_LABELS: 3,
	SATELLITE: 4,
	BIG_ROAD_ICONS: 13,
	LABELS_ONLY: 15,
	WHITE_ROADS: 21,
	STYLERS: 26,
	SMARTMAPS: 37,
	STREET_VIEW_DARK: 40,
	TERRAIN_ROADS: 63,
	NO_LAND_USE: 64,
	TERRAIN: 67,
	BASEMAP: 68,
} as const;
export const LegacyFlag = { LEGACY: 18, CURRENT: 1105 } as const;

// --- Protobuf message factory ---
// Each message is a compact schema of field descriptors. The factory stamps
// getters/setters onto a class prototype and builds a matching serializer.
// Wire types: i=int, e=enum, f=float, b=bool, s=string, m=nested, rm=repeated nested, re=repeated enum sub-msg.

class PbMsg {
	_a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	toArray() {
		return this._a;
	}
}

type W = "i" | "e" | "f" | "b" | "s";
type F =
	| { n: string; i: number; w: W; d?: any }
	| { n: string; i: number; w: "m"; s: F[]; init?: true }
	| { n: string; i: number; w: "rm"; s: F[] }
	| { n: string; i: number; w: "re" };
type Def = { C: new (init?: any) => PbMsg; ser: (a: any[], o: string[]) => void };

const reEnumSer = (arr: any[], out: string[]) =>
	arr.forEach((v: any) => {
		if (v != null) out.push(`1e${v}`);
	});

const _defs = new WeakMap<F[], Def>();
function pb(fields: F[], Cls?: new (init?: any) => PbMsg): Def {
	let d = _defs.get(fields);
	if (d) return d;
	const M = Cls ?? class extends PbMsg {};
	d = { C: M, ser: null! };
	_defs.set(fields, d);
	const proto: any = M.prototype;
	for (const f of fields) {
		const desc: PropertyDescriptor = { enumerable: true, configurable: true };
		const { i } = f;
		if (f.w === "m") {
			const ch = pb(f.s);
			desc.get = f.init
				? function (this: PbMsg) {
						return new ch.C((this._a[i] ??= []));
					}
				: function (this: PbMsg) {
						return new ch.C(this._a[i]);
					};
			desc.set = function (this: PbMsg, v: any) {
				this._a[i] = v == null ? [] : (v instanceof PbMsg ? v : new ch.C(v)).toArray();
			};
		} else if (f.w === "rm") {
			const ch = pb(f.s);
			desc.get = function (this: PbMsg) {
				return (this._a[i] ??= []).map((e: any) => new ch.C(e));
			};
			desc.set = function (this: PbMsg, v: any) {
				this._a[i] = (v ?? []).map((e: any) => (e instanceof PbMsg ? e : new ch.C(e)).toArray());
			};
		} else if (f.w === "b") {
			desc.get = function (this: PbMsg) {
				return this._a[i] ?? false;
			};
			desc.set = function (this: PbMsg, v: any) {
				this._a[i] = v;
			};
		} else if (f.w === "re") {
			desc.get = function (this: PbMsg) {
				return this._a[i] ?? [];
			};
			desc.set = function (this: PbMsg, v: any) {
				this._a[i] = v;
			};
		} else {
			desc.get =
				"d" in f
					? function (this: PbMsg) {
							return this._a[i] ?? f.d;
						}
					: function (this: PbMsg) {
							return this._a[i];
						};
			desc.set = function (this: PbMsg, v: any) {
				this._a[i] = v;
			};
		}
		Object.defineProperty(proto, f.n, desc);
	}
	d.ser = (a, o) => {
		for (const f of fields) {
			const { i } = f;
			const p = i + 1;
			switch (f.w) {
				case "i":
					if (a[i] != null) o.push(`${p}i${a[i]}`);
					break;
				case "e":
					if (a[i] != null) o.push(`${p}e${a[i]}`);
					break;
				case "f":
					if (a[i] != null) o.push(`${p}f${a[i]}`);
					break;
				case "b":
					if (a[i]) o.push(`${p}b1`);
					break;
				case "s":
					if (a[i] != null) o.push(`${p}s${pbEscape(a[i])}`);
					break;
				case "m":
					if (a[i] != null) pbMsg(p, pb(f.s).ser, a[i], o);
					break;
				case "rm":
					a[i]?.forEach((v: any) => pbMsg(p, pb(f.s).ser, v, o));
					break;
				case "re":
					if (a[i]?.length) pbMsg(p, reEnumSer, a[i], o);
					break;
			}
		}
	};
	return d;
}

// --- Message schemas (field order = serialization order) ---

const kvS: F[] = [
	{ n: "key", i: 0, w: "s", d: "" },
	{ n: "value", i: 1, w: "s", d: "" },
];
const renderStrategyS: F[] = [
	{ n: "frontend", i: 0, w: "e", d: 0 },
	{ n: "tiled", i: 1, w: "b" },
	{ n: "imageFormat", i: 2, w: "e", d: 0 },
];
const coverageStrategiesS: F[] = [
	{ n: "strategies", i: 0, w: "rm", s: renderStrategyS },
	{ n: "unknownBool", i: 1, w: "b" },
	{ n: "unknownBool2", i: 3, w: "b" },
];
const svlConfigS: F[] = [
	{ n: "showUserContent", i: 0, w: "b" },
	{ n: "useDetailedLines", i: 1, w: "b" },
];
const tileCoordS: F[] = [
	{ n: "zoom", i: 0, w: "i", d: 0 },
	{ n: "x", i: 1, w: "i", d: 0 },
	{ n: "y", i: 2, w: "i", d: 0 },
	{ n: "size", i: 3, w: "i", d: 0 },
];
const tileQueryS: F[] = [{ n: "tile", i: 0, w: "m", s: tileCoordS }];
const layerS: F[] = [
	{ n: "type", i: 0, w: "e", d: 0 },
	{ n: "layerName", i: 1, w: "s", d: "" },
	{ n: "layerVersion", i: 2, w: "i" },
	{ n: "layerOptions", i: 3, w: "rm", s: kvS },
];
const stylerS: F[] = [
	{ n: "type", i: 0, w: "e", d: 0 },
	{ n: "params", i: 1, w: "rm", s: kvS },
];
// Serialization order differs from index order: outputFormat (i=3) comes after styles (i=11)
const optionsS: F[] = [
	{ n: "language", i: 1, w: "s", d: "" },
	{ n: "region", i: 2, w: "s", d: "" },
	{ n: "unknownStyleFlag", i: 4, w: "e", d: 0 },
	{ n: "styles", i: 11, w: "rm", s: stylerS },
	{ n: "outputFormat", i: 3, w: "e", d: 0 },
];
const renderOptionsS: F[] = [
	{ n: "rasterType", i: 0, w: "e", d: 0 },
	{ n: "scale", i: 4, w: "f", d: 0 },
];
const tileConfigS: F[] = [
	{ n: "query", i: 0, w: "m", s: tileQueryS },
	{ n: "layers", i: 1, w: "rm", s: layerS },
	{ n: "options", i: 2, w: "m", s: optionsS, init: true },
	{ n: "outputFormat", i: 3, w: "i", d: 0 },
	{ n: "renderOptions", i: 4, w: "m", s: renderOptionsS, init: true },
	{ n: "tileHash", i: 22, w: "i" },
	{ n: "footerStyleTypes", i: 25, w: "re" },
];

// --- Exported message classes (declare for TS visibility) ---

export class CoverageStrategies extends PbMsg {
	declare strategies: any[];
	declare unknownBool: boolean;
	declare unknownBool2: boolean;
}
export class Styler extends PbMsg {
	declare type: number;
	declare params: any[];
}
export class TileConfig extends PbMsg {
	declare query: any;
	declare layers: any[];
	declare options: any;
	declare outputFormat: number;
	declare renderOptions: any;
	declare tileHash: any;
	declare footerStyleTypes: number[];
}

const csDef = pb(coverageStrategiesS, CoverageStrategies);
const svlDef = pb(svlConfigS);
pb(stylerS, Styler);
const tcDef = pb(tileConfigS, TileConfig);
const RenderStrategy = pb(renderStrategyS).C;
const SvlConfig = svlDef.C;

export function encodeCoverageStrategies(cs: CoverageStrategies): string {
	return pbSerialize(csDef.ser, cs.toArray());
}

export function encodeSvlConfig(cfg: PbMsg): string {
	return pbSerialize(svlDef.ser, cfg.toArray());
}

export function serializeTileUrl(cfg: TileConfig): string {
	return pbSerialize(tcDef.ser, cfg.toArray());
}

// --- Google Maps style serialization (du function from map_editor) ---

const featureTypeMap: Record<string, number> = {
	administrative: 1,
	"administrative.country": 17,
	"administrative.province": 18,
	"administrative.locality": 19,
	"administrative.neighborhood": 20,
	"administrative.land_parcel": 21,
	poi: 2,
	"poi.business": 33,
	"poi.government": 34,
	"poi.school": 35,
	"poi.medical": 36,
	"poi.attraction": 37,
	"poi.place_of_worship": 38,
	"poi.sports_complex": 39,
	"poi.park": 40,
	road: 3,
	"road.highway": 49,
	"road.highway.controlled_access": 785,
	"road.arterial": 50,
	"road.local": 51,
	transit: 4,
	"transit.line": 65,
	"transit.station": 66,
	landscape: 5,
	"landscape.man_made": 81,
	"landscape.natural": 82,
	"landscape.natural.landcover": 1313,
	"landscape.natural.terrain": 1314,
	water: 6,
};

const elementTypeMap: Record<string, string> = {
	geometry: "g",
	"geometry.fill": "g.f",
	"geometry.stroke": "g.s",
	labels: "l",
	"labels.icon": "l.i",
	"labels.text": "l.t",
	"labels.text.fill": "l.t.f",
	"labels.text.stroke": "l.t.s",
};

const stylerKeyMap: Record<string, string> = {
	hue: "h",
	saturation: "s",
	lightness: "l",
	gamma: "g",
	invert_lightness: "il",
	visibility: "v",
	color: "c",
	weight: "w",
};

export interface MapStyle {
	featureType?: string;
	elementType?: string;
	stylers: Record<string, any>[];
}

export function serializeStyles(styles: MapStyle[]): string | null {
	const parts = styles
		.map(({ featureType, elementType, stylers }) => {
			const r: string[] = [];
			if (featureType) {
				const v = featureTypeMap[featureType];
				if (v != null) r.push(`s.t:${v}`);
			}
			if (elementType) {
				const v = elementTypeMap[elementType];
				if (v != null) r.push(`s.e:${v}`);
			}
			for (const s of stylers)
				for (const [k, v] of Object.entries(s)) {
					const mapped = stylerKeyMap[k];
					if (mapped != null) r.push(`p.${mapped}:${v}`);
				}
			return r.join("|");
		})
		.filter((s) => s.length > 0);
	return parts.length > 0 ? parts.join(",") : null;
}

// --- High-level helpers matching map_editor's _u and Eu ---

export function buildMapStyles(basemap: string, styles: MapStyle[] = []): Styler[] {
	const basemapNames: Record<string, string> = {
		roadmap: "Roadmap",
		satellite: "RoadmapSatellite",
		terrain: "Terrain",
	};
	const result: Styler[] = [];
	const name = basemapNames[basemap];
	if (name)
		result.push(new Styler({ type: StyleType.BASEMAP, params: [{ key: "set", value: name }] }));
	result.push(new Styler({ type: StyleType.SMARTMAPS, params: [{ key: "smartmaps" }] }));
	if (styles.length > 0) {
		const encoded = serializeStyles(styles);
		if (encoded)
			result.push(
				new Styler({ type: StyleType.STYLERS, params: [{ key: "styles", value: encoded }] }),
			);
	}
	return result;
}

export function buildSvCoverageConfig(opts: {
	showOfficial?: boolean;
	showUnofficial?: boolean;
	styles?: MapStyle[];
	useDetailedLines?: boolean;
}): { cc: string; svl: string; mapStyles: Styler[] } {
	const strategies: any[] = [];
	if (opts.showOfficial ?? true) {
		strategies.push(
			new RenderStrategy({
				frontend: CoverageType.OFFICIAL,
				tiled: true,
				imageFormat: ImageFormat.Z,
			}),
		);
	}
	if (opts.showUnofficial ?? true) {
		strategies.push(
			new RenderStrategy({
				frontend: CoverageType.UNKNOWN,
				tiled: true,
				imageFormat: ImageFormat.Z,
			}),
		);
		strategies.push(
			new RenderStrategy({
				frontend: CoverageType.USER_UPLOADED,
				tiled: true,
				imageFormat: ImageFormat.Z,
			}),
		);
	}
	const cs = new CoverageStrategies({ strategies, unknownBool: true, unknownBool2: true });
	const svl = new SvlConfig({
		showUserContent: false,
		useDetailedLines: opts.useDetailedLines ?? true,
	});
	return {
		cc: encodeCoverageStrategies(cs),
		svl: encodeSvlConfig(svl),
		mapStyles: buildMapStyles("roadmap", opts.styles ?? []),
	};
}

function applyTileCoords(cfg: TileConfig, x: number, y: number, zoom: number) {
	const { tile } = cfg.query;
	const n = 2 ** zoom;
	tile.x = ((x % n) + n) % n;
	tile.y = y;
	tile.zoom = zoom;
	tile.size = TILE_SIZE;
}

export function buildTileUrl(cfg: TileConfig, x: number, y: number, zoom: number): string {
	applyTileCoords(cfg, x, y, zoom);
	const url = new URL("https://maps.googleapis.com/maps/vt");
	url.searchParams.set("pb", serializeTileUrl(cfg));
	return url.toString();
}

// Cloud-styled tile endpoint: the map_id applies a server-side published style.
export function buildStyledTileUrl(
	cfg: TileConfig,
	mapId: string,
	x: number,
	y: number,
	zoom: number,
): string {
	applyTileCoords(cfg, x, y, zoom);
	const url = new URL("https://mapsresources-pa.googleapis.com/v1/tiles");
	url.searchParams.set("map_id", mapId);
	url.searchParams.set("pb", serializeTileUrl(cfg));
	return url.toString();
}

export function createRoadmapTileConfig(styles: MapStyle[] = []): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.ROADMAP, layerName: "m", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			unknownStyleFlag: LegacyFlag.CURRENT,
			styles: buildMapStyles("roadmap", [
				{ elementType: "labels", stylers: [{ visibility: "off" }] },
				{
					elementType: "geometry.stroke",
					featureType: "administrative",
					stylers: [{ visibility: "off" }],
				},
				...styles,
			]),
		},
		renderOptions: { scale: devicePixelRatio },
	});
}

export function createLabelsTileConfig(styles: MapStyle[] = []): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.ROADMAP, layerName: "m", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			unknownStyleFlag: LegacyFlag.CURRENT,
			styles: buildMapStyles("roadmap", [
				{ elementType: "geometry", stylers: [{ visibility: "off" }] },
				{
					featureType: "administrative",
					elementType: "geometry.stroke",
					stylers: [{ visibility: "on" }],
				},
				{ elementType: "labels", stylers: [{ visibility: "on" }] },
				...styles,
			]),
		},
		renderOptions: { scale: devicePixelRatio },
	});
}

// GeoGuessr's published Cloud Maps style (legacy renderer: white/yellow roads).
// The colors come from the map_id, so configs must be served via buildStyledTileUrl.
export const LEGACY_STYLE_MAP_ID = "61449c20e7fc278b";

function buildLegacyStylers(styleType: number, styles: MapStyle[] = []): Styler[] {
	const stylers: Styler[] = [
		new Styler({ type: styleType, params: [] }),
		new Styler({ type: StyleType.HIGH_DPI, params: [] }),
	];
	if (styles.length > 0) {
		const encoded = serializeStyles(styles);
		if (encoded)
			stylers.push(
				new Styler({ type: StyleType.STYLERS, params: [{ key: "styles", value: encoded }] }),
			);
	}
	return stylers;
}

// Legacy basemap via map_id with NO_LABELS so labels/borders can be stacked above SV coverage.
export function createLegacyTileConfig(styles: MapStyle[] = []): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.ROADMAP, layerName: "m", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			unknownStyleFlag: LegacyFlag.CURRENT,
			styles: buildLegacyStylers(StyleType.NO_LABELS, [
				{
					elementType: "geometry.stroke",
					featureType: "administrative",
					stylers: [{ visibility: "off" }],
				},
				...styles,
			]),
		},
		renderOptions: { scale: devicePixelRatio },
	});
}

const LEGACY_TERRAIN_LAYER_VERSIONS = { terrain: 725, roads: 725483392 } as const;
const LEGACY_TERRAIN_TILE_HASH = 56565656;

export function createLegacyTerrainTileConfig(): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [
			{
				type: LayerType.TERRAIN,
				layerName: "t",
				layerVersion: LEGACY_TERRAIN_LAYER_VERSIONS.terrain,
			},
			{
				type: LayerType.ROADMAP,
				layerName: "r",
				layerVersion: LEGACY_TERRAIN_LAYER_VERSIONS.roads,
			},
		],
		options: {
			language: "en",
			region: "US",
			outputFormat: 0,
			unknownStyleFlag: LegacyFlag.LEGACY,
			styles: [
				new Styler({
					type: StyleType.NO_LABELS,
					params: [{ key: "set", value: "Terrain" }],
				}),
				new Styler({ type: StyleType.SMARTMAPS, params: [{ key: "smartmaps" }] }),
			],
		},
		renderOptions: { rasterType: 3, scale: devicePixelRatio },
		tileHash: LEGACY_TERRAIN_TILE_HASH,
		footerStyleTypes: [StyleType.HIGH_DPI, StyleType.NO_LABELS],
	});
}

export function createSatelliteLabelsTileConfig(styles: MapStyle[] = []): TileConfig {
	const stylers: Styler[] = [
		new Styler({ type: StyleType.SATELLITE, params: [] }),
		new Styler({ type: StyleType.HIGH_DPI, params: [] }),
	];
	if (styles.length > 0) {
		const encoded = serializeStyles([
			{ elementType: "geometry", stylers: [{ visibility: "off" }] },
			{
				featureType: "administrative",
				elementType: "geometry.stroke",
				stylers: [{ visibility: "on" }],
			},
			{ elementType: "labels", stylers: [{ visibility: "on" }] },
			...styles,
		]);
		if (encoded)
			stylers.push(
				new Styler({ type: StyleType.STYLERS, params: [{ key: "styles", value: encoded }] }),
			);
	}
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.ROADMAP, layerName: "m", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			outputFormat: 0,
			unknownStyleFlag: LegacyFlag.CURRENT,
			styles: stylers,
		},
		renderOptions: { scale: devicePixelRatio },
	});
}

export function createSatelliteTileConfig(): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.SATELLITE, layerName: "s", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			styles: [
				new Styler({
					type: StyleType.BASEMAP,
					params: [{ key: "set", value: "RoadmapSatellite" }],
				}),
				new Styler({ type: StyleType.SMARTMAPS, params: [{ key: "smartmaps" }] }),
			],
		},
		renderOptions: { scale: devicePixelRatio },
	});
}

export function createSvTileConfig(opts: {
	showOfficial?: boolean;
	showUnofficial?: boolean;
	color: string;
	thickness: "default" | "high";
	useDetailedLines?: boolean;
}): TileConfig {
	const fill = resolveSvColorHex(opts.color);
	const { h, s, l } = hexToHsl(fill);
	const stroke = hslToHex(h, s, Math.min(l + 40, 90));
	const w = opts.thickness === "high" ? 0.5 : 1;
	const sw = opts.thickness === "high" ? 0.5 : 3;

	const svStyles: MapStyle[] = [
		{ stylers: [{ color: fill }] },
		{ elementType: "geometry.fill", stylers: [{ color: fill, weight: w }] },
		{ elementType: "geometry.stroke", stylers: [{ color: stroke, weight: sw }] },
	];

	const { cc, svl, mapStyles } = buildSvCoverageConfig({
		showOfficial: opts.showOfficial ?? true,
		showUnofficial: opts.showUnofficial ?? true,
		styles: svStyles,
		useDetailedLines: opts.useDetailedLines ?? true,
	});

	return new TileConfig({
		query: { tile: {} },
		layers: [
			{
				type: LayerType.STREETVIEW,
				layerName: "svv",
				layerOptions: [
					{ key: "cc", value: cc },
					{ key: "svl", value: svl },
				],
			},
		],
		options: { language: "en", region: "US", styles: mapStyles },
		renderOptions: { scale: devicePixelRatio },
	});
}

export function createSvBlobbyTileConfig(opts: {
	showOfficial?: boolean;
	showUnofficial?: boolean;
	color: string;
}): TileConfig {
	const fill = resolveSvColorHex(opts.color);
	const showBoth = (opts.showOfficial ?? true) && (opts.showUnofficial ?? true);

	const svStyles: MapStyle[] = showBoth
		? [{ stylers: [{ color: fill }] }]
		: [
				{ elementType: "geometry", stylers: [{ color: fill, weight: 10 }] },
				{ elementType: "geometry.stroke", stylers: [{ visibility: "off" }] },
			];

	const { cc, svl, mapStyles } = buildSvCoverageConfig({
		showOfficial: showBoth ? true : (opts.showOfficial ?? true),
		showUnofficial: showBoth ? true : (opts.showUnofficial ?? true),
		styles: svStyles,
		useDetailedLines: !showBoth,
	});

	return new TileConfig({
		query: { tile: {} },
		layers: [
			{
				type: LayerType.STREETVIEW,
				layerName: "svv",
				layerOptions: [
					{ key: "cc", value: cc },
					{ key: "svl", value: svl },
				],
			},
		],
		options: { language: "en", region: "US", styles: mapStyles },
		renderOptions: { scale: devicePixelRatio },
	});
}

export function createTerrainBasemapTileConfig(styles: MapStyle[] = []): TileConfig {
	const stylers: Styler[] = [
		new Styler({ type: StyleType.BASEMAP, params: [{ key: "set", value: "Terrain" }] }),
		new Styler({ type: StyleType.SMARTMAPS, params: [{ key: "smartmaps" }] }),
		new Styler({ type: StyleType.TERRAIN, params: [] }),
		new Styler({ type: StyleType.TERRAIN_ROADS, params: [] }),
	];
	if (styles.length > 0) {
		const encoded = serializeStyles(styles);
		if (encoded)
			stylers.push(
				new Styler({ type: StyleType.STYLERS, params: [{ key: "styles", value: encoded }] }),
			);
	}
	return new TileConfig({
		query: { tile: {} },
		layers: [
			{ type: LayerType.ROADMAP, layerName: "m", layerOptions: [] },
			{ type: LayerType.TERRAIN_RELIEF, layerName: "shading", layerOptions: [] },
			{ type: LayerType.TERRAIN_CONTOURS, layerName: "contours", layerOptions: [] },
		],
		options: { language: "en", region: "US", styles: stylers },
		renderOptions: { scale: devicePixelRatio },
	});
}

export function createTerrainOverlayTileConfig(): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.TERRAIN, layerName: "t", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			styles: [
				new Styler({ type: StyleType.BASEMAP, params: [{ key: "set", value: "Terrain" }] }),
				new Styler({ type: StyleType.SMARTMAPS, params: [{ key: "smartmaps" }] }),
				new Styler({ type: StyleType.TERRAIN, params: [] }),
				new Styler({ type: StyleType.TERRAIN_ROADS, params: [] }),
			],
		},
		renderOptions: { scale: devicePixelRatio },
	});
}
