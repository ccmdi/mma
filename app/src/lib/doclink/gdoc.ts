import { schemeBase } from "@/lib/util/util";
import { msg } from "@/lib/i18n";
import type {
	DocBlock,
	DocListItem,
	DocProvider,
	DocRef,
	DocSection,
	InlineMarks,
	InlineSpan,
} from "@/lib/doclink";

const DOC_PATH = /\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/;

function parseAnchor(hash: string): string | null {
	const h = hash.replace(/^#/, "");
	const kv = h.match(/^(?:heading|bookmark)=((?:h|id)\.[A-Za-z0-9_-]+)$/);
	if (kv) return kv[1];
	if (/^(?:h|id)\.[A-Za-z0-9_-]+$/.test(h)) return h;
	return null;
}

function isHeading(el: Element): boolean {
	return /^H[1-6]$/.test(el.tagName);
}

function headingLevel(el: Element): number {
	return Number(el.tagName[1]);
}

/** The direct child of `container` holding `el` (bookmark anchors sit inside paragraphs). */
function topLevelBlock(el: Element, container: Element): Element | null {
	let cur: Element | null = el;
	while (cur && cur.parentElement !== container) cur = cur.parentElement;
	return cur;
}

function sanitize(el: Element) {
	el.querySelectorAll("script,iframe,object,embed,link,meta").forEach((n) => n.remove());
	const all = [el, ...el.querySelectorAll("*")];
	for (const node of all) {
		for (const attr of [...node.attributes]) {
			if (attr.name.startsWith("on")) node.removeAttribute(attr.name);
			if (attr.name === "href" && attr.value.trim().toLowerCase().startsWith("javascript:")) {
				node.removeAttribute(attr.name);
			}
		}
		// Export HTML wraps every link in a google.com/url?q=... redirect.
		const href = node.getAttribute("href");
		if (href?.startsWith("https://www.google.com/url?")) {
			const q = URL.parse(href)?.searchParams.get("q");
			if (q) node.setAttribute("href", q);
		}
		// mobilebasic images send CORP: same-site, which blocks plain cross-origin
		// <img> loads; they also send ACAO: *, so a CORS-mode load is permitted.
		if (node.tagName === "IMG" && node.getAttribute("src")?.startsWith("http")) {
			node.setAttribute("crossorigin", "anonymous");
		}
	}
}

/** Collect the section starting at the anchor's block: a heading runs until the
 *  next heading of the same or higher level, any other block until any heading. */
function collectSection(start: Element): Element[] {
	const out: Element[] = [start];
	const stopLevel = isHeading(start) ? headingLevel(start) : 7;
	for (let sib = start.nextElementSibling; sib; sib = sib.nextElementSibling) {
		if (isHeading(sib) && headingLevel(sib) <= stopLevel) break;
		out.push(sib);
	}
	return out;
}

// --- HTML -> IR conversion ---
// The export variant styles text via generated classes (`.c5{font-weight:700}`);
// mobilebasic puts the same declarations inline on each element. Both funnel
// through the same declaration parser.

type StyleProps = InlineMarks & { align?: "center" | "right" };

/** Near-black text is the doc's "default" color; drop it so themed text stays readable. */
function isDefaultColor(v: string): boolean {
	const hex = v.match(/^#([0-9a-f]{6})$/i);
	if (hex) {
		const n = parseInt(hex[1], 16);
		return Math.max((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff) < 0x60;
	}
	const rgb = v.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
	if (rgb) return Math.max(+rgb[1], +rgb[2], +rgb[3]) < 0x60;
	return !v.startsWith("#") && !v.startsWith("rgb");
}

function parseDecls(text: string | null): StyleProps {
	const out: StyleProps = {};
	if (!text) return out;
	for (const decl of text.split(";")) {
		const i = decl.indexOf(":");
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const value = decl
			.slice(i + 1)
			.trim()
			.toLowerCase();
		switch (prop) {
			case "font-weight":
				out.bold = value === "bold" || Number(value) >= 600;
				break;
			case "font-style":
				out.italic = value === "italic";
				break;
			case "text-decoration":
			case "text-decoration-line":
				out.underline = value.includes("underline");
				out.strike = value.includes("line-through");
				break;
			case "color":
				if (!isDefaultColor(value)) out.color = value;
				break;
			case "background-color":
				if (!["#ffffff", "#fff", "white", "transparent", "inherit"].includes(value)) {
					out.highlight = value;
				}
				break;
			case "vertical-align":
				if (value === "super") out.sup = true;
				if (value === "sub") out.sub = true;
				break;
			case "text-align":
				if (value === "center" || value === "right") out.align = value;
				break;
		}
	}
	return out;
}

/** `.c5{...}` / `p.c5{...}` single-class rules from the doc's stylesheet. */
function parseClassRules(cssText: string): Map<string, StyleProps> {
	const rules = new Map<string, StyleProps>();
	for (const m of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		let props: StyleProps | null = null;
		for (const sel of m[1].split(",")) {
			const cm = sel.trim().match(/^[a-z0-9]*\.([\w-]+)$/i);
			if (!cm) continue;
			props ??= parseDecls(m[2]);
			if (Object.keys(props).length === 0) break;
			rules.set(cm[1], { ...(rules.get(cm[1]) ?? {}), ...props });
		}
	}
	return rules;
}

function styleOf(el: Element, rules: Map<string, StyleProps>): StyleProps {
	let props: StyleProps = {};
	for (const cls of el.classList) {
		const r = rules.get(cls);
		if (r) props = { ...props, ...r };
	}
	return { ...props, ...parseDecls(el.getAttribute("style")) };
}

const TAG_MARKS: Record<string, InlineMarks> = {
	B: { bold: true },
	STRONG: { bold: true },
	I: { italic: true },
	EM: { italic: true },
	U: { underline: true },
	S: { strike: true },
	STRIKE: { strike: true },
	DEL: { strike: true },
	SUP: { sup: true },
	SUB: { sub: true },
};

function resolveHref(href: string | null, ref: DocRef): string | undefined {
	if (!href) return undefined;
	const raw = href.trim();
	if (raw.toLowerCase().startsWith("javascript:")) return undefined;
	// In-doc links stay relative in the source HTML.
	if (raw.startsWith("#")) {
		return `https://docs.google.com/document/d/${ref.docId}/edit${raw}`;
	}
	if (raw.startsWith("https://www.google.com/url?")) {
		return URL.parse(raw)?.searchParams.get("q") ?? raw;
	}
	return raw;
}

const MARK_KEYS: (keyof InlineMarks)[] = [
	"bold",
	"italic",
	"underline",
	"strike",
	"sup",
	"sub",
	"color",
	"highlight",
	"link",
];

function cleanMarks(props: StyleProps): InlineMarks | undefined {
	let marks: InlineMarks | undefined;
	for (const key of MARK_KEYS) {
		// Links keep the app's link styling, not the doc's blue.
		if (key === "color" && props.link) continue;
		const v = props[key];
		if (v) {
			marks ??= {};
			(marks[key] as typeof v) = v;
		}
	}
	return marks;
}

function collectSpans(
	el: Element,
	rules: Map<string, StyleProps>,
	ref: DocRef,
	inherited: StyleProps,
	out: InlineSpan[],
) {
	for (const node of el.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? "";
			if (text) out.push({ text, marks: cleanMarks(inherited) });
			continue;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) continue;
		const child = node as Element;
		const tag = child.tagName;
		if (tag === "IMG" || tag === "SCRIPT" || tag === "STYLE") continue;
		if (tag === "BR") {
			out.push({ text: "\n", marks: cleanMarks(inherited) });
			continue;
		}
		const marks: StyleProps = { ...inherited, ...TAG_MARKS[tag], ...styleOf(child, rules) };
		if (tag === "A") {
			const link = resolveHref(child.getAttribute("href"), ref);
			if (link) marks.link = link;
		}
		collectSpans(child, rules, ref, marks, out);
	}
}

function spansText(spans: InlineSpan[]): string {
	return spans.map((s) => s.text).join("");
}

function imageBlocks(el: Element): DocBlock[] {
	return [...el.querySelectorAll("img")]
		.map((img) => img.getAttribute("src") ?? "")
		.filter((src) => /^(https?:|data:image\/)/.test(src))
		.map((src) => ({ kind: "image" as const, src, alt: "" }));
}

/** Nesting depth: export encodes it as a `lst-kix_*-N` class suffix on the list,
 *  mobilebasic as 36pt-per-level left margins on the items. */
function listItemDepth(list: Element, li: Element): number {
	const cls = list.className.match(/-(\d+)(?:\s|$)/);
	if (cls) return Number(cls[1]);
	const m = li.getAttribute("style")?.match(/margin-left:\s*([\d.]+)pt/);
	return m ? Math.max(0, Math.round(Number(m[1]) / 36) - 1) : 0;
}

function convertElement(el: Element, rules: Map<string, StyleProps>, ref: DocRef, out: DocBlock[]) {
	const tag = el.tagName;
	if (tag === "SCRIPT" || tag === "STYLE") return;
	if (isHeading(el)) {
		const spans: InlineSpan[] = [];
		collectSpans(el, rules, ref, styleOf(el, rules), spans);
		if (spansText(spans).trim()) {
			out.push({ kind: "heading", level: headingLevel(el), spans, anchor: el.id || undefined });
		}
		out.push(...imageBlocks(el));
		return;
	}
	if (tag === "P") {
		const style = styleOf(el, rules);
		const spans: InlineSpan[] = [];
		collectSpans(el, rules, ref, style, spans);
		// Google emits empty spacer paragraphs; keep only real content.
		if (spansText(spans).trim()) {
			out.push({ kind: "paragraph", align: style.align, spans });
		}
		out.push(...imageBlocks(el));
		return;
	}
	if (tag === "UL" || tag === "OL") {
		const items: DocListItem[] = [];
		const images: DocBlock[] = [];
		for (const li of el.children) {
			if (li.tagName !== "LI") continue;
			const spans: InlineSpan[] = [];
			collectSpans(li, rules, ref, styleOf(li, rules), spans);
			if (spansText(spans).trim()) items.push({ depth: listItemDepth(el, li), spans });
			images.push(...imageBlocks(li));
		}
		if (items.length) out.push({ kind: "list", ordered: tag === "OL", items });
		out.push(...images);
		return;
	}
	if (tag === "TABLE") {
		// Tables are not converted to the IR yet (deferred); the placeholder points
		// users at the original doc for now.
		out.push({ kind: "placeholder", note: msg("Table omitted - open the doc to view it.") });
		return;
	}
	if (tag === "HR") {
		out.push({ kind: "hr" });
		return;
	}
	// Wrapper (div etc.): recurse.
	for (const child of el.children) convertElement(child, rules, ref, out);
}

/** Merge sibling lists (source HTML emits one flat list element per depth run). */
function mergeAdjacentLists(blocks: DocBlock[]): DocBlock[] {
	const out: DocBlock[] = [];
	for (const b of blocks) {
		const prev = out.at(-1);
		if (b.kind === "list" && prev?.kind === "list" && prev.ordered === b.ordered) {
			prev.items.push(...b.items);
		} else {
			out.push(b);
		}
	}
	return out;
}

function convertBlocks(blocks: Element[], cssText: string, ref: DocRef): DocBlock[] {
	const rules = parseClassRules(cssText);
	const out: DocBlock[] = [];
	for (const el of blocks) convertElement(el, rules, ref, out);
	return mergeAdjacentLists(out);
}

export const gdocProvider: DocProvider = {
	id: "gdoc",

	match(url: string): DocRef | null {
		const u = URL.parse(url);
		if (!u || u.hostname !== "docs.google.com") return null;
		const m = u.pathname.match(DOC_PATH);
		if (!m) return null;
		return { provider: "gdoc", docId: m[1], anchor: parseAnchor(u.hash), url };
	},

	async fetchHtml(ref: DocRef): Promise<string> {
		const res = await fetch(`${schemeBase("gdoc")}${ref.docId}`);
		if (!res.ok) throw new Error(`Document fetch failed (${res.status})`);
		return res.text();
	},

	outline(html: string) {
		const doc = new DOMParser().parseFromString(html, "text/html");
		const title = doc.querySelector("title")?.textContent?.trim() || null;
		const container = doc.querySelector(".doc-content") ?? doc.body;
		// Only headings with a Google-minted id are linkable.
		const headings = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")]
			.filter((h) => h.id)
			.map((h) => ({
				anchor: h.id,
				text: h.textContent?.trim() ?? "",
				level: Number(h.tagName[1]),
			}))
			.filter((h) => h.text);
		return { title, headings };
	},

	extract(html: string, ref: DocRef): DocSection {
		const doc = new DOMParser().parseFromString(html, "text/html");
		const css = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
		const docTitle = doc.querySelector("title")?.textContent?.trim() || null;
		// export?format=html puts blocks directly in body; mobilebasic nests them
		// under a .doc-content wrapper.
		const container = doc.querySelector(".doc-content") ?? doc.body;

		let blocks: Element[];
		if (ref.anchor) {
			const el = doc.getElementById(ref.anchor);
			const start = el && topLevelBlock(el, container);
			if (!start) {
				return { docTitle, css, html: "", anchorFound: false, blocks: null };
			}
			blocks = collectSection(start);
		} else {
			blocks = [...container.children];
		}

		let ir: DocBlock[] | null;
		try {
			ir = convertBlocks(blocks, css, ref);
		} catch {
			ir = null; // renderer falls back to the raw-HTML shadow path
		}

		const parts = blocks.map((b) => {
			const clone = b.cloneNode(true) as Element;
			sanitize(clone);
			return clone.outerHTML;
		});
		return { docTitle, css, html: parts.join(""), anchorFound: true, blocks: ir };
	},
};
