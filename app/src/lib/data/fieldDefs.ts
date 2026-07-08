import type { ExtraFieldDef, Location } from "@/bindings.gen";
import { registerPluginFieldDefs, unregisterPluginFieldDefs } from "@/lib/data/fieldDefRegistry";
import { trackDisposable } from "@/plugins/scope";

export interface EnrichFieldOption {
	key: string;
	label: string;
	/** Excluded from the default field set (null enrichFields); user must opt in. */
	defaultOff?: boolean;
}

const coreFieldOptions: EnrichFieldOption[] = [
	{ key: "altitude", label: "Altitude" },
	{ key: "countryCode", label: "Country code" },
	{ key: "cameraType", label: "Camera type" },
	{ key: "panoType", label: "Pano type" },
	{ key: "imageDate", label: "Image date" },
	{ key: "datetime", label: "Exact date", defaultOff: true },
	{ key: "timezone", label: "Timezone", defaultOff: true },
	{ key: "drivingDirection", label: "Driving direction", defaultOff: true },
	{ key: "uploaderName", label: "Uploader", defaultOff: true },
	{ key: "coverageDates", label: "Coverage dates", defaultOff: true },
];

const pluginFieldOptions: EnrichFieldOption[] = [];

export function getEnrichFieldOptions(): EnrichFieldOption[] {
	return [...coreFieldOptions, ...pluginFieldOptions];
}

export function registerEnrichFields(fields: EnrichFieldOption[]) {
	for (const f of fields) {
		if (!pluginFieldOptions.some((e) => e.key === f.key)) {
			pluginFieldOptions.push(f);
			trackDisposable(() => {
				const i = pluginFieldOptions.findIndex((e) => e.key === f.key);
				if (i >= 0) pluginFieldOptions.splice(i, 1);
			});
		}
	}
}

export function getAllEnrichKeys(): string[] {
	return getEnrichFieldOptions().map((f) => f.key);
}

/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). */
export function getDefaultEnrichKeys(): string[] {
	return getEnrichFieldOptions()
		.filter((f) => !f.defaultOff)
		.map((f) => f.key);
}

/** Optional context passed by the bulk runner. Cheap providers can ignore it. */
export interface EnrichCtx {
	signal?: AbortSignal;
	force?: boolean;
	/** Advance the bulk progress bar by one unit. */
	onUnit?: () => void;
	/** Report a location that errored (surfaced as failed in the bulk summary). */
	onFail?: (id: number) => void;
}

export interface EnrichmentProvider {
	id: string;
	/** Bulk progress label for slow providers; omit for instant ones. */
	label?: string;
	enrich(
		locations: Location[],
		enrichFields: string[] | null,
		ctx?: EnrichCtx,
	): Promise<Map<number, Record<string, unknown>>>;
	fieldDefs: Record<string, ExtraFieldDef>;
	/** When set, this provider is auto-invoked after patchLocationExtra writes any of these fields. */
	requires?: string[];
	/** Progress units this provider would contribute in bulk (absent = instant). */
	units?(locations: Location[], enrichFields: string[] | null, force?: boolean): number;
	/** Transform a raw partition value per-location. Return null to skip. */
	transform?(field: string, value: string, location: Location): string | null;
}

/** Schedule providers into dependency waves: a provider runs once no other
 *  unscheduled provider produces (via `fieldDefs`) a field it `requires`.
 *  A dependency cycle falls back to running the remainder as one wave. */
export function providerWaves(list: EnrichmentProvider[]): EnrichmentProvider[][] {
	const waves: EnrichmentProvider[][] = [];
	let remaining = [...list];
	while (remaining.length > 0) {
		let wave = remaining.filter(
			(p) => !p.requires?.some((r) => remaining.some((q) => q !== p && r in q.fieldDefs)),
		);
		if (wave.length === 0) wave = remaining;
		waves.push(wave);
		remaining = remaining.filter((p) => !wave.includes(p));
	}
	return waves;
}

const providers: EnrichmentProvider[] = [];

export function registerEnrichmentProvider(provider: EnrichmentProvider) {
	if (!providers.some((p) => p.id === provider.id)) {
		providers.push(provider);
		registerPluginFieldDefs(provider.fieldDefs);
		const defKeys = Object.keys(provider.fieldDefs);
		trackDisposable(() => {
			const i = providers.findIndex((p) => p.id === provider.id);
			if (i >= 0) providers.splice(i, 1);
			unregisterPluginFieldDefs(defKeys);
		});
	}
}

export function getEnrichmentProviders(): EnrichmentProvider[] {
	return providers;
}

export function getProviderForField(field: string): EnrichmentProvider | undefined {
	return providers.find((p) => field in p.fieldDefs);
}

export function getTriggeredProviders(patchedKeys: string[]): EnrichmentProvider[] {
	const keySet = new Set(patchedKeys);
	return providers.filter((p) => p.requires && p.requires.some((r) => keySet.has(r)));
}

export function isFieldEnabled(enrichFields: string[] | null, key: string): boolean {
	return (enrichFields ?? getDefaultEnrichKeys()).includes(key);
}

export function filterEnrichPatch(
	patch: Record<string, unknown>,
	enrichFields: string[] | null,
): Record<string, unknown> {
	if (!enrichFields) return patch;
	const filtered: Record<string, unknown> = {};
	for (const key of enrichFields) {
		if (key in patch) filtered[key] = patch[key];
	}
	return filtered;
}
