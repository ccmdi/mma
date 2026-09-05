const { storage, getVisibleTags, updateTags } = MMA;

export interface TaxonInfo {
	id: number;
	name: string;
	commonName: string;
	rank: string;
}

export interface SortOptions {
	lang: string;
	deep: boolean;
	commonNames: boolean;
}

const API_DELAY = 350;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DEEP_RANKS = [
	"kingdom", "subkingdom", "phylum", "subphylum",
	"superclass", "class", "subclass", "infraclass",
	"superorder", "order", "suborder", "infraorder",
	"superfamily", "epifamily", "family", "subfamily",
	"supertribe", "tribe", "subtribe",
	"genus", "genushybrid", "subgenus", "section", "subsection", "complex",
];
const FLAT_RANKS = ["order", "family"];

const RANK_RE = new RegExp(`^(${DEEP_RANKS.join("|")})\\s+`, "i");
const EXACT_RANK_RE = new RegExp(`^(${DEEP_RANKS.join("|")})$`, "i");

function cleanRankPrefix(s: string): string {
	return s.trim().replace(RANK_RE, "").trim();
}

function hasNonAscii(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) > 127) return true;
	}
	return false;
}

export function extractScientificName(tagName: string): string {
	const cleanTag = tagName.replace(/\[.*?\]/g, "").trim();
	const baseName = cleanTag.replace(/\s+(var\.|ssp\.|subsp\.|f\.|forma)\s+.*$/i, "").trim();

	const match = baseName.match(/^(.*?)\s*\((.*?)\)/);
	if (match) {
		const p1raw = match[1].trim();
		const p2raw = match[2].trim();

		const p1IsRank = EXACT_RANK_RE.test(p1raw);
		const p2IsRank = EXACT_RANK_RE.test(p2raw);
		if (p2IsRank && !p1IsRank) return cleanRankPrefix(p1raw);
		if (p1IsRank && !p2IsRank) return cleanRankPrefix(p2raw);

		const p1 = cleanRankPrefix(p1raw);
		const p2 = cleanRankPrefix(p2raw);

		const isBinomial = (s: string) => /^[A-Z][a-z-]+[\s×]+[a-z-]+/.test(s);
		if (isBinomial(p2)) return p2;
		if (isBinomial(p1)) return p1;

		if (!hasNonAscii(p2) && hasNonAscii(p1)) return p2;
		if (!hasNonAscii(p1) && hasNonAscii(p2)) return p1;

		return p2.length > 0 ? p2 : p1;
	}

	const noParen = cleanRankPrefix(baseName);
	if (EXACT_RANK_RE.test(noParen)) return "";
	return noParen;
}

function getCandidates(tagName: string, primary: string): string[] {
	const parenMatch = tagName.replace(/\[.*?\]/g, "").match(/\(([^)]+)\)/);
	const parenContent = parenMatch ? parenMatch[1].trim() : null;
	const words = primary.split(/\s+/).filter(Boolean);
	const twoWords = words.length >= 2 ? words.slice(0, 2).join(" ") : null;
	const genusOnly = words.length >= 1 ? words[0] : null;

	const seen = new Set<string>();
	return [primary, parenContent, twoWords, genusOnly].filter((c): c is string => {
		if (!c || c.length < 2 || seen.has(c)) return false;
		seen.add(c);
		return true;
	});
}

async function fetchTaxaSearch(query: string, lang: string): Promise<{ ancestorIds: number[] } | null> {
	const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(query)}&per_page=1&locale=${lang}`;
	const res = await fetch(url);
	if (!res.ok) return null;
	const data = await res.json();
	const result = data.results?.[0];
	if (!result?.ancestor_ids) return null;
	return { ancestorIds: result.ancestor_ids };
}

async function fetchTaxonDetails(ids: number[], lang: string): Promise<Map<number, TaxonInfo>> {
	const out = new Map<number, TaxonInfo>();
	for (let i = 0; i < ids.length; i += 30) {
		const chunk = ids.slice(i, i + 30);
		const url = `https://api.inaturalist.org/v1/taxa/${chunk.join(",")}?locale=${lang}`;
		try {
			const res = await fetch(url);
			if (!res.ok) continue;
			const data = await res.json();
			for (const t of data.results ?? []) {
				let common = t.preferred_common_name || t.english_common_name || "";
				if (common) common = common.charAt(0).toUpperCase() + common.slice(1);
				out.set(t.id, { id: t.id, name: t.name, commonName: common, rank: t.rank });
			}
		} catch { /* continue */ }
		if (i + 30 < ids.length) await delay(API_DELAY);
	}
	return out;
}

