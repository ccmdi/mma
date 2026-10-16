import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { ImageLightbox } from "@/components/primitives/ImageLightbox";

const INLINE =
	/`([^`]+)`|!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|<img\s[^>]*?src="(https?:\/\/[^"]+)"[^>]*>|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function link(key: string, href: string, children: ReactNode) {
	return (
		<a key={key} href={href} target="_blank" rel="noopener noreferrer">
			{children}
		</a>
	);
}

/** A fixed-size thumbnail, so loading it moves nothing, that opens the image large. */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="markdown__image" onClick={() => setOpen(true)}>
				<img src={src} alt={alt} loading="lazy" />
			</button>
			{open && <ImageLightbox open onOpenChange={setOpen} src={src} name={alt || src} />}
		</>
	);
}

function image(key: string, src: string, alt: string) {
	return <MarkdownImage key={key} src={src} alt={alt} />;
}

function renderInline(text: string, kb: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		const k = `${kb}-${i++}`;
		if (m[1]) nodes.push(<code key={k}>{m[1]}</code>);
		else if (m[3]) nodes.push(image(k, m[3], m[2]));
		else if (m[4]) nodes.push(image(k, m[4], ""));
		else if (m[6]) nodes.push(link(k, m[6], m[5]));
		else if (m[7]) nodes.push(<strong key={k}>{m[7]}</strong>);
		else if (m[8]) nodes.push(<em key={k}>{m[8]}</em>);
		else nodes.push(link(k, m[9], m[9]));
		last = m.index + m[0].length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

/** Lines of one paragraph, each break kept as GitHub keeps it in comments. */
function renderLines(lines: string[], kb: string): ReactNode[] {
	return lines.flatMap((line, i) => [
		...(i ? [<br key={`${kb}-br${i}`} />] : []),
		...renderInline(line, `${kb}-${i}`),
	]);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function renderBlocks(md: string, kb = "b"): ReactNode[] {
	const out: ReactNode[] = [];
	let list: { ordered: boolean; items: ReactNode[] } | null = null;
	let para: string[] = [];
	let quote: string[] = [];
	let key = 0;
	const next = () => `${kb}${key++}`;
	const flushPara = () => {
		if (para.length) {
			const k = next();
			out.push(<p key={k}>{renderLines(para, k)}</p>);
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			const k = next();
			out.push(list.ordered ? <ol key={k}>{list.items}</ol> : <ul key={k}>{list.items}</ul>);
			list = null;
		}
	};
	const flushQuote = () => {
		if (quote.length) {
			const k = next();
			out.push(<blockquote key={k}>{renderBlocks(quote.join("\n"), k)}</blockquote>);
			quote = [];
		}
	};
	const flush = () => {
		flushPara();
		flushList();
		flushQuote();
	};
	const lines = md.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trimEnd();
		const fence = FENCE.exec(line)?.[1];
		const quoted = /^ {0,3}> ?(.*)$/.exec(line);
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
		const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (fence) {
			flush();
			const code: string[] = [];
			while (++i < lines.length && !lines[i].trimStart().startsWith(fence)) code.push(lines[i]);
			out.push(
				<pre key={next()}>
					<code>{code.join("\n")}</code>
				</pre>,
			);
		} else if (quoted) {
			flushPara();
			flushList();
			quote.push(quoted[1]);
		} else if (heading) {
			flush();
			const k = next();
			out.push(<h4 key={k}>{renderInline(heading[1], k)}</h4>);
		} else if (bullet || numbered) {
			flushPara();
			flushQuote();
			const ordered = !bullet;
			if (list && list.ordered !== ordered) flushList();
			list ??= { ordered, items: [] };
			const k = next();
			list.items.push(<li key={k}>{renderInline((bullet ?? numbered)![1], k)}</li>);
		} else if (line === "") {
			flush();
		} else {
			flushList();
			flushQuote();
			para.push(line);
		}
	}
	flush();
	return out;
}

/** GitHub-flavoured markdown as releases and issue threads use it: headings, lists, quotes,
 *  code, images, links, **bold** and *italic*. Raw HTML other than an image is shown as text. */
export function Markdown({ source, className }: { source: string; className?: string }) {
	return <div className={clsx("markdown", className)}>{renderBlocks(source)}</div>;
}
