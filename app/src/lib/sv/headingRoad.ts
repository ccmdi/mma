import type { Selector } from "@/types";
import { Procedure, type BatchOutcome, type BulkOpts } from "@/lib/data/procedure";
import { Provider } from "@/lib/data/provider";
import { headingRoadProvider, panoResolveProvider, type RoadDirection } from "@/lib/sv/providers";

/** Pan every heading in the selector along the road. */
export async function bulkPanHeading(
	selector: Selector,
	direction: RoadDirection,
	opts: BulkOpts = {},
): Promise<BatchOutcome> {
	const result = await Provider.run(
		[{ provider: panoResolveProvider }, { provider: headingRoadProvider, config: { direction } }],
		selector,
		opts,
	);
	return result.headingRoad ?? Procedure.noWork();
}
