import type { ReactElement } from "react";

export type ChapterBody = (props: { components?: Record<string, unknown> }) => ReactElement;

/** One chapter as the build-time search index stores it (see indexSource.ts). */
export interface ChapterText {
	id: string;
	title: string;
	text: string;
}

export interface Chapter {
	id: string;
	order: number;
	title: string;
	Body: ChapterBody;
}

export function chapterIdFromPath(p: string): string {
	return p
		.slice(p.lastIndexOf("/") + 1)
		.replace(/^\d+-/, "")
		.replace(/\.mdx$/, "");
}

function chapterOrder(p: string): number {
	const m = p.slice(p.lastIndexOf("/") + 1).match(/^(\d+)-/);
	return m ? Number(m[1]) : 0;
}

// Chapter content lives in ./chapters/*.mdx, named `NN-id.mdx` (the numeric prefix sets
// reading order, the remainder is the chapter id). Each file exports `title` and a default
// body component; the manual view and search both derive from this one compiled glob -- the
// single source of truth.
const modules = import.meta.glob<{ default: ChapterBody; title?: string }>("./chapters/*.mdx", {
	eager: true,
});

export const CHAPTERS: Chapter[] = Object.entries(modules)
	.map(([p, m]) => ({
		id: chapterIdFromPath(p),
		order: chapterOrder(p),
		title: m.title ?? chapterIdFromPath(p),
		Body: m.default,
	}))
	.sort((a, b) => a.order - b.order);

export function chapterTitle(id: string): string {
	return CHAPTERS.find((c) => c.id === id)?.title ?? id;
}
