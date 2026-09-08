/** Central text search. Every user-facing search matches through here so behavior
 *  is identical everywhere: case- and accent-folded, whitespace-tokenized (every
 *  token must land), ranked exact > prefix > word start > substring > subsequence.
 *
 *  Three surfaces over one scorer:
 *  - `matches` — predicate for lists that filter in place and keep their own order
 *  - `search`  — ranked results for pickers and suggestion lists
 *  - `score`   — the raw scorer, for hosts that rank per item themselves (cmdk)
 *  - `snippet` — an excerpt of a matched body, for results that show context
 */

export type SearchTexts = readonly (string | null | undefined)[];

const fold = (s: string) =>
	s
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();

const tokenize = (query: string) => fold(query).split(/\s+/).filter(Boolean);

const WORD_BREAK = /[^\p{L}\p{N}]/u;

function tokenScore(hay: string, token: string, fuzzy: boolean): number {
	const at = hay.indexOf(token);
	if (at === 0) return token.length === hay.length ? 1 : 0.9;
	if (at > 0) return WORD_BREAK.test(hay[at - 1]) ? 0.8 : 0.5;
	if (!fuzzy) return 0;
	let from = -1;
	let to = -1;
	let i = 0;
	for (let j = 0; j < hay.length && i < token.length; j++) {
		if (hay[j] !== token[i]) continue;
		if (i === 0) from = j;
		to = j;
		i++;
	}
	if (i < token.length) return 0;
	return (0.3 * token.length) / (to - from + 1);
}

const SECONDARY = 0.7;

/** `texts[0]` is the primary field; later texts match at a discount. */
function scoreFolded(
	queryTokens: readonly string[],
	texts: readonly string[],
	fuzzy = true,
): number {
	let total = 0;
	for (const token of queryTokens) {
		let best = 0;
		for (let i = 0; i < texts.length; i++) {
			const s = tokenScore(texts[i], token, fuzzy) * (i === 0 ? 1 : SECONDARY);
			if (s > best) best = s;
		}
		if (best === 0) return 0;
		total += best;
	}
	return total / queryTokens.length;
}

function foldTexts(texts: SearchTexts): string[] {
	const out: string[] = [];
	for (const t of texts) if (t) out.push(fold(t));
	return out;
}

/** 0 = no match; otherwise (0, 1], higher is better. An empty query matches everything. */
export function score(query: string, texts: SearchTexts): number {
	const tokens = tokenize(query);
	if (tokens.length === 0) return 1;
	return scoreFolded(tokens, foldTexts(texts));
}

/** Predicate contexts have no ranking to bury weak hits, so every token must
 *  appear as an actual substring — no subsequence matching here. */
export function matches(query: string, ...texts: SearchTexts): boolean {
	const tokens = tokenize(query);
	return tokens.length === 0 || scoreFolded(tokens, foldTexts(texts), false) > 0;
}

const indexes = new WeakMap<readonly unknown[], string[][]>();

/** Ranked search over a collection. Folded texts are computed once per `items`
 *  array (identity-keyed), so a stable array indexes once for its lifetime and
 *  every keystroke after only scores; a replaced array re-indexes, which is the
 *  invalidation. `texts` must therefore be pure per item. Ties keep source order. */
export function search<T>(
	items: readonly T[],
	query: string,
	texts: (item: T) => SearchTexts,
): T[] {
	const tokens = tokenize(query);
	if (tokens.length === 0) return items.slice();
	let folded = indexes.get(items);
	if (!folded) {
		folded = items.map((item) => foldTexts(texts(item)));
		indexes.set(items, folded);
	}
	const scored: [T, number][] = [];
	for (let i = 0; i < items.length; i++) {
		const s = scoreFolded(tokens, folded[i]);
		if (s > 0) scored.push([items[i], s]);
	}
	scored.sort((a, b) => b[1] - a[1]);
	return scored.map(([item]) => item);
}

/** A short excerpt of `text` centred on its earliest query term (positioned on the raw text,
 *  so an accent-only match falls back to the head). */
export function snippet(text: string, query: string): string {
	const lower = text.toLowerCase();
	let pos = -1;
	for (const token of tokenize(query)) {
		const at = lower.indexOf(token);
		if (at !== -1 && (pos === -1 || at < pos)) pos = at;
	}
	if (pos === -1) return text.slice(0, 120).trim() + (text.length > 120 ? "…" : "");
	const start = Math.max(0, pos - 50);
	const end = Math.min(text.length, pos + 90);
	let out = text.slice(start, end).trim();
	if (start > 0) out = "…" + out;
	if (end < text.length) out = out + "…";
	return out;
}
