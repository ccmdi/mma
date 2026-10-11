import { Tag } from "@/store/tag";
import type { TagSortMode } from "@/types";
import { colorForName } from "@/lib/util/color";
import { getSettings } from "@/store/settings";
import { shortestUniqueSuffixes } from "@/lib/data/tagPaths";

/** Sort tags by the chosen mode: name, location count, or manual order. */
export function sortTagsByMode(
	tags: Tag[],
	mode: TagSortMode,
	counts: Record<number, number>,
): Tag[] {
	const sorted = [...tags];
	if (mode === "name") return sorted.sort((a, b) => a.name.localeCompare(b.name));
	if (mode === "amount") return sorted.sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0));
	return sorted.sort(
		(a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name),
	);
}

/** Color for a tag named `name`. An existing tag uses its stored color. */
export function tagColorFor(name: string, tags: Tag[]): string {
	const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
	return existing?.color ?? colorForName(name);
}

/** Add a name to a staged list: dedup case-insensitively, normalizing to an existing tag's
 *  canonical casing. Returns the original array unchanged if already present. */
export function appendTagName(pending: string[], name: string, tags: Tag[]): string[] {
	const lower = name.toLowerCase();
	if (pending.some((n) => n.toLowerCase() === lower)) return pending;
	const existing = tags.find((t) => t.name.toLowerCase() === lower);
	return [...pending, existing ? existing.name : name];
}

let suffixCache: { tags: Tag[]; suffixes: Map<string, string> } | null = null;

/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. */
export function displayTagName(name: string): string {
	const s = getSettings();
	if (s.tagViewMode !== "tree" || !s.truncateTagPaths) return name;
	const tags = Tag.visible();
	if (!suffixCache || suffixCache.tags !== tags) {
		suffixCache = { tags, suffixes: shortestUniqueSuffixes(tags.map((t) => t.name)) };
	}
	return suffixCache.suffixes.get(name) ?? name;
}
