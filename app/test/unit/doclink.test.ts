// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseDoclink, doclinkedTags, matchTagsToHeadings } from "@/lib/doclink";
import { gdocProvider } from "@/lib/doclink/gdoc";
import type { Tag } from "@/bindings.gen";

const DOC_ID = "1wsa06GGiq1LEGwhkiPP0FKIZJqdAiue";

describe("parseDoclink (gdoc)", () => {
	it("parses a copy-heading-link URL", () => {
		const ref = parseDoclink(`https://docs.google.com/document/d/${DOC_ID}/edit#heading=h.abc123`);
		expect(ref).toEqual({
			provider: "gdoc",
			docId: DOC_ID,
			anchor: "h.abc123",
			url: `https://docs.google.com/document/d/${DOC_ID}/edit#heading=h.abc123`,
		});
	});

	it("parses a bookmark URL", () => {
		const ref = parseDoclink(`https://docs.google.com/document/d/${DOC_ID}/edit#bookmark=id.xyz9`);
		expect(ref?.anchor).toBe("id.xyz9");
	});

	it("parses a published-doc raw fragment", () => {
		const ref = parseDoclink(`https://docs.google.com/document/d/${DOC_ID}/pub#h.abc123`);
		expect(ref?.anchor).toBe("h.abc123");
	});

	it("parses a doc URL without anchor", () => {
		const ref = parseDoclink(`https://docs.google.com/document/d/${DOC_ID}/edit`);
		expect(ref?.docId).toBe(DOC_ID);
		expect(ref?.anchor).toBeNull();
	});

	it("handles /u/0/ paths", () => {
		const ref = parseDoclink(`https://docs.google.com/document/u/0/d/${DOC_ID}/edit`);
		expect(ref?.docId).toBe(DOC_ID);
	});

	it("rejects non-docs URLs", () => {
		expect(parseDoclink("https://example.com/document/d/abc/edit")).toBeNull();
		expect(parseDoclink("https://docs.google.com/spreadsheets/d/abc/edit")).toBeNull();
		expect(parseDoclink("not a url")).toBeNull();
	});
});

const FIXTURE = `<html><head><title>Test Meta Doc</title>
<style>.c1{font-weight:700}</style></head><body>
<h1 id="h.intro">Intro</h1><p>intro text</p>
<h2 id="h.antenna">A-type antennas</h2>
<p class="c1">antenna text</p>
<p><a id="id.bkmk"></a>bookmarked paragraph</p>
<h3 id="h.sub">Subsection</h3><p>sub text</p>
<h2 id="h.pole">Poles</h2><p>pole text</p>
<script>evil()</script>
</body></html>`;

function refWith(anchor: string | null) {
	return { provider: "gdoc", docId: "d1", anchor, url: "u" };
}

describe("gdoc outline", () => {
	it("lists linkable headings with anchor, text, and level", () => {
		const o = gdocProvider.outline(FIXTURE);
		expect(o.title).toBe("Test Meta Doc");
		expect(o.headings).toEqual([
			{ anchor: "h.intro", text: "Intro", level: 1 },
			{ anchor: "h.antenna", text: "A-type antennas", level: 2 },
			{ anchor: "h.sub", text: "Subsection", level: 3 },
			{ anchor: "h.pole", text: "Poles", level: 2 },
		]);
	});

	it("skips headings without a Google-minted id", () => {
		const o = gdocProvider.outline(`<html><body><h1>No id</h1><h2 id="h.x">X</h2></body></html>`);
		expect(o.headings).toEqual([{ anchor: "h.x", text: "X", level: 2 }]);
	});
});

