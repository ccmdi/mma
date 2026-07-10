import type { MapStyle } from "@/lib/geo/tiles";

export const MUTED_STYLES: MapStyle[] = [
	{ stylers: [{ saturation: -60 }, { lightness: 10 }, { gamma: 1.2 }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#c4d4e0" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#8a9bab" }] },
	{ featureType: "landscape", elementType: "geometry.fill", stylers: [{ color: "#e8e4df" }] },
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#f5f3f0" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#d5d0c9" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a8580" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#e8ddd0" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#c9bfb2" }] },
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#ddd9d2" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#93908b" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#d4ddd0" }] },
	{ featureType: "transit", stylers: [{ visibility: "off" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#9a8e80" }],
	},
	{ elementType: "labels.text.fill", stylers: [{ color: "#6b6660" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#e8e4df" }] },
];

export const MIDNIGHT_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#0f0f0f" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#999999" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#0a0a0a" }] },
	{
		featureType: "administrative.country",
		elementType: "geometry.stroke",
		stylers: [{ color: "#2a3a4a" }, { weight: 1.5 }],
	},
	{
		featureType: "administrative.province",
		elementType: "geometry.stroke",
		stylers: [{ color: "#1e2835" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#bbbbbb" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#1a1a1a" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#111111" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#777777" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#252525" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#111111" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#888888" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#020508" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3a5a70" }] },
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#111111" }],
	},
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#111111" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#777777" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#0a120a" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#111111" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#777777" }],
	},
];

export const MINIMAL_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#f0f0f0" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#666666" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#f0f0f0" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#8898a4" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#444444" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#ffffff" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#d8d8d8" }] },
	{ featureType: "road", elementType: "labels", stylers: [{ visibility: "off" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#f8f8f8" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#cccccc" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#c8d8e4" }] },
	{ featureType: "water", elementType: "labels", stylers: [{ visibility: "off" }] },
	{ featureType: "poi", stylers: [{ visibility: "off" }] },
	{ featureType: "transit", stylers: [{ visibility: "off" }] },
	{
		featureType: "landscape.man_made",
		elementType: "geometry.fill",
		stylers: [{ color: "#e8e8e8" }],
	},
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#eaeaea" }],
	},
];

export const VINTAGE_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#e8dcc8" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#5c4a32" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#e8dcc8" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#a08b6c" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#6b5438" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#d6c9ae" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#bfad8c" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#7a6b52" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#c4b48e" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#a89870" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#6b5a3e" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#8fafa5" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#5e8a7e" }] },
	{ featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#8fafa5" }] },
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#ddd1ba" }],
	},
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#d5c8ae" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#7a6b52" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#bcc9a5" }] },
	{ featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b7a52" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#c9bda5" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#7a6b52" }],
	},
];

export const GRAYSCALE_STYLES: MapStyle[] = [
	{ stylers: [{ saturation: -100 }] },
	{ elementType: "geometry", stylers: [{ color: "#e5e5e5" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#555555" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#e5e5e5" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#707880" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#444444" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#ffffff" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#cccccc" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#666666" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#f2f2f2" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#bbbbbb" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#b0b0b0" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#666666" }] },
	{ featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#b0b0b0" }] },
	{ featureType: "landscape", elementType: "geometry.fill", stylers: [{ color: "#e0e0e0" }] },
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#d5d5d5" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#666666" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#d0d0d0" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#d8d8d8" }] },
];

export const BLUEPRINT_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#0d1b2a" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#7ea8cc" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#0d1b2a" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#1f3d5c" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#a0c4e0" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#162d44" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1f3d5c" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#5588aa" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#1c3a55" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#264a66" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#8ab8d8" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#081420" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#2a5070" }] },
	{ featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#081420" }] },
	{ featureType: "landscape", elementType: "geometry.fill", stylers: [{ color: "#0f1f30" }] },
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#112238" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#4a7fa0" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#0d2520" }] },
	{ featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#3a7a6a" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#112238" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#5588aa" }],
	},
];

export const ARCTIC_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#e8f0f8" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#4a6a80" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#e8f0f8" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#8ab0cc" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#3a5a70" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#f0f6fc" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#c0d8e8" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#5a7a90" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#d0e4f0" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#a0c0d8" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#4a6a80" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#a0c8e0" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#4a7a98" }] },
	{ featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#a0c8e0" }] },
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#dce8f2" }],
	},
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#d4e4f0" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#5a7a90" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#c8dce8" }] },
	{ featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#4a7080" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#d0e0ec" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#5a7a90" }],
	},
];

export const EMBER_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#1a0c04" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#d4884a" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#1a0c04" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#6a3010" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#e8a050" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#301808" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a0c04" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#a06828" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#4a2008" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#602808" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#cc8040" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#100602" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#5a3018" }] },
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#201006" }],
	},
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#201006" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#a06828" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#1a1806" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#201006" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#a06828" }],
	},
];

export const FOREST_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#2a2820" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#9a9a78" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#2a2820" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#504830" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#b0aa88" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#383428" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#2a2820" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#7a7858" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#3e3a28" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#484030" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#9a9870" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#1a1c18" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3a3c30" }] },
	{ featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#1a1c18" }] },
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#2e2c22" }],
	},
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#2e2c22" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#7a7858" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#2a3220" }] },
	{ featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6a7a55" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#2e2c22" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#7a7858" }],
	},
];

export const NOIR_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#0a0a0a" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#ffffff" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#000000" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#ffffff" }, { weight: 1.2 }],
	},
	{
		featureType: "administrative.province",
		elementType: "geometry.stroke",
		stylers: [{ color: "#888888" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#1c1c1c" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#000000" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#cccccc" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#252525" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#000000" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#ffffff" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#000000" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#555555" }] },
	{ featureType: "landscape", elementType: "geometry.fill", stylers: [{ color: "#141414" }] },
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#121212" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#aaaaaa" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#0e0e0e" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#121212" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#cccccc" }],
	},
];

export const DUSK_STYLES: MapStyle[] = [
	{ elementType: "geometry", stylers: [{ color: "#1a1028" }] },
	{ elementType: "labels.text.fill", stylers: [{ color: "#b08aaa" }] },
	{ elementType: "labels.text.stroke", stylers: [{ color: "#1a1028" }] },
	{
		featureType: "administrative",
		elementType: "geometry.stroke",
		stylers: [{ color: "#4a3060" }],
	},
	{
		featureType: "administrative.locality",
		elementType: "labels.text.fill",
		stylers: [{ color: "#d0a8c8" }],
	},
	{ featureType: "road", elementType: "geometry.fill", stylers: [{ color: "#251838" }] },
	{ featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a1028" }] },
	{ featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#886888" }] },
	{ featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: "#302040" }] },
	{ featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#3a2850" }] },
	{ featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#a880a0" }] },
	{ featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#100a1e" }] },
	{ featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3a2858" }] },
	{
		featureType: "landscape.natural",
		elementType: "geometry.fill",
		stylers: [{ color: "#1e1430" }],
	},
	{ featureType: "poi", elementType: "geometry.fill", stylers: [{ color: "#1e1430" }] },
	{ featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#886888" }] },
	{ featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#1a1830" }] },
	{ featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6a5880" }] },
	{ featureType: "transit", elementType: "geometry", stylers: [{ color: "#1e1430" }] },
	{
		featureType: "transit.station",
		elementType: "labels.text.fill",
		stylers: [{ color: "#886888" }],
	},
];

export type BuiltinStyleKey =
	| "default"
	| "legacy"
	| "muted"
	| "midnight"
	| "minimal"
	| "vintage"
	| "grayscale"
	| "blueprint"
	| "arctic"
	| "ember"
	| "forest"
	| "noir"
	| "dusk";

export const BUILTIN_STYLE_MAP: Partial<Record<BuiltinStyleKey, MapStyle[]>> = {
	muted: MUTED_STYLES,
	midnight: MIDNIGHT_STYLES,
	minimal: MINIMAL_STYLES,
	vintage: VINTAGE_STYLES,
	grayscale: GRAYSCALE_STYLES,
	blueprint: BLUEPRINT_STYLES,
	arctic: ARCTIC_STYLES,
	ember: EMBER_STYLES,
	forest: FOREST_STYLES,
	noir: NOIR_STYLES,
	dusk: DUSK_STYLES,
};

export const BUILTIN_STYLE_LABELS: Record<BuiltinStyleKey, string> = {
	default: "Default",
	legacy: "Legacy",
	muted: "Muted",
	midnight: "Midnight",
	minimal: "Minimal",
	vintage: "Vintage",
	grayscale: "Grayscale",
	blueprint: "Blueprint",
	arctic: "Arctic",
	ember: "Ember",
	forest: "Forest",
	noir: "Noir",
	dusk: "Dusk",
};

export const BUILTIN_STYLE_KEYS: BuiltinStyleKey[] = [
	"default",
	"legacy",
	"muted",
	"midnight",
	"minimal",
	"vintage",
	"grayscale",
	"blueprint",
	"arctic",
	"ember",
	"forest",
	"noir",
	"dusk",
];

const STYLE_BG_COLORS: Record<BuiltinStyleKey, string> = {
	default: "#e5e3df",
	legacy: "#e5e3df",
	muted: "#e8e4df",
	midnight: "#0f0f0f",
	minimal: "#f0f0f0",
	vintage: "#e8dcc8",
	grayscale: "#e5e5e5",
	blueprint: "#0d1b2a",
	arctic: "#e8f0f8",
	ember: "#1a0c04",
	forest: "#2a2820",
	noir: "#000000",
	dusk: "#1a1028",
};

export function getStyleBackgroundColor(style: string): string {
	return STYLE_BG_COLORS[style as BuiltinStyleKey] ?? STYLE_BG_COLORS.default;
}

// --- Vector basemap styles (OpenFreeMap-hosted MapLibre styles) ---

export const VECTOR_STYLE_KEYS = ["liberty", "bright", "positron"] as const;
export type VectorStyleKey = (typeof VECTOR_STYLE_KEYS)[number];

export const VECTOR_STYLE_LABELS: Record<VectorStyleKey, string> = {
	liberty: "Liberty",
	bright: "Bright",
	positron: "Positron",
};

export const DEFAULT_VECTOR_STYLE: VectorStyleKey = "liberty";

export function vectorStyleUrl(name: string): string {
	const key = (VECTOR_STYLE_KEYS as readonly string[]).includes(name) ? name : DEFAULT_VECTOR_STYLE;
	return `https://tiles.openfreemap.org/styles/${key}`;
}
