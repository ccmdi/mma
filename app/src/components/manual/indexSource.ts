// Build-time entry for `gen:manual-index`; nothing imports this at runtime. Rendering the
// compiled chapters keeps component-injected prose (cross-reference titles, captions) in the index.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHAPTERS, type ChapterBody, type ChapterText } from "@/components/manual/chapters";
import { MANUAL_COMPONENTS } from "@/components/manual/components";

function chapterText(Body: ChapterBody): string {
	return renderToStaticMarkup(createElement(Body, { components: MANUAL_COMPONENTS }))
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

export function buildIndex(): ChapterText[] {
	return CHAPTERS.map((c) => ({ id: c.id, title: c.title, text: chapterText(c.Body) }));
}
