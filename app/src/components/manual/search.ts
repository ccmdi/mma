import { search, snippet } from "@/lib/search";
import { MANUAL_INDEX } from "@/components/manual/manual-index.gen";

export interface ManualHit {
	id: string;
	title: string;
	snippet: string;
}

export function searchManual(query: string, limit = 8): ManualHit[] {
	if (!query.trim()) return [];
	return search(MANUAL_INDEX, query, (c) => [c.title, c.text])
		.slice(0, limit)
		.map((c) => ({ id: c.id, title: c.title, snippet: snippet(c.text, query) }));
}