describe("gdoc extract", () => {
	it("extracts a heading section including deeper subsections, stopping at the same level", () => {
		const s = gdocProvider.extract(FIXTURE, refWith("h.antenna"));
		expect(s.anchorFound).toBe(true);
		expect(s.html).toContain("A-type antennas");
		expect(s.html).toContain("antenna text");
		expect(s.html).toContain("Subsection");
		expect(s.html).toContain("sub text");
		expect(s.html).not.toContain("Poles");
		expect(s.html).not.toContain("intro text");
	});

	it("extracts a bookmark's block up to the next heading", () => {
		const s = gdocProvider.extract(FIXTURE, refWith("id.bkmk"));
		expect(s.anchorFound).toBe(true);
		expect(s.html).toContain("bookmarked paragraph");
		expect(s.html).not.toContain("Subsection");
	});

	it("returns the whole body without an anchor", () => {
		const s = gdocProvider.extract(FIXTURE, refWith(null));
		expect(s.html).toContain("intro text");
		expect(s.html).toContain("pole text");
	});

	it("stamps heading anchors onto IR blocks (whole-doc scroll target)", () => {
		const s = gdocProvider.extract(FIXTURE, refWith(null));
		const anchors = (s.blocks ?? []).filter((b) => b.kind === "heading").map((b) => b.anchor);
		expect(anchors).toEqual(["h.intro", "h.antenna", "h.sub", "h.pole"]);
	});

	it("reports a missing anchor", () => {
		const s = gdocProvider.extract(FIXTURE, refWith("h.gone"));
		expect(s.anchorFound).toBe(false);
		expect(s.html).toBe("");
	});

	it("collects doc css and title", () => {
		const s = gdocProvider.extract(FIXTURE, refWith("h.antenna"));
		expect(s.css).toContain("font-weight:700");
		expect(s.docTitle).toBe("Test Meta Doc");
	});

	it("handles the mobilebasic .doc-content wrapper", () => {
		const html = `<html><head><title>M</title></head><body><div class="doc-header">chrome</div><div class="doc-content"><h2 id="h.a">Section A</h2><p>a text</p><h2 id="h.b">Section B</h2><p>b text</p></div></body></html>`;
		const s = gdocProvider.extract(html, refWith("h.a"));
		expect(s.anchorFound).toBe(true);
		expect(s.html).toContain("a text");
		expect(s.html).not.toContain("b text");
		const whole = gdocProvider.extract(html, refWith(null));
		expect(whole.html).toContain("b text");
		expect(whole.html).not.toContain("chrome");
	});

	it("strips scripts and unwraps google redirect links", () => {
		const html = `<html><body><h1 id="h.a">A</h1><p><script>x()</script><a onclick="x()" href="https://www.google.com/url?q=https://example.com/page&sa=D">link</a></p></body></html>`;
		const s = gdocProvider.extract(html, refWith("h.a"));
		expect(s.html).not.toContain("<script>");
		expect(s.html).not.toContain("onclick");
		expect(s.html).toContain('href="https://example.com/page"');
	});

	it("marks remote images crossorigin so CORP: same-site responses load", () => {
		const html = `<html><body><h1 id="h.a">A</h1><p><img src="https://docs.google.com/docs-images-rt/xyz=s800"><img src="data:image/png;base64,AAAA"></p></body></html>`;
		const s = gdocProvider.extract(html, refWith("h.a"));
		expect(s.html).toContain('crossorigin="anonymous"');
		expect(s.html.match(/crossorigin/g)).toHaveLength(1);
	});
});

describe("gdoc IR conversion", () => {
	const extract = (html: string, anchor: string | null = "h.a") =>
		gdocProvider.extract(html, refWith(anchor));

	it("converts class-styled text (export variant) into marks", () => {
		const html = `<html><head><style>.b{font-weight:700}.i{font-style:italic}.red{color:#ff0000}.hl{background-color:#ffff00}</style></head><body>
			<h2 id="h.a">Title</h2>
			<p><span class="b">bold</span><span class="i">ital</span><span class="red hl">warn</span><span>plain</span></p>
		</body></html>`;
		const blocks = extract(html).blocks!;
		expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
		const p = blocks[1] as Extract<(typeof blocks)[1], { kind: "paragraph" }>;
		expect(p.spans).toEqual([
			{ text: "bold", marks: { bold: true } },
			{ text: "ital", marks: { italic: true } },
			{ text: "warn", marks: { color: "#ff0000", highlight: "#ffff00" } },
			{ text: "plain", marks: undefined },
		]);
	});

	it("converts inline-styled text (mobilebasic variant) into marks", () => {
		const html = `<html><body><div class="doc-content">
			<h2 id="h.a">T</h2>
			<p><span style="font-weight:700;text-decoration:underline">x</span><span style="font-weight:400">y</span></p>
		</div></body></html>`;
		const blocks = extract(html).blocks!;
		const p = blocks[1] as { kind: "paragraph"; spans: { text: string; marks?: object }[] };
		expect(p.spans[0].marks).toEqual({ bold: true, underline: true });
		expect(p.spans[1].marks).toBeUndefined();
	});

	it("drops near-black colors and white backgrounds", () => {
		const html = `<html><body>
			<h2 id="h.a">T</h2>
			<p><span style="color:#000000;background-color:#ffffff">a</span><span style="color:#434343">b</span></p>
		</body></html>`;
		const blocks = extract(html).blocks!;
		const p = blocks[1] as { spans: { marks?: object }[] };
		expect(p.spans[0].marks).toBeUndefined();
		expect(p.spans[1].marks).toBeUndefined();
	});

	it("extracts images as blocks and skips empty spacer paragraphs", () => {
		const html = `<html><body>
			<h2 id="h.a">T</h2>
			<p><span></span></p>
			<p><span><img src="https://docs.google.com/docs-images-rt/x=s800"></span></p>
		</body></html>`;
		const blocks = extract(html).blocks!;
		expect(blocks.map((b) => b.kind)).toEqual(["heading", "image"]);
	});

	it("merges flat sibling lists and reads nesting depth", () => {
		const html = `<html><head><style></style></head><body>
			<h2 id="h.a">T</h2>
			<ul class="lst-kix_abc-0 start"><li>top</li></ul>
			<ul class="lst-kix_abc-1"><li>nested</li></ul>
		</body></html>`;
		const blocks = extract(html).blocks!;
		const list = blocks[1] as { kind: "list"; items: { depth: number }[] };
		expect(list.kind).toBe("list");
		expect(list.items.map((i) => i.depth)).toEqual([0, 1]);
	});

	it("emits a placeholder for tables (deferred)", () => {
		const html = `<html><body><h2 id="h.a">T</h2><table><tr><td>cell</td></tr></table></body></html>`;
		const blocks = extract(html).blocks!;
		expect(blocks[1].kind).toBe("placeholder");
	});

	it("drops the doc's link color so app link styling wins", () => {
		const html = `<html><body><h2 id="h.a">T</h2>
			<p><a href="https://example.com"><span style="color:#1155cc;text-decoration:underline">link</span></a></p>
		</body></html>`;
		const blocks = extract(html).blocks!;
		const p = blocks[1] as { spans: { marks?: { link?: string; color?: string } }[] };
		expect(p.spans[0].marks?.link).toBe("https://example.com");
		expect(p.spans[0].marks?.color).toBeUndefined();
	});

	it("resolves in-doc and redirect-wrapped links to absolute URLs", () => {
		const html = `<html><body><h2 id="h.a">T</h2>
			<p><a href="#heading=h.other">jump</a><a href="https://www.google.com/url?q=https://example.com/x&sa=D">out</a></p>
		</body></html>`;
		const blocks = extract(html).blocks!;
		const p = blocks[1] as { spans: { marks?: { link?: string } }[] };
		expect(p.spans[0].marks?.link).toBe(
			"https://docs.google.com/document/d/d1/edit#heading=h.other",
		);
		expect(p.spans[1].marks?.link).toBe("https://example.com/x");
	});
});

