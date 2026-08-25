import type { Tag } from "@/bindings.gen";
import { gdocProvider } from "@/lib/doclink/gdoc";

/** A parsed doclink: which provider, which document, where inside it. */
export interface DocRef {
	provider: string;
	docId: string;
	anchor: string | null;
	/** The original URL, for opening externally. */
	url: string;
}

// --- Intermediate representation ---
// Providers parse their source format into these blocks; one native renderer
// (DocRenderer) displays them in the app's own theme. Tables are NOT part of
// the IR yet -- providers emit a `placeholder` block for them (deferred).

export interface InlineMarks {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	sup?: boolean;
	sub?: boolean;
	/** Text color from the source doc; dark/near-black colors are dropped by
	 *  providers so themed text stays readable. */
	color?: string;
	highlight?: string;
	link?: string;
}

export interface InlineSpan {
	text: string;
	marks?: InlineMarks;
}

/** Source docs encode list nesting as flat sibling lists; depth preserves it. */
export interface DocListItem {
	depth: number;
	spans: InlineSpan[];
}

export type DocBlock =
	| { kind: "heading"; level: number; spans: InlineSpan[]; anchor?: string }
	| { kind: "paragraph"; align?: "center" | "right"; spans: InlineSpan[] }
	| { kind: "list"; ordered: boolean; items: DocListItem[] }
	| { kind: "image"; src: string; alt: string; width?: number; height?: number }
	| { kind: "hr" }
	| { kind: "placeholder"; note: string };

/** A rendered slice of a document, ready for display. */
export interface DocSection {
	docTitle: string | null;
	/** The document's own stylesheet, for the raw-HTML fallback path. */
	css: string;
	html: string;
	/** False when the linked anchor no longer exists in the document. */
	anchorFound: boolean;
	/** Native-renderer blocks; null when conversion failed (fall back to raw HTML). */
	blocks: DocBlock[] | null;
}

/** One linkable heading in a document (the authoring unit). */
export interface DocHeading {
	anchor: string;
	text: string;
	level: number;
}

export interface DocOutline {
	title: string | null;
	headings: DocHeading[];
}

export interface DocProvider {
	id: string;
	match(url: string): DocRef | null;
	fetchHtml(ref: DocRef): Promise<string>;
	extract(html: string, ref: DocRef): DocSection;
	outline(html: string): DocOutline;
}

const providers: DocProvider[] = [gdocProvider];

export function parseDoclink(url: string): DocRef | null {
	for (const p of providers) {
		const ref = p.match(url);
		if (ref) return ref;
	}
	return null;
}

// Raw HTML cached per document for the session; sections re-extract per anchor.
const htmlCache = new Map<string, Promise<string>>();

function fetchDocHtml(provider: DocProvider, ref: DocRef): Promise<string> {
	const key = `${ref.provider}:${ref.docId}`;
	let html = htmlCache.get(key);
	if (!html) {
		html = provider.fetchHtml(ref);
		htmlCache.set(key, html);
		html.catch(() => htmlCache.delete(key));
	}
	return html;
}

function providerFor(ref: DocRef): DocProvider {
	const provider = providers.find((p) => p.id === ref.provider);
	if (!provider) throw new Error(`Unknown doclink provider: ${ref.provider}`);
	return provider;
}

export async function loadSection(ref: DocRef): Promise<DocSection> {
	const provider = providerFor(ref);
	return provider.extract(await fetchDocHtml(provider, ref), ref);
}

/** The document's heading tree, for the assignment UI. */
export async function loadOutline(ref: DocRef): Promise<DocOutline> {
	const provider = providerFor(ref);
	return provider.outline(await fetchDocHtml(provider, ref));
}

/** Drop a doc's cached HTML so the next loadSection re-fetches it. */
export function evictDoc(ref: DocRef): void {
	htmlCache.delete(`${ref.provider}:${ref.docId}`);
}

/** Warm the HTML cache for every doclinked doc in the map (fired on map open),
 *  so the panel is instant by the time a tag is selected. */
