// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act } from "react";
import { mount } from "./fixtures/harness";
import { Markdown } from "@/lib/util/markdown";

function render(source: string): HTMLElement {
	return mount(<Markdown source={source} />).container.querySelector(".markdown")!;
}

describe("markdown", () => {
	it("keeps a fenced block verbatim, markup and all", () => {
		const el = render("before\n\n```\n**not bold** [x](y)\n  indented\n```\nafter");
		expect(el.querySelector("pre code")?.textContent).toBe("**not bold** [x](y)\n  indented");
		expect(el.querySelector("strong")).toBeNull();
		expect([...el.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["before", "after"]);
	});

	it("keeps each line of a paragraph on its own line", () => {
		expect(render("one\ntwo").querySelector("p")?.innerHTML).toBe("one<br>two");
	});

	it("quotes, and renders what is inside the quote", () => {
		const el = render("> I said **this**\n> and more\n\nreply");
		expect(el.querySelector("blockquote strong")?.textContent).toBe("this");
		expect(el.querySelector("blockquote p")?.innerHTML).toContain("<br>");
		expect(el.querySelector(":scope > p")?.textContent).toBe("reply");
	});

	it("tells numbered lists from bulleted ones", () => {
		const el = render("1. first\n2. second\n\n- a\n- b");
		expect(el.querySelectorAll("ol li").length).toBe(2);
		expect(el.querySelectorAll("ul li").length).toBe(2);
	});

	it("shows images, whether written as markdown or as GitHub's own tag", () => {
		const el = render(
			'![shot](https://f/a.png)\n\n<img width="300" alt="x" src="https://github.com/user-attachments/assets/1">',
		);
		const srcs = [...el.querySelectorAll("img")].map((i) => i.getAttribute("src"));
		expect(srcs).toEqual(["https://f/a.png", "https://github.com/user-attachments/assets/1"]);
	});

	it("opens an image large when its thumbnail is clicked", async () => {
		const el = render("![shot](https://f/a.png)");
		await act(async () => (el.querySelector(".markdown__image") as HTMLElement).click());
		expect(document.querySelector(".lightbox__image")?.getAttribute("src")).toBe("https://f/a.png");
	});

	it("links bare URLs without swallowing the punctuation after them", () => {
		const a = render("see https://example.com/x.").querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com/x");
	});

	it("links and shows only web addresses", () => {
		const el = render("[x](javascript:alert(1)) ![y](file:///c/secret.png)");
		expect(el.querySelector("a, img")).toBeNull();
	});

	it("shows any other raw HTML as text", () => {
		const el = render('<script>alert(1)</script> <b onclick="x">hi</b>');
		expect(el.querySelector("script, b")).toBeNull();
		expect(el.textContent).toContain("<script>");
	});
});
