import type { Tag } from "@/bindings.gen";

/** The tags for `names`, in the order the names were given, so a tag list a user built
 *  keeps its order. Names without a tag are skipped. */
export function tagsNamed(names: string[], tags: Tag[]): Tag[] {
	const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t]));
	const out: Tag[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		const key = name.toLowerCase();
		const tag = byName.get(key);
		if (tag && !seen.has(key)) {
			seen.add(key);
			out.push(tag);
		}
	}
	return out;
}
