import { KNOWN_FIELDS } from "@/bindings.consts";
import type { BatchMode, FieldDef, ProcedureDecl, ProviderDecl } from "@/bindings.gen";
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

const coreFieldKeys = new Set(coreFieldOptions.map((f) => f.key));

/** Build field definitions for well-known keys (e.g. `"altitude"`, `"countryCode"`). */
export function knownFieldDefs(...keys: string[]): Record<string, FieldDef> {
	const out: Record<string, FieldDef> = {};
	for (const key of keys) {
		const f = KNOWN_FIELDS.find((k) => k.key === key);
		if (!f) continue;
		out[key] = {
			type: f.type,
			label: f.label,
			values:
				f.values.length > 0
					? f.values.map((v) => ({
							value: v,
							label: f.labels.find(([k]) => k === v)?.[1] ?? null,
						}))
					: null,
			comparison: f.circularPeriod != null ? { type: "circular", period: f.circularPeriod } : null,
		};
	}
	return out;
}

/** All enrichment field options: the core fields, then every registered provider's own fields. @unstable */
export function getEnrichFieldOptions(): EnrichFieldOption[] {
	const providerOptions = providers.flatMap((p) =>
		Object.entries(p.fieldDefs ?? {})
			.filter(([key]) => !coreFieldKeys.has(key))
			.map(([key, def]) => ({ key, label: def.label ?? key, defaultOff: p.defaultOff })),
	);
	return [...coreFieldOptions, ...providerOptions];
}

/** All enrichment field keys (core and plugin-registered). @unstable */
export function getAllEnrichKeys(): string[] {
	return getEnrichFieldOptions().map((f) => f.key);
}

/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). @unstable */
export function getDefaultEnrichKeys(): string[] {
	return getEnrichFieldOptions()
		.filter((f) => !f.defaultOff)
		.map((f) => f.key);
}

/** The declared form of a wire struct: every field optional, absent where the wire says null. */
type Declared<T> = { [K in keyof T]?: NonNullable<T[K]> };

/** A unit of work for the procedure engine: the procedure's own declaration (`ProcedureDecl`,
 *  what a run and a query both read) plus how a run schedules it. */
export interface ProcedureSpec<TCollected = unknown, TConfig = unknown>
	extends
		Declared<Omit<ProcedureDecl, "entry" | "config">>,
		Declared<Pick<ProviderDecl, "select" | "sink" | "instances">> {
	/** Phantom field carrying the `TCollected` type. Never set at runtime. */
	readonly collects?: TCollected;
	/** Module entry point: absolute path, `res://procedures/<name>.js` for built-in
	 *  procedures, or a relative filename (resolved against the plugin's directory). */
	entry: string;
	batch: BatchMode;
	/** The procedure's own configuration, handed to every entry point as `config`. */
	config?: TConfig;
	/** Awaited before the provider joins a run; returning false excludes it. */
	prepare?: () => Promise<boolean>;
}

/** A named procedure with dependency-graph placement. Providers that declare
 *  `fieldDefs` are enrichment providers whose fields appear in the enrichment UI. */
export interface Provider<TCollected = unknown, TConfig = unknown> {
	id: string;
	/** Name shown in enrichment progress and results. */
	label: string;
	/** The procedure that computes this provider's fields. */
	procedure: ProcedureSpec<TCollected, TConfig>;
	/** Extra-field keys this provider produces. Each is offered as an enrichment option. */
	fieldDefs?: Record<string, FieldDef>;
	/** Leaves this provider's fields out of the default enrichment set, so users opt in. */
	defaultOff?: boolean;
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

/** All registered providers. @unstable */
export function getProviders(): Provider[] {
	return providers;
}

/** The provider that produces a given extra field, if any. @unstable */
export function getProviderForField(field: string): Provider | undefined {
	return providers.find((p) => p.fieldDefs != null && field in p.fieldDefs);
}

/** True when `key` is in the given enrichment set (or in the default set when null). @unstable */
export function isFieldEnabled(enrichFields: string[] | null, key: string): boolean {
	return (enrichFields ?? getDefaultEnrichKeys()).includes(key);
}

/** Every field transitively derived from the `changed` keys via the provider graph. @unstable */
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

/** Remove fields transitively derived from `changed` from an `extra` record. @unstable */
export function withoutDerivedFrom(
	extra: Record<string, unknown> | null,
	changed: Iterable<string>,
): Record<string, unknown> | null {
	if (!extra) return extra;
	const stale = derivedFrom(changed);
	return Object.fromEntries(Object.entries(extra).filter(([key]) => !stale.has(key)));
}
