/** The share of a distribution sitting where a perfectly even one would put it: one
 *  minus the total variation distance from equal per-cell counts. 1 is perfectly even;
 *  near zero means almost everything sits in a few cells. Null until there are at
 *  least two cells and one count. */
export function spreadIndex(counts: number[]): number | null {
	const n = counts.length;
	if (n < 2) return null;
	const total = counts.reduce((a, b) => a + b, 0);
	if (total === 0) return null;
	const even = total / n;
	let deviation = 0;
	for (const c of counts) deviation += Math.abs(c - even);
	return 1 - deviation / (2 * total);
}
