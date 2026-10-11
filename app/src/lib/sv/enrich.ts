import { Store } from "@/store/store";
import { getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { runProviders, type ProviderOutcomes, type RunOpts } from "@/lib/data/procedures";
import { enrichRuns, panoResolveProvider } from "@/lib/sv/providers";
import { all, any, lacks } from "@/store/selections";
import type { Selector } from "@/types";

export async function enrich(
	selector: Selector,
	{ resolve = true, ...opts }: RunOpts & { resolve?: boolean } = {},
): Promise<ProviderOutcomes> {
	const map = Store.get().map;
	if (!map) return {};
	const fields = map.settings.enrichFields ?? getDefaultEnrichKeys();
	const runs = enrichRuns(fields);
	if (resolve) {
		const provider = opts.force
			? panoResolveProvider
			: {
					...panoResolveProvider,
					procedure: {
						...panoResolveProvider.procedure,
						select: all(selector, any(...fields.map(lacks))),
					},
				};
		runs.unshift({ provider, force: false });
	}
	return runProviders(runs, selector, opts);
}
