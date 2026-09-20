// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { applyMapFilter } from "@/components/map-list/mapQuery";

function list() {
	const html = `<ul>
		<li data-filter-folder><ul><li data-filter-name="japan" data-filter-labels="asia"></li></ul></li>
		<li data-filter-name="france" data-filter-labels=""></li>
	</ul>`;
	return new DOMParser().parseFromString(html, "text/html").body.firstElementChild as HTMLElement;
}

describe("applyMapFilter", () => {
	it("hides every map and folder a query misses, and restores them when it clears", () => {
		const ul = list();
		applyMapFilter(ul, "zzz");
		expect(ul.querySelector<HTMLElement>("[data-filter-folder]")!.hidden).toBe(true);
		expect(ul.querySelector<HTMLElement>('[data-filter-name="france"]')!.hidden).toBe(true);

		applyMapFilter(ul, "");
		expect(ul.querySelectorAll("[hidden]")).toHaveLength(0);
	});

	it("keeps a folder whose child matches", () => {
		const ul = list();
		applyMapFilter(ul, "label:asia");
		expect(ul.querySelector<HTMLElement>("[data-filter-folder]")!.hidden).toBe(false);
	});
});
