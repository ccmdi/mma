import { KNOWN_FIELDS } from "@/bindings.consts";
import type { FieldDef } from "@/bindings.gen";
import { Provider } from "@/lib/data/provider";

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
	const providerOptions = Provider.list().flatMap((p) =>
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

/** The enrichment fields `key`'s provider reads. @unstable */
export function enrichInputs(key: string): string[] {
	const selectable = new Set(getAllEnrichKeys());
	return (Provider.forField(key)?.requires ?? []).filter((input) => selectable.has(input));
}

/** The fields enrichment fetches for `enrichFields` (the default set when null): the chosen
 *  ones and every field they read, so no field runs without its inputs. @unstable */
export function enabledEnrichKeys(enrichFields?: string[] | null): string[] {
	const enabled = new Set<string>();
	const visit = (key: string) => {
		if (enabled.has(key)) return;
		enabled.add(key);
		enrichInputs(key).forEach(visit);
	};
	(enrichFields ?? getDefaultEnrichKeys()).forEach(visit);
	return [...enabled];
}

/** True when enrichment fetches `key` for the given enrichment set. @unstable */
export function isFieldEnabled(enrichFields: string[] | null, key: string): boolean {
	return enabledEnrichKeys(enrichFields).includes(key);
}
