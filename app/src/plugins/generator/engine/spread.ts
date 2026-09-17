/** How evenly a set of per-cell counts is distributed: 1 is perfectly even, values near
 *  zero mean almost everything sits in a few cells. One minus the Gini coefficient;
 *  null until there are at least two cells and one count. */
export function spreadIndex(counts: number[]): number | null {
	const n = counts.length;
	if (n < 2) return null;
	const total = counts.reduce((a, b) => a + b, 0);
	if (total === 0) return null;
	const sorted = [...counts].sort((a, b) => a - b);
	let weighted = 0;
	for (let i = 0; i < n; i++) weighted += (i + 1) * sorted[i];
	const gini = (2 * weighted) / (n * total) - (n + 1) / n;
	return 1 - gini;
}
