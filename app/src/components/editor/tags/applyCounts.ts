export interface Preview {
	total: number;
	have: number;
	groups: number;
	covered: number;
}

/** The tags and tagged locations Apply produces: one tag per group, empty bins included, plus
 *  one for the ungrouped rest when those are tagged too. */
export function applyCounts(preview: Preview, tagMissing: boolean) {
	const ungrouped = tagMissing ? preview.total - preview.covered : 0;
	return {
		tags: preview.groups + (ungrouped > 0 ? 1 : 0),
		locations: preview.covered + ungrouped,
	};
}
