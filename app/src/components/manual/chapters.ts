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
	title: string;
	Body: ChapterBody;
}

export interface Part {
	title: string;
	chapters: Chapter[];
}

function ordered(segment: string): { order: number; name: string } {
	const m = segment.match(/^(\d+)-(.+)$/);
	if (!m) throw new Error(`manual: "${segment}" needs a numeric NN- prefix`);
	return { order: Number(m[1]), name: m[2] };
}

// Chapter content lives in ./chapters/NN-part/NN-id.mdx. Numeric prefixes set reading order;
// the folder name (dashes as spaces) is the part title and the file name is the chapter id.
// Each file exports `title` and a default body component; the manual view and search both
// derive from this one compiled glob -- the single source of truth.
const modules = import.meta.glob<{ default: ChapterBody; title?: string }>("./chapters/*/*.mdx", {
	eager: true,
});

const entries = Object.entries(modules).map(([p, m]) => {
	const [folder, file] = p.split("/").slice(-2);
	const part = ordered(folder);
	const chapter = ordered(file.replace(/\.mdx$/, ""));
	return { part, chapter, Body: m.default, title: m.title ?? chapter.name };
});

export const PARTS: Part[] = [...new Set(entries.map((e) => e.part.order))]
	.sort((a, b) => a - b)
	.map((order) => {
		const inPart = entries.filter((e) => e.part.order === order);
		const name = inPart[0].part.name.replace(/-/g, " ");
		return {
			title: name[0].toUpperCase() + name.slice(1),
			chapters: inPart
				.sort((a, b) => a.chapter.order - b.chapter.order)
				.map((e) => ({ id: e.chapter.name, title: e.title, Body: e.Body })),
		};
	});

export const CHAPTERS: Chapter[] = PARTS.flatMap((p) => p.chapters);

const duplicate = CHAPTERS.find((c, i) => CHAPTERS.findIndex((o) => o.id === c.id) !== i);
if (duplicate) throw new Error(`manual: chapter id "${duplicate.id}" is used twice`);

export function chapterTitle(id: string): string {
	return CHAPTERS.find((c) => c.id === id)?.title ?? id;
}
