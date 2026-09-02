import type { Location } from "@/bindings.gen";
import type { PanoView } from "@/types";

export interface GeneratorSettings {
	defaultTarget: number;
	radius: number;
	rejectUnofficial: boolean;
	rejectGen1: boolean;
	rejectOfficial: boolean;
	rejectNoDescription: boolean;
	rejectDescription: boolean;
	rejectDateless: boolean;
	adjustHeading: boolean;
	headingReference: "link" | "forward" | "backward";
	headingDeviation: number;
	adjustPitch: boolean;
	pitchDeviation: number;
	fromDate: string;
	toDate: string;
	checkAllDates: boolean;
	checkLinks: boolean;
	linksDepth: number;
	onlyOneInTimeframe: boolean;
	oneCountryAtATime: boolean;
	numGenerators: number;
	findGeneration: boolean;
	generation: 1 | 23 | 4;
	getIntersection: boolean;
	pinpointSearch: boolean;
	pinpointAngle: number;
	selectMonths: boolean;
	fromMonth: string;
	toMonth: string;
	fromYear: string;
	toYear: string;
	findRegions: boolean;
	regionRadius: number;
	skipExisting: boolean;
	skipExistingRadius: number;
	randomInTimeline: boolean;
	showSearchOverlay: boolean;
	searchInDescription: boolean;
	searchTerms: string;
	searchMode: SearchMode;
	searchFilterType: "include" | "exclude";
	filterByLinks: boolean;
	minLinks: number;
	maxLinks: number;
	adjustZoom: boolean;
	zoomLevel: number;
	speed: number;
	samplingMode: SamplingMode;
}

export type SamplingMode = "random" | "poisson" | "blueline" | "kernels";

export type SearchMode = "contains" | "fullword" | "startswith" | "endswith" | "sectionmatch";

const now = new Date();
const pad = (n: number) => (n < 10 ? "0" : "") + n;

export const DEFAULT_SETTINGS: GeneratorSettings = {
	defaultTarget: 10,
	radius: 500,
	rejectUnofficial: true,
	rejectGen1: false,
	rejectOfficial: false,
	rejectNoDescription: true,
	rejectDescription: false,
	rejectDateless: true,
	adjustHeading: true,
	headingReference: "link",
	headingDeviation: 0,
	adjustPitch: false,
	pitchDeviation: 10,
	fromDate: "2009-01",
	toDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
	checkAllDates: false,
	checkLinks: false,
	linksDepth: 2,
	onlyOneInTimeframe: false,
	oneCountryAtATime: false,
	numGenerators: 1,
	findGeneration: false,
	generation: 1,
	getIntersection: false,
	pinpointSearch: false,
	pinpointAngle: 145,
	selectMonths: false,
	fromMonth: "01",
	toMonth: "12",
	fromYear: "2007",
	toYear: String(now.getFullYear()),
	findRegions: false,
	regionRadius: 100,
	skipExisting: false,
	skipExistingRadius: 100,
	randomInTimeline: false,
	showSearchOverlay: false,
	searchInDescription: false,
	searchTerms: "",
	searchMode: "contains",
	searchFilterType: "include",
	filterByLinks: false,
	minLinks: 1,
	maxLinks: 5,
	adjustZoom: false,
	zoomLevel: 0,
	speed: 1000,
	samplingMode: "random",
};

export interface GeneratorRegionMeta {
	target: number;
	found: GeneratedLocation[];
	checkedPanos: Set<string>;
	isProcessing: boolean;
}

export interface GeneratorRegion {
	id: string;
	name: string;
	feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
	found: GeneratedLocation[];
	target: number;
	checkedPanos: Set<string>;
	isProcessing: boolean;
}

export type GeneratedLocation = PanoView &
	Pick<Location, "lat" | "lng"> & { imageDate: string | null };

export interface GenerationCallbacks {
	onLocationsFound: (locs: GeneratedLocation[]) => void;
	onProgress: (regionId: string, found: number, target: number) => void;
	onRegionComplete: (regionId: string) => void;
	onError?: (error: Error) => void;
	onDone: () => void;
}
