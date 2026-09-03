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

/** Field defs for catalog keys, for providers that write well-known SV fields. */
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

export function getAllEnrichKeys(): string[] {
	return getEnrichFieldOptions().map((f) => f.key);
}

/** Keys enriched when enrichFields is null (the default set: all options except defaultOff ones). */
export function getDefaultEnrichKeys(): string[] {
	return getEnrichFieldOptions()
		.filter((f) => !f.defaultOff)
		.map((f) => f.key);
}

/** A unit of work for the procedure engine: which module, and how to drive it. This is
 *  everything the engine needs and nothing about enrichment; `runProcedure` takes one
 *  directly. Locations never reach JS: the engine pages them and applies the patches
 *  itself. `TCollected` is the shape of one answer under the `collect` sink, as the
 *  module defines it; the engine carries it as JSON and never checks it. */
export interface ProcedureSpec<TCollected = unknown> {
	/** Never set. Carries `TCollected` on the value so `runProcedure` can type its answers. */
	readonly collects?: TCollected;
	/** Module entry point: absolute path, or "res://procedures/<name>.js" for app-bundled
	 *  core procedures, or a bare relative filename for user-plugin-shipped modules (resolved
	 *  against the registering plugin's directory by the plugin loader). */
	entry: string;
	/** Rows the engine feeds the procedure. Omitted, the driver supplies its own. */
	select?: Selector;
	batch: BatchMode;
	/** Where the answers go: `patch` (the default) writes them to the locations they
	 *  name, `collect` hands them to the caller and writes nothing. `runProcedure` can
	 *  override it, which is how a caller borrows a writing procedure for its answers
	 *  alone. */
	sink?: Sink;
	rate?: RateSpec;
	retry?: { attempts: number; on: number[] };
	/** Requests this provider may keep in flight at once, summed over its instances.
	 *  This is where a network-bound provider's throughput comes from: the engine holds
	 *  the budget, so a procedure reaches it by asking for many requests at once
	 *  (`fetchMany`), never by running more instances. */
	inflight?: number;
	/** Procedure instances the provider may run at once. Only for a procedure that cannot
	 *  run beside itself (one sidecar process, one large model); otherwise the engine
	 *  takes one per core, which is not a throughput knob. */
	instances?: number;
	/** Provider-specific settings for the module, any JSON value. The engine splices it
	 *  into the configuration it hands the procedure: `{fields, force, config}`. */
	config?: unknown;
	/** Awaited before the provider joins a run; false drops it (e.g. a dataset download failed). */
	prepare?: () => Promise<boolean>;
}

/** A procedure with a place in the dependency graph: what it produces (`fieldDefs`,
 *  `provides`) and what it must wait for (`requires`), so `runProviders` can schedule
 *  several together. One that declares `fieldDefs` is an enrichment provider: its fields
 *  are selectable and `enrichAll` runs it implicitly. A consumer that just wants one
 *  procedure run declares a `ProcedureSpec` and calls `runProcedure`. */
export interface Provider {
	id: string;
	/** Bulk progress label for slow providers; omit for instant ones. */
	label?: string;
	/** The procedure the Rust engine runs for this provider. */
	procedure: ProcedureSpec;
	/** Selectable `extra` keys this provider produces. Omitted, the provider writes
	 *  core columns instead: it is always active, and `enrichAll` never runs it
	 *  implicitly -- only a caller naming it does. */
	fieldDefs?: Record<string, ExtraFieldDef>;
	/** Core columns this provider writes, e.g. `panoId`. Scheduled into the dependency
	 *  waves and used to skip rows that already hold them, exactly like `fieldDefs`. */
	provides?: string[];
	/** Fields this provider reads: the engine schedules it into a later dependency
	 *  wave than any provider producing them. */
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

export function getProviders(): Provider[] {
	return providers;
}

export function getProviderForField(field: string): Provider | undefined {
	return providers.find((p) => p.fieldDefs != null && field in p.fieldDefs);
}

export function isFieldEnabled(enrichFields: string[] | null, key: string): boolean {
	return (enrichFields ?? getDefaultEnrichKeys()).includes(key);
}

/** `extra` without every field a provider produces: what a row forgets when the pano it
 *  was derived from changes, for enrichment to derive again. */
export function withoutProvided(
	extra: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!extra) return extra;
	const provided = new Set(getProviders().flatMap((p) => Object.keys(p.fieldDefs ?? {})));
	return Object.fromEntries(Object.entries(extra).filter(([key]) => !provided.has(key)));
}
