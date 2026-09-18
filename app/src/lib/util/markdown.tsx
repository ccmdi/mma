import type { ReactNode } from "react";
import clsx from "clsx";

function renderInline(text: string, kb: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
	let last = 0;
	let i = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		const k = `${kb}-${i++}`;
		if (m[1]) nodes.push(<strong key={k}>{m[1]}</strong>);
		else if (m[2]) nodes.push(<em key={k}>{m[2]}</em>);
		else if (m[3]) nodes.push(<code key={k}>{m[3]}</code>);
		else
			nodes.push(
				<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer">
					{m[4]}
				</a>,
			);
		last = re.lastIndex;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

function renderBlocks(md: string): ReactNode[] {
	const out: ReactNode[] = [];
	let list: ReactNode[] | null = null;
	let para: string[] = [];
	let key = 0;
	const flushPara = () => {
		if (para.length) {
			out.push(<p key={`b${key++}`}>{renderInline(para.join(" "), `b${key}`)}</p>);
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			out.push(<ul key={`b${key++}`}>{list}</ul>);
			list = null;
		}
	};
	for (const raw of md.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			out.push(<h4 key={`b${key++}`}>{renderInline(heading[1], `b${key}`)}</h4>);
		} else if (bullet) {
			flushPara();
			(list ??= []).push(<li key={`b${key++}`}>{renderInline(bullet[1], `b${key}`)}</li>);
		} else if (line === "") {
			flushPara();
			flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return out;
}

/** Release-notes markdown: headings, bullet lists, paragraphs, **bold**, *italic*, `code` and links. */
export function Markdown({ source, className }: { source: string; className?: string }) {
	return <div className={clsx("markdown", className)}>{renderBlocks(source)}</div>;
}
