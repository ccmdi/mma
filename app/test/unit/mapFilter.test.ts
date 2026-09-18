// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { applyMapFilter } from "@/components/map-list/mapQuery";

function list() {
	const html = `<ul>
		<li data-filter-folder><ul><li data-filter-name="japan" data-filter-labels="asia"></li></ul></li>
		<li data-filter-name="france" data-filter-labels=""></li>
		<li data-filter-no-match hidden></li>
	</ul>`;
	return new DOMParser().parseFromString(html, "text/html").body.firstElementChild as HTMLElement;
}

const noMatch = (ul: HTMLElement) => ul.querySelector<HTMLElement>("[data-filter-no-match]")!;

describe("applyMapFilter", () => {
	it("shows the no-match row only while a query hides every map", () => {
		const ul = list();
		applyMapFilter(ul, "fra");
		expect(noMatch(ul).hidden).toBe(true);

		applyMapFilter(ul, "zzz");
		expect(noMatch(ul).hidden).toBe(false);
		expect(ul.querySelector<HTMLElement>("[data-filter-folder]")!.hidden).toBe(true);

		applyMapFilter(ul, "");
		expect(noMatch(ul).hidden).toBe(true);
		expect(ul.querySelectorAll("[hidden]")).toHaveLength(1);
	});

	it("counts a match inside a folder", () => {
		const ul = list();
		applyMapFilter(ul, "label:asia");
		expect(noMatch(ul).hidden).toBe(true);
	});
});
