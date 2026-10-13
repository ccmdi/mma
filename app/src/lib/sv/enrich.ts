import { Store } from "@/store/store";
import { getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import type { ProcedureOutcomes, RunOpts } from "@/lib/data/procedure";
import { Provider } from "@/lib/data/provider";
import { enrichRuns, panoResolveProvider } from "@/lib/sv/providers";
import { all, any, lacks } from "@/store/selections";
import type { Selector } from "@/types";

export async function enrich(
	selector: Selector,
	{ resolve = true, ...opts }: RunOpts & { resolve?: boolean } = {},
): Promise<ProcedureOutcomes> {
	const map = Store.get().map;
	if (!map) return {};
	const fields = map.settings.enrichFields ?? getDefaultEnrichKeys();
	const runs = enrichRuns(fields);
	if (resolve) {
		runs.unshift({
			provider: panoResolveProvider,
			select: opts.force ? undefined : all(selector, any(...fields.map(lacks))),
			force: false,
		});
	}
	return Provider.run(runs, selector, opts);
}