describe("doclinkedTags", () => {
	const tag = (id: number, doclinks?: string[]): Tag => ({
		id,
		name: `t${id}`,
		color: "#fff",
		visible: true,
		order: null,
		count: 0,
		doclinks,
	});

	it("filters tags with non-empty doclinks", () => {
		const tags = {
			"1": tag(1, ["https://docs.google.com/document/d/x/edit"]),
			"2": tag(2, []),
			"3": tag(3),
		};
		expect(doclinkedTags(tags).map((t) => t.id)).toEqual([1]);
	});
});

describe("matchTagsToHeadings", () => {
	const tag = (id: number, name: string, doclinks: string[] = []): Tag => ({
		id,
		name,
		color: "#fff",
		visible: true,
		order: null,
		count: 0,
		doclinks,
	});
	const h = (anchor: string, text: string) => ({ anchor, text, level: 2 });
	const pairs = (tags: Tag[], headings: { anchor: string; text: string; level: number }[]) =>
		matchTagsToHeadings(tags, headings, "d1").map((m) => `${m.tag.name}->${m.heading.anchor}`);

	it("proposes exact name matches, normalized for case, spacing, and diacritics", () => {
		const tags = [tag(1, "A-type antennas"), tag(2, "Śląsk"), tag(3, "Unrelated")];
		const headings = [h("h.a", "  a-type  ANTENNAS "), h("h.b", "Slask"), h("h.c", "Nothing")];
		expect(pairs(tags, headings)).toEqual(["A-type antennas->h.a", "Śląsk->h.b"]);
	});

	it("matches the leaf segment of hierarchical tag names", () => {
		expect(pairs([tag(1, "Poland/Bollard")], [h("h.a", "Bollard")])).toEqual([
			"Poland/Bollard->h.a",
		]);
	});

	it("skips ambiguous leaves and prefers a full-name match over leaves", () => {
		const ambiguous = [tag(1, "Poland/Bollard"), tag(2, "Czechia/Bollard")];
		expect(pairs(ambiguous, [h("h.a", "Bollard")])).toEqual([]);
		const withFull = [tag(1, "Bollard"), tag(2, "Poland/Bollard")];
		expect(pairs(withFull, [h("h.a", "Bollard")])).toEqual(["Bollard->h.a"]);
	});

	it("skips pairs already assigned in this doc", () => {
		const linked = tag(1, "Antenna", ["https://docs.google.com/document/d/d1/edit#heading=h.a"]);
		expect(pairs([linked], [h("h.a", "Antenna"), h("h.b", "Antenna")])).toEqual(["Antenna->h.b"]);
	});

	it("ignores links to other docs when deciding what is assigned", () => {
		const linked = tag(1, "Antenna", ["https://docs.google.com/document/d/OTHER/edit#heading=h.a"]);
		expect(pairs([linked], [h("h.a", "Antenna")])).toEqual(["Antenna->h.a"]);
	});
});
