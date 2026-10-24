import { Tag } from "@/store/tag";
import { Edit } from "@/store/edit";
import type { TagSortMode } from "@/types";
import { colorForName } from "@/lib/util/color";
import { getSettings } from "@/store/settings";
import { shortestUniqueSuffixes } from "@/lib/util/paths";

/** Sort tags by the chosen mode: name, location count, or manual order. @api */
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

/** Color for a tag named `name`. An existing tag uses its stored color. @api */
export function tagColorFor(name: string, tags: Tag[]): string {
	const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
	return existing?.color ?? colorForName(name);
}

/** Tags staged on a location until it saves: existing tags by id, and typed names that Save creates. */
export interface PendingTags {
	ids: number[];
	names: string[];
}

/** Stage typed text as the existing tag it names, ignoring case, or as a name to create.
 *  Returns `pending` unchanged if already staged. @api */
export function addPendingTag(pending: PendingTags, name: string, tags: Tag[]): PendingTags {
	const lower = name.toLowerCase();
	const existing = tags.find((t) => t.name.toLowerCase() === lower);
	if (existing) {
		return pending.ids.includes(existing.id)
			? pending
			: { ...pending, ids: [...pending.ids, existing.id] };
	}
	return pending.names.some((n) => n.toLowerCase() === lower)
		? pending
		: { ...pending, names: [...pending.names, name] };
}

/** Stage the tag, or unstage it if it is already staged. @api */
export function togglePendingTag(pending: PendingTags, id: number): PendingTags {
	const ids = pending.ids.includes(id) ? pending.ids.filter((i) => i !== id) : [...pending.ids, id];
	return { ...pending, ids };
}

/** The tag ids pending tags save as, creating the typed names. A tag deleted meanwhile is left out. @api */
export async function pendingTagIds({ ids, names }: PendingTags): Promise<number[]> {
	const live = ids.filter((id) => Tag.get(id));
	if (!names.length) return live;
	const { keys } = await Edit.values(
		"tags",
		names.map((name) => ({ add: { id: 0, name } })),
	);
	return [...new Set([...live, ...keys])];
}

let suffixCache: { tags: Tag[]; suffixes: Map<string, string> } | null = null;

/** Display label for a tag name. In tree view with `truncateTagPaths` on, collapses
 *  the `/`-path to its shortest unique suffix; otherwise returns the name verbatim. @api */
export function displayTagName(name: string): string {
	const s = getSettings();
	if (s.tagViewMode !== "tree" || !s.truncateTagPaths) return name;
	const tags = Tag.visible();
	if (!suffixCache || suffixCache.tags !== tags) {
		suffixCache = { tags, suffixes: shortestUniqueSuffixes(tags.map((t) => t.name)) };
	}
	return suffixCache.suffixes.get(name) ?? name;
}
