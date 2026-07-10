// Statistical effect-size measures for selection disambiguation. Pure functions,
// ported 1:1 from the Rust reference; unit-tested in stats.test.ts.

const TWO_PI = Math.PI * 2;

/** Epsilon-squared effect size from the tie-corrected Kruskal-Wallis H statistic.
 *  Rank-based, robust to skew/scale. `null` if fewer than two groups have data. [0,1]. */
export function kruskalEps2(perGroup: number[][]): number | null {
	const nonempty = perGroup.filter((g) => g.length > 0).length;
	if (nonempty < 2) return null;

	const all: { v: number; g: number }[] = [];
	perGroup.forEach((vals, g) => vals.forEach((v) => all.push({ v, g })));
	const n = all.length;
	if (n < 3) return 0;
	all.sort((a, b) => a.v - b.v);

	const rankSums = new Array(perGroup.length).fill(0);
	let tieCorrection = 0; // sum of (t^3 - t)
	let i = 0;
	while (i < n) {
		let j = i + 1;
		while (j < n && all[j].v === all[i].v) j++;
		const t = j - i;
		const avgRank = (i + 1 + j) / 2; // 1-based average rank for the tied block
		for (let k = i; k < j; k++) rankSums[all[k].g] += avgRank;
		tieCorrection += t * t * t - t;
		i = j;
	}

	let h = 0;
	perGroup.forEach((vals, g) => {
		if (vals.length > 0) h += (rankSums[g] * rankSums[g]) / vals.length;
	});
	h = (12 / (n * (n + 1))) * h - 3 * (n + 1);

	const denom = 1 - tieCorrection / (n * n * n - n);
	if (denom > 0) h /= denom;
	if (h <= 0) return 0;

	const eps2 = h / (n - 1); // epsilon-squared = H / (n - 1)
	return clamp01(eps2);
}

/** One-way circular ANOVA effect size: between-group share of concentration.
 *  Handles wrap-around (350deg and 10deg are close). `null` if <2 groups have data. [0,1]. */
export function circularEta2(perGroup: number[][], period: number): number | null {
	const nonempty = perGroup.filter((g) => g.length > 0).length;
	if (nonempty < 2 || period === 0) return null;

	let sumR = 0; // sum of per-group resultant lengths
	let totalC = 0;
	let totalS = 0;
	let n = 0;
	for (const vals of perGroup) {
		if (vals.length === 0) continue;
		const [c, s] = sincosSums(vals, period);
		sumR += Math.sqrt(c * c + s * s);
		totalC += c;
		totalS += s;
		n += vals.length;
	}
	const r = Math.sqrt(totalC * totalC + totalS * totalS);
	const denom = n - r;
	if (denom <= 1e-9) return 0;
	return clamp01((sumR - r) / denom);
}

function sincosSums(vals: number[], period: number): [number, number] {
	let c = 0;
	let s = 0;
	for (const v of vals) {
		const theta = (v / period) * TWO_PI;
		c += Math.cos(theta);
		s += Math.sin(theta);
	}
	return [c, s];
}

/** Mean angle (original units, [0, period)) and concentration (resultant/n, [0,1]). */
export function circularSummary(
	vals: number[],
	period: number,
): { mean: number; concentration: number } {
	const [c, s] = sincosSums(vals, period);
	const n = vals.length;
	let theta = Math.atan2(s, c);
	if (theta < 0) theta += TWO_PI;
	return { mean: (theta / TWO_PI) * period, concentration: Math.sqrt(c * c + s * s) / n };
}

/** Bias-corrected (Bergsma) Cramer's V over a groups-by-category table. [0,1]. */
export function cramersV(perGroup: Map<string, number>[]): number | null {
	const categories = new Set<string>();
	for (const m of perGroup) for (const k of m.keys()) categories.add(k);
	const cats = [...categories];
	const rowTotals = perGroup.map((m) => sum([...m.values()]));
	const n = sum(rowTotals);
	const nonemptyRows = rowTotals.filter((r) => r > 0).length;
	if (nonemptyRows < 2 || cats.length < 2 || n < 1) return 0;

	const colTotals = cats.map((c) => sum(perGroup.map((m) => m.get(c) ?? 0)));

	let chi2 = 0;
	perGroup.forEach((m, gi) => {
		if (rowTotals[gi] === 0) return;
		cats.forEach((cat, ci) => {
			const observed = m.get(cat) ?? 0;
			const expected = (rowTotals[gi] * colTotals[ci]) / n;
			if (expected > 0) {
				const d = observed - expected;
				chi2 += (d * d) / expected;
			}
		});
	});

	const phi2 = chi2 / n;
	const k = cats.length;
	const r = nonemptyRows;
	const phi2Corr = Math.max(0, phi2 - ((k - 1) * (r - 1)) / (n - 1));
	const kCorr = k - ((k - 1) * (k - 1)) / (n - 1);
	const rCorr = r - ((r - 1) * (r - 1)) / (n - 1);
	const denom = Math.min(kCorr - 1, rCorr - 1);
	if (denom <= 0) return 0;
	return clamp01(Math.sqrt(phi2Corr / denom));
}

/** Coverage divergence: Cramer's V on a present/absent x group table. */
export function coverageV(groupSizes: number[], present: number[]): number {
	const perGroup: Map<string, number>[] = groupSizes.map((n, i) => {
		const p = present[i];
		return new Map([
			["present", p],
			["absent", Math.max(0, n - p)],
		]);
	});
	return cramersV(perGroup) ?? 0;
}

/** [p25, median, p75] via linear-interpolated percentiles. */
export function quartiles(vals: number[]): [number, number, number] {
	const v = [...vals].sort((a, b) => a - b);
	return [percentile(v, 0.25), percentile(v, 0.5), percentile(v, 0.75)];
}

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return NaN;
	if (sorted.length === 1) return sorted[0];
	const pos = q * (sorted.length - 1);
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

function sum(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0);
}
