/* eslint-disable @typescript-eslint/no-explicit-any */
// Protobuf tile URL builder
// Constructs Google Maps Vector Tile URLs with protobuf-encoded parameters.

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

// --- Protobuf message classes ---

class RenderStrategy {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get frontend() {
		return this._a[0] ?? 0;
	}
	set frontend(v) {
		this._a[0] = v;
	}
	get tiled() {
		return this._a[1] ?? false;
	}
	set tiled(v) {
		this._a[1] = v;
	}
	get imageFormat() {
		return this._a[2] ?? 0;
	}
	set imageFormat(v) {
		this._a[2] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeRenderStrategy(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1e${e[0]}`);
	if (e[1]) t.push("2b1");
	if (e[2] != null) t.push(`3e${e[2]}`);
}

export class CoverageStrategies {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get strategies(): RenderStrategy[] {
		return (this._a[0] ??= []).map((e: any) => new RenderStrategy(e));
	}
	set strategies(v: any[]) {
		this._a[0] = (v ?? []).map((e: any) =>
			(e instanceof RenderStrategy ? e : new RenderStrategy(e)).toArray(),
		);
	}
	get unknownBool() {
		return this._a[1] ?? false;
	}
	set unknownBool(v) {
		this._a[1] = v;
	}
	get unknownBool2() {
		return this._a[3] ?? false;
	}
	set unknownBool2(v) {
		this._a[3] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeCoverageStrategies(e: any[], t: string[]) {
	e[0]?.forEach((e: any) => {
		pbMsg(1, serializeRenderStrategy, e, t);
	});
	if (e[1]) t.push("2b1");
	if (e[3]) t.push("4b1");
}

export function encodeCoverageStrategies(cs: CoverageStrategies): string {
	return pbSerialize(serializeCoverageStrategies, cs.toArray());
}

class SvlConfig {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get showUserContent() {
		return this._a[0] ?? false;
	}
	set showUserContent(v) {
		this._a[0] = v;
	}
	get useDetailedLines() {
		return this._a[1] ?? false;
	}
	set useDetailedLines(v) {
		this._a[1] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeSvlConfig(e: any[], t: string[]) {
	if (e[0]) t.push("1b1");
	if (e[1]) t.push("2b1");
}

export function encodeSvlConfig(cfg: SvlConfig): string {
	return pbSerialize(serializeSvlConfig, cfg.toArray());
}

class TileCoord {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get zoom() {
		return this._a[0] ?? 0;
	}
	set zoom(v) {
		this._a[0] = v;
	}
	get x() {
		return this._a[1] ?? 0;
	}
	set x(v) {
		this._a[1] = v;
	}
	get y() {
		return this._a[2] ?? 0;
	}
	set y(v) {
		this._a[2] = v;
	}
	get size() {
		return this._a[3] ?? 0;
	}
	set size(v) {
		this._a[3] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeTileCoord(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1i${e[0]}`);
	if (e[1] != null) t.push(`2i${e[1]}`);
	if (e[2] != null) t.push(`3i${e[2]}`);
	if (e[3] != null) t.push(`4i${e[3]}`);
}

class TileQuery {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get tile(): TileCoord {
		return new TileCoord(this._a[0]);
	}
	set tile(v: any) {
		this._a[0] = (v instanceof TileCoord ? v : new TileCoord(v)).toArray();
	}
	toArray() {
		return this._a;
	}
}

function serializeTileQuery(e: any[], t: string[]) {
	if (e[0] != null) pbMsg(1, serializeTileCoord, e[0], t);
}

class LayerOption {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get key() {
		return this._a[0] ?? "";
	}
	set key(v) {
		this._a[0] = v;
	}
	get value() {
		return this._a[1] ?? "";
	}
	set value(v) {
		this._a[1] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeLayerOption(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1s${pbEscape(e[0])}`);
	if (e[1] != null) t.push(`2s${pbEscape(e[1])}`);
}

class Layer {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get type() {
		return this._a[0] ?? 0;
	}
	set type(v) {
		this._a[0] = v;
	}
	get layerName() {
		return this._a[1] ?? "";
	}
	set layerName(v) {
		this._a[1] = v;
	}
	get layerOptions(): LayerOption[] {
		return (this._a[3] ??= []).map((e: any) => new LayerOption(e));
	}
	set layerOptions(v: any[]) {
		this._a[3] = (v ?? []).map((e: any) =>
			(e instanceof LayerOption ? e : new LayerOption(e)).toArray(),
		);
	}
	toArray() {
		return this._a;
	}
}

function serializeLayer(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1e${e[0]}`);
	if (e[1] != null) t.push(`2s${pbEscape(e[1])}`);
	e[3]?.forEach((e: any) => {
		pbMsg(4, serializeLayerOption, e, t);
	});
}

class StylerParam {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get key() {
		return this._a[0] ?? "";
	}
	set key(v) {
		this._a[0] = v;
	}
	get value() {
		return this._a[1] ?? "";
	}
	set value(v) {
		this._a[1] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeStylerParam(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1s${pbEscape(e[0])}`);
	if (e[1] != null) t.push(`2s${pbEscape(e[1])}`);
}

export class Styler {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get type() {
		return this._a[0] ?? 0;
	}
	set type(v) {
		this._a[0] = v;
	}
	get params(): StylerParam[] {
		return (this._a[1] ??= []).map((e: any) => new StylerParam(e));
	}
	set params(v: any[]) {
		this._a[1] = (v ?? []).map((e: any) =>
			(e instanceof StylerParam ? e : new StylerParam(e)).toArray(),
		);
	}
	toArray() {
		return this._a;
	}
}

function serializeStyler(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1e${e[0]}`);
	e[1]?.forEach((e: any) => {
		pbMsg(2, serializeStylerParam, e, t);
	});
}

class Options {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get language() {
		return this._a[1] ?? "";
	}
	set language(v) {
		this._a[1] = v;
	}
	get region() {
		return this._a[2] ?? "";
	}
	set region(v) {
		this._a[2] = v;
	}
	get unknownStyleFlag() {
		return this._a[4] ?? 0;
	}
	set unknownStyleFlag(v) {
		this._a[4] = v;
	}
	get styles(): Styler[] {
		return (this._a[11] ??= []).map((e: any) => new Styler(e));
	}
	set styles(v: any[]) {
		this._a[11] = (v ?? []).map((e: any) => (e instanceof Styler ? e : new Styler(e)).toArray());
	}
	toArray() {
		return this._a;
	}
}

function serializeOptions(e: any[], t: string[]) {
	if (e[1] != null) t.push(`2s${pbEscape(e[1])}`);
	if (e[2] != null) t.push(`3s${pbEscape(e[2])}`);
	if (e[4] != null) t.push(`5e${e[4]}`);
	e[11]?.forEach((e: any) => {
		pbMsg(12, serializeStyler, e, t);
	});
}

class RenderOptions {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get rasterType() {
		return this._a[0] ?? 0;
	}
	set rasterType(v) {
		this._a[0] = v;
	}
	get scale() {
		return this._a[4] ?? 0;
	}
	set scale(v) {
		this._a[4] = v;
	}
	toArray() {
		return this._a;
	}
}

function serializeRenderOptions(e: any[], t: string[]) {
	if (e[0] != null) t.push(`1e${e[0]}`);
	if (e[4] != null) t.push(`5f${e[4]}`);
}

export class TileConfig {
	private _a: any[];
	constructor(init?: any) {
		if (Array.isArray(init)) this._a = init;
		else {
			this._a = [];
			if (init) Object.assign(this, init);
		}
	}
	get query(): TileQuery {
		return new TileQuery(this._a[0]);
	}
	set query(v: any) {
		this._a[0] = (v instanceof TileQuery ? v : new TileQuery(v)).toArray();
	}
	get layers(): Layer[] {
		return (this._a[1] ??= []).map((e: any) => new Layer(e));
	}
	set layers(v: any[]) {
		this._a[1] = (v ?? []).map((e: any) => (e instanceof Layer ? e : new Layer(e)).toArray());
	}
	get options(): Options {
		return new Options((this._a[2] ??= []));
	}
	set options(v: any) {
		this._a[2] = v == null ? [] : (v instanceof Options ? v : new Options(v)).toArray();
	}
	get outputFormat() {
		return this._a[3] ?? 0;
	}
	set outputFormat(v) {
		this._a[3] = v;
	}
	get renderOptions(): RenderOptions {
		return new RenderOptions((this._a[4] ??= []));
	}
	set renderOptions(v: any) {
		this._a[4] = v == null ? [] : (v instanceof RenderOptions ? v : new RenderOptions(v)).toArray();
	}
	toArray() {
		return this._a;
	}
}

function serializeTileConfig(e: any[], t: string[]) {
	if (e[0] != null) pbMsg(1, serializeTileQuery, e[0], t);
	e[1]?.forEach((e: any) => {
		pbMsg(2, serializeLayer, e, t);
	});
	if (e[2] != null) pbMsg(3, serializeOptions, e[2], t);
	if (e[3] != null) t.push(`4i${e[3]}`);
	if (e[4] != null) pbMsg(5, serializeRenderOptions, e[4], t);
}

export function serializeTileUrl(cfg: TileConfig): string {
	return pbSerialize(serializeTileConfig, cfg.toArray());
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
	tile.size = 256;
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

export function createLegacyTileConfig(styles: MapStyle[] = []): TileConfig {
	return new TileConfig({
		query: { tile: {} },
		layers: [{ type: LayerType.ROADMAP, layerName: "m", layerOptions: [] }],
		options: {
			language: "en",
			region: "US",
			unknownStyleFlag: LegacyFlag.LEGACY,
			styles: buildMapStyles("roadmap", styles),
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
	const style = getComputedStyle(document.body);
	const fill = style.getPropertyValue(`--${opts.color}-7`).trim();
	const stroke = style.getPropertyValue(`--${opts.color}-2`).trim();
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
	const style = getComputedStyle(document.body);
	const fill = style.getPropertyValue(`--${opts.color}-7`).trim();
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
