export interface Preview {
	total: number;
	have: number;
	groupSizes: number[];
}

/** The tags and tagged locations Apply produces: one tag per group, empty bins included, plus
 *  one for the ungrouped rest when those are tagged too. */
export function applyCounts(preview: Preview, tagMissing: boolean) {
	const grouped = preview.groupSizes.reduce((a, n) => a + n, 0);
	const ungrouped = tagMissing ? preview.total - grouped : 0;
	return {
		tags: preview.groupSizes.length + (ungrouped > 0 ? 1 : 0),
		locations: grouped + ungrouped,
	};
}
