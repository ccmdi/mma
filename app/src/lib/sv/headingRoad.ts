import type { Selector } from "@/bindings.gen";
import {
	noWork,
	procedureEntry,
	runProviders,
	type BatchOutcome,
	type BulkOpts,
} from "@/lib/data/procedures";
import { panoResolveProvider } from "@/lib/sv/enrich";
import { GET_METADATA_INFLIGHT } from "@/lib/sv/constants";
import { registerProvider, type Provider } from "@/lib/data/fieldDefs";
import { msg } from "@/lib/i18n";

export type RoadDirection = "forwards" | "backwards";

export interface HeadingRoadConfig {
	direction: RoadDirection;
}

/** Pan a location's heading along the road. The driving direction is GetMetadata's
 *  `pov.heading` (this source has no `tiles.centerHeading`); "forwards" faces it,
 *  "backwards" faces the opposite. */
export const headingRoadProvider: Provider = {
	id: "headingRoad",
	label: msg("Pan heading along road"),
	requires: ["panoId"],
	procedure: {
		entry: procedureEntry("headingRoad"),
		batch: { mode: "dedupeBy", key: "panoId" },
		retry: { attempts: 3, on: [429, 500, 503] },
		inflight: GET_METADATA_INFLIGHT,
	},
};

registerProvider(headingRoadProvider);

/** Pan every heading in the selector along the road. */
export async function bulkPanHeading(
	selector: Selector,
	direction: RoadDirection,
	opts: BulkOpts = {},
): Promise<BatchOutcome> {
	const result = await runProviders(
		[
			{ provider: panoResolveProvider },
			{ provider: headingRoadProvider, config: { direction } satisfies HeadingRoadConfig },
		],
		selector,
		opts,
	);
	return result.headingRoad ?? noWork();
}
