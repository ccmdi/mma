import type { Selector } from "@/types";
import {
	noWork,
	procedureEntry,
	runProviders,
	type BatchOutcome,
	type BulkOpts,
} from "@/lib/data/procedures";
import { panoResolveProvider } from "@/lib/sv/providers";
import { registerProvider, type Provider } from "@/lib/data/fieldDefs";
import { msg } from "@/lib/i18n";

export type RoadDirection = "forwards" | "backwards";

export interface HeadingRoadConfig {
	direction: RoadDirection;
}

/** Pan a location's heading along the road. The driving direction is the pano's
 *  `centerHeading`; "forwards" faces it, "backwards" faces the opposite. */
export const headingRoadProvider: Provider<unknown, HeadingRoadConfig> = {
	id: "headingRoad",
	label: msg("Pan heading along road"),
	requires: ["panoId"],
	procedure: {
		entry: procedureEntry("headingRoad"),
		batch: { mode: "dedupeBy", key: "panoId" },
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
		[{ provider: panoResolveProvider }, { provider: headingRoadProvider, config: { direction } }],
		selector,
		opts,
	);
	return result.headingRoad ?? noWork();
}
