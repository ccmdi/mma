import type { FieldDef, KeySpec, ProviderDef } from "@/bindings.gen";
import type { Selector } from "@/types";
import { registerPluginFieldDefs, unregisterPluginFieldDefs } from "@/lib/data/fieldDefRegistry";
import {
	Procedure,
	type ProcedureOutcomes,
	type ProcedureSpec,
	type RunOpts,
	type Scheduled,
} from "@/lib/data/procedure";
import { resolvePluginPath, trackDisposable } from "@/plugins/scope";
import { partitionLabel } from "@/lib/util/format";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";

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

/** A registered provider to run, and what this run changes about it. */
export interface ProviderRun<TConfig = unknown> {
	provider: Provider<unknown, TConfig>;
	/** Replaces the config the provider registered. */
	config?: Partial<NoInfer<TConfig>>;
	/** Recompute locations that already hold this provider's fields. Omitted, it follows
	 *  the run's `force`. */
	force?: boolean;
	/** The `fieldDefs` keys to produce; omitted, every key it declares. */
	fields?: string[];
	/** The locations to run over; omitted, the run's selector. */
	select?: Selector;
}

const providers = new Map<string, Provider>();

function definition(p: Provider): ProviderDef {
	return {
		id: p.id,
		label: p.label,
		...Procedure.decl(p.procedure),
		fields: Object.keys(p.fieldDefs ?? {}),
		provides: p.provides ?? [],
		requires: p.requires ?? [],
		batch: p.procedure.batch,
		instances: p.procedure.instances ?? null,
	};
}

export const Provider = {
	/** Register a provider (e.g. a plugin's sun position). Unregistered when the plugin
	 *  deactivates. Resolves once the provider can run. */
	register: async (provider: Provider): Promise<void> => {
		if (!provider.procedure) {
			log.error(`[procedure] provider "${provider.id}" declares no procedure; ignored`);
			return;
		}
		if (providers.has(provider.id)) return;
		provider.procedure.entry = resolvePluginPath(provider.procedure.entry);
		providers.set(provider.id, provider);
		const defKeys = Object.keys(provider.fieldDefs ?? {});
		registerPluginFieldDefs(provider.fieldDefs ?? {});
		const registered = cmd
			.providerRegister(definition(provider))
			.catch((e) => log.error(`[procedure] registering "${provider.id}" failed:`, e));
		trackDisposable(() => {
			providers.delete(provider.id);
			unregisterPluginFieldDefs(defKeys);
			void cmd
				.providerUnregister(provider.id)
				.catch((e) => log.error(`[procedure] unregistering "${provider.id}" failed:`, e));
		});
		await registered;
	},
	/** All registered providers. @unstable */
	list: (): Provider[] => [...providers.values()],
	/** The provider that produces a given extra field, if any. @unstable */
	forField: (field: string): Provider | undefined =>
		Provider.list().find((p) => p.fieldDefs != null && field in p.fieldDefs),
	/** Display labels for a field's partition keys. Month-of-year keys are numeric tokens and
	 *  become locale month names; otherwise falls back to the keys themselves when the field's
	 *  procedure has no `label` query or returns a non-matching array. @unstable */
	labels: async (field: string, keys: string[], key?: KeySpec): Promise<string[]> => {
		if (key?.kind === "datePart" && key.part === "monthOfYear")
			return keys.map((k) => partitionLabel(k, key));
		const procedure = Provider.forField(field)?.procedure;
		if (!procedure || keys.length === 0) return keys;
		try {
			const labels = await Procedure.query<unknown>(procedure, {
				op: "label",
				field,
				values: keys,
			});
			if (Array.isArray(labels) && labels.length === keys.length) {
				return labels.map((l, i) => (typeof l === "string" ? l : keys[i]));
			}
		} catch (e) {
			log.debug(`[procedure] ${field}: no label query (${e})`);
		}
		return keys;
	},
	/** Run registered providers over the locations `selector` matches and write their results
	 *  back. Resolves once every provider finishes, or on abort. @unstable */
	run: async <C extends readonly unknown[]>(
		runs: { [K in keyof C]: ProviderRun<C[K]> },
		selector: Selector,
		opts: RunOpts = {},
	): Promise<ProcedureOutcomes> => {
		const scheduled: Scheduled[] = [];
		for (const run of runs as readonly ProviderRun[]) {
			const p = run.provider;
			const fields = run.fields ?? Object.keys(p.fieldDefs ?? {});
			// A provider with `fieldDefs` and no field to produce has nothing to do; one with
			// no `fieldDefs` writes core columns and has nothing to deselect.
			if (p.fieldDefs && fields.length === 0) continue;
			if (p.procedure.prepare && !(await p.procedure.prepare())) continue;
			scheduled.push({
				id: p.id,
				label: p.label,
				item: {
					kind: "provider",
					id: p.id,
					fields,
					select: run.select ?? p.procedure.select ?? selector,
					config: run.config === undefined ? null : JSON.stringify(run.config),
					force: run.force,
				},
			});
		}
		return Procedure.drive(scheduled, opts);
	},
};
