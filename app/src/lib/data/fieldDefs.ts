import { KNOWN_FIELDS } from "@/bindings.consts";
import {
	type BatchMode,
	type ExtraFieldDef,
	type RateSpec,
	type Selector,
	type Sink,
} from "@/bindings.gen";
import { registerPluginFieldDefs, unregisterPluginFieldDefs } from "@/lib/data/fieldDefRegistry";
import { resolvePluginPath, trackDisposable } from "@/plugins/scope";
import { log } from "@/lib/util/log";

export interface EnrichFieldOption {
	key: string;
	label: string;
	/** Excluded from the default field set (null enrichFields); user must opt in. */
	defaultOff?: boolean;
}

const coreFieldOptions: EnrichFieldOption[] = KNOWN_FIELDS.map((f) => ({
	key: f.key,
	label: f.label,
	defaultOff: f.defaultOff,
}));

const pluginFieldOptions: EnrichFieldOption[] = [];

/** Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`). */
export function knownFieldDefs(...keys: string[]): Record<string, ExtraFieldDef> {
	const out: Record<string, ExtraFieldDef> = {};
	for (const key of keys) {
		const f = KNOWN_FIELDS.find((k) => k.key === key);
		if (!f) continue;
		out[key] = {
			type: f.type,
			label: f.label,
			values: f.values.length > 0 ? [...f.values] : null,
			labels: f.labels.length > 0 ? Object.fromEntries(f.labels) : null,
			comparison: f.circularPeriod != null ? { type: "circular", period: f.circularPeriod } : null,
		};
	}
	return out;
}

/** All enrichment field options (core and plugin-registered). */
export function getEnrichFieldOptions(): EnrichFieldOption[] {
	return [...coreFieldOptions, ...pluginFieldOptions];
}

/** Offer extra fields in the enrichment UI. Unregistered when the plugin deactivates. */
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

/** All enrichment field keys (core and plugin-registered). */
export function getAllEnrichKeys(): string[] {
	return getEnrichFieldOptions().map((f) => f.key);
}

/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). */
export function getDefaultEnrichKeys(): string[] {
	return getEnrichFieldOptions()
		.filter((f) => !f.defaultOff)
		.map((f) => f.key);
}

/** A unit of work for the procedure engine: which module to run, and how. */
export interface ProcedureSpec<TCollected = unknown> {
	/** Phantom field carrying the `TCollected` type. Never set at runtime. */
	readonly collects?: TCollected;
	/** Module entry point: absolute path, `res://procedures/<name>.js` for built-in
	 *  procedures, or a relative filename (resolved against the plugin's directory). */
	entry: string;
	/** Rows the engine feeds the procedure. Omitted, the driver supplies its own. */
	select?: Selector;
	batch: BatchMode;
	/** Where answers go: `patch` writes to locations (default), `collect` returns them
	 *  to the caller. */
	sink?: Sink;
	rate?: RateSpec;
	/** Overrides the engine's transient-status retry default. Omit unless this endpoint
	 *  answers a retryable condition with a status the default does not cover. */
	retry?: { attempts: number; on: number[] };
	/** Maximum concurrent in-flight requests across all instances. */
	inflight?: number;
	/** Maximum concurrent procedure instances. */
	instances?: number;
	/** Provider-specific configuration passed to the procedure module. */
	config?: unknown;
	/** Awaited before the provider joins a run; returning false excludes it. */
	prepare?: () => Promise<boolean>;
}

/** A named procedure with dependency-graph placement. Providers that declare
 *  `fieldDefs` are enrichment providers whose fields appear in the enrichment UI. */
export interface Provider {
	id: string;
	/** Bulk progress label for slow providers; omit for instant ones. */
	label?: string;
	/** The procedure that computes this provider's fields. */
	procedure: ProcedureSpec;
	/** Extra-field keys this provider produces. */
	fieldDefs?: Record<string, ExtraFieldDef>;
	/** Core columns this provider writes (e.g. `panoId`). */
	provides?: string[];
	/** Fields this provider reads; it runs after their producers finish. */
	requires?: string[];
}

const providers: Provider[] = [];

/** Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
 *  deactivates. */
export function registerProvider(provider: Provider) {
	if (!provider.procedure) {
		log.error(`[procedure] provider "${provider.id}" declares no procedure; ignored`);
		return;
	}
	provider.procedure.entry = resolvePluginPath(provider.procedure.entry);
	if (!providers.some((p) => p.id === provider.id)) {
		providers.push(provider);
		registerPluginFieldDefs(provider.fieldDefs ?? {});
		const defKeys = Object.keys(provider.fieldDefs ?? {});
		trackDisposable(() => {
			const i = providers.findIndex((p) => p.id === provider.id);
			if (i >= 0) providers.splice(i, 1);
			unregisterPluginFieldDefs(defKeys);
		});
	}
}

/** All registered providers. */
export function getProviders(): Provider[] {
	return providers;
}

/** The provider that produces a given extra field, if any. */
export function getProviderForField(field: string): Provider | undefined {
	return providers.find((p) => p.fieldDefs != null && field in p.fieldDefs);
}

/** True when `key` is in the given enrichment set (or in the default set when null). */
export function isFieldEnabled(enrichFields: string[] | null, key: string): boolean {
	return (enrichFields ?? getDefaultEnrichKeys()).includes(key);
}

/** Every field transitively derived from the `changed` keys via the provider graph. */
export function derivedFrom(changed: Iterable<string>): Set<string> {
	const stale = new Set<string>();
	const queue = [...changed];
	while (queue.length > 0) {
		const key = queue.pop()!;
		for (const p of getProviders()) {
			if (!p.requires?.includes(key)) continue;
			for (const out of [...Object.keys(p.fieldDefs ?? {}), ...(p.provides ?? [])]) {
				if (!stale.has(out)) {
					stale.add(out);
					queue.push(out);
				}
			}
		}
	}
	return stale;
}

/** Remove fields transitively derived from `changed` from an `extra` record. */
export function withoutDerivedFrom(
	extra: Record<string, unknown> | null,
	changed: Iterable<string>,
): Record<string, unknown> | null {
	if (!extra) return extra;
	const stale = derivedFrom(changed);
	return Object.fromEntries(Object.entries(extra).filter(([key]) => !stale.has(key)));
}