function buildFolderSegment(taxon: TaxonInfo, useCommon: boolean, seenCommons: Set<string>): string {
	const rankCap = taxon.rank.charAt(0).toUpperCase() + taxon.rank.slice(1);

	if (useCommon && taxon.commonName) {
		const cl = taxon.commonName.toLowerCase();
		const nl = taxon.name.toLowerCase();
		const rl = rankCap.toLowerCase();
		if (cl === nl || new RegExp("\\b" + rl + "\\b").test(cl) || seenCommons.has(cl)) {
			return `${rankCap} ${taxon.name}`;
		}
		seenCommons.add(cl);
		return `${taxon.commonName} (${rankCap} ${taxon.name})`;
	}
	return `${rankCap} ${taxon.name}`;
}

export interface SortProgress {
	phase: string;
	current: number;
	total: number;
	detail?: string;
}

export interface SortResult {
	sorted: number;
	skipped: number;
	created: number;
}

export async function sortTagsByTaxonomy(
	opts: SortOptions,
	onProgress?: (p: SortProgress) => void,
	signal?: AbortSignal,
): Promise<SortResult> {
	const store = storage("inaturalist");
	const tags = getVisibleTags();
	if (tags.length === 0) return { sorted: 0, skipped: 0, created: 0 };

	const ancestorCacheKey = "taxo_ancestors";
	const detailCacheKey = `taxo_details_${opts.lang}`;
	const ancestorCache: Record<string, number[]> = store.get(ancestorCacheKey, {});
	const detailCache: Record<string, TaxonInfo> = store.get(detailCacheKey, {});

	const ranksToUse = new Set(opts.deep ? DEEP_RANKS : FLAT_RANKS);
	const allNeededIds = new Set<number>();

	const tagAncestors = new Map<number, { ancestors: number[]; resolvedName: string }>();

	for (let i = 0; i < tags.length; i++) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const tag = tags[i];
		const leafName = tag.name.split("/").pop() ?? tag.name;
		const sciName = extractScientificName(leafName);
		if (!sciName) {
			onProgress?.({ phase: "Scanning", current: i + 1, total: tags.length, detail: `Skipped: ${leafName}` });
			continue;
		}

		const candidates = getCandidates(leafName, sciName);
		let found: { ids: number[]; resolvedName: string } | null = null;

		for (const c of candidates) {
			if (ancestorCache[c]) {
				found = { ids: ancestorCache[c], resolvedName: c };
				break;
			}
		}

		if (!found) {
			for (const c of candidates) {
				onProgress?.({ phase: "Querying iNaturalist", current: i + 1, total: tags.length, detail: c });
				const result = await fetchTaxaSearch(c, opts.lang);
				if (result) {
					ancestorCache[c] = result.ancestorIds;
					found = { ids: result.ancestorIds, resolvedName: c };
					break;
				}
				await delay(API_DELAY);
			}
		}

		if (found) {
			tagAncestors.set(tag.id, { ancestors: found.ids, resolvedName: found.resolvedName });
			for (const id of found.ids) allNeededIds.add(id);
		} else {
			onProgress?.({ phase: "Scanning", current: i + 1, total: tags.length, detail: `Not found: ${leafName}` });
		}
	}

	store.set(ancestorCacheKey, ancestorCache);

	const missingDetailIds = [...allNeededIds].filter((id) => !detailCache[String(id)]);
	if (missingDetailIds.length > 0) {
		onProgress?.({ phase: "Fetching taxonomy details", current: 0, total: missingDetailIds.length });
		const details = await fetchTaxonDetails(missingDetailIds, opts.lang);
		for (const [id, info] of details) {
			detailCache[String(id)] = info;
		}
		store.set(detailCacheKey, detailCache);
	}

	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

	const renames: { id: number; name: string }[] = [];
	let skipped = 0;

	for (const tag of tags) {
		const entry = tagAncestors.get(tag.id);
		if (!entry) {
			skipped++;
			continue;
		}

		const leafName = tag.name.split("/").pop() ?? tag.name;
		const seenCommons = new Set<string>();
		const pathSegments: string[] = [];

		for (const ancestorId of entry.ancestors) {
			const taxon = detailCache[String(ancestorId)];
			if (!taxon || !ranksToUse.has(taxon.rank)) continue;
			pathSegments.push(buildFolderSegment(taxon, opts.commonNames, seenCommons));
		}

		if (pathSegments.length === 0) {
			pathSegments.push("Unclassified");
		}

		const newName = [...pathSegments, leafName].join("/");
		if (newName !== tag.name) {
			renames.push({ id: tag.id, name: newName });
		}
	}

	if (renames.length > 0) {
		onProgress?.({ phase: "Renaming tags", current: 0, total: renames.length });
		await updateTags(renames.map((r) => ({ id: r.id, patch: { name: r.name } })));
	}

	return { sorted: renames.length, skipped, created: 0 };
}

export function clearTaxonomyCache() {
	const store = storage("inaturalist");
	for (const key of store.keys()) {
		if (key.startsWith("taxo_")) store.remove(key);
	}
}