export function prefetchDoclinks(tags: Record<string, Tag>): void {
	for (const tag of doclinkedTags(tags)) {
		for (const url of tag.doclinks ?? []) {
			const ref = parseDoclink(url);
			if (ref) loadSection(ref).catch(() => {});
		}
	}
}

export function doclinkedTags(tags: Record<string, Tag>): Tag[] {
	return Object.values(tags).filter((t) => (t.doclinks?.length ?? 0) > 0);
}

/** Anchors a tag's doclinks point at, within the given doc only. */
export function anchorsInDoc(tag: Tag, docId: string): Set<string> {
	const out = new Set<string>();
	for (const url of tag.doclinks ?? []) {
		const ref = parseDoclink(url);
		if (ref?.docId === docId && ref.anchor) out.add(ref.anchor);
	}
	return out;
}

export interface DoclinkMatch {
	tag: Tag;
	heading: DocHeading;
}

const normName = (s: string) =>
	s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Propose (tag, heading) links by name: exact normalized full-name matches, plus
 *  leaf-segment matches ("Poland/Bollard" -> heading "Bollard") when exactly one
 *  tag carries that leaf. Pairs already assigned in this doc are skipped. */
export function matchTagsToHeadings(
	tags: Tag[],
	headings: DocHeading[],
	docId: string,
): DoclinkMatch[] {
	const byFull = new Map<string, Tag[]>();
	const byLeaf = new Map<string, Tag[]>();
	for (const tag of tags) {
		const full = normName(tag.name);
		if (!full) continue;
		byFull.set(full, [...(byFull.get(full) ?? []), tag]);
		const leaf = normName(tag.name.split("/").at(-1) ?? "");
		if (leaf && leaf !== full) byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), tag]);
	}
	const out: DoclinkMatch[] = [];
	for (const heading of headings) {
		const key = normName(heading.text);
		if (!key) continue;
		let candidates = byFull.get(key) ?? [];
		if (candidates.length === 0) {
			const leaves = byLeaf.get(key) ?? [];
			if (leaves.length === 1) candidates = leaves;
		}
		for (const tag of candidates) {
			if (!anchorsInDoc(tag, docId).has(heading.anchor)) out.push({ tag, heading });
		}
	}
	return out;
}

// A section isn't "loaded" until its images are fetched and decoded -- otherwise
// they trickle in after display and shift the layout. Capped so a dead image
// can't hold the panel hostage.
const IMAGE_PRELOAD_TIMEOUT_MS = 12_000;

function sectionImageSrcs(section: DocSection): string[] {
	if (section.blocks) {
		return section.blocks.filter((b) => b.kind === "image").map((b) => b.src);
	}
	return [...section.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
}

export async function preloadSectionImages(section: DocSection): Promise<DocSection> {
	const srcs = sectionImageSrcs(section);
	if (srcs.length === 0) return section;
	const dims = new Map<string, { width: number; height: number }>();
	const loads = srcs.map(
		(src) =>
			new Promise<void>((resolve) => {
				const img = new Image();
				// Must match the <img crossorigin> the renderer emits, or the cache entry is unusable.
				img.crossOrigin = "anonymous";
				img.src = src;
				img.decode().then(
					() => {
						if (img.naturalWidth) {
							dims.set(src, { width: img.naturalWidth, height: img.naturalHeight });
						}
						resolve();
					},
					() => resolve(),
				);
			}),
	);
	await Promise.race([
		Promise.all(loads),
		new Promise<void>((resolve) => setTimeout(resolve, IMAGE_PRELOAD_TIMEOUT_MS)),
	]);
	// Stamp intrinsic dimensions onto the blocks so the renderer reserves the
	// right space at first layout -- images can't shift content as they paint.
	for (const b of section.blocks ?? []) {
		if (b.kind === "image") {
			const d = dims.get(b.src);
			if (d) {
				b.width = d.width;
				b.height = d.height;
			}
		}
	}
	return section;
}
